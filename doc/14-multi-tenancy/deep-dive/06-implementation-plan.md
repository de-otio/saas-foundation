# 06 — Implementation plan (RLS-first)

The plan to implement the recommendation from this deep dive: **pool model with
PostgreSQL RLS as the database-enforced isolation boundary.** This **supersedes**
the earlier extension-first plan at `../06-implementation-plan.md`.

Leading principle: **the boundary is the database.** Phases are ordered so RLS —
the actual guarantee — leads. The application-level Prisma extension (PR #21) is
kept only as ergonomics and is the *last* phase, explicitly subordinate.

Each phase is independently shippable and verifiable. Phases that touch the data
model, DB roles, or a live database are marked **[needs DB]** / **[needs infra]**
/ **[needs sign-off]** — those don't start without an explicit go-ahead.

```
P0 spike ─► P1 schema ─► P2 DB roles ─► P3 tenant-tx wrapper ─► P4 enable RLS ─► P5 verify
   ✅           ✅         (infra)        ✅ built, not wired       (needs DB)     (needs DB)
                                                                  P6 extension (ergonomics) ┘
```

---

## P0 — De-risk the mechanism on a throwaway Postgres  [needs DB]  ✅ DONE

> **Complete (2026-05-31). 7/7 checks passed on real RDS PostgreSQL 16.9.** See
> [07-spike-results.md](07-spike-results.md). The throwaway DB was deployed +
> destroyed via a CDK app (profile `dot-dev`); nothing persists. The core
> mechanism has no remaining unknowns — proceed to P1.

Prove the whole mechanism end-to-end on a disposable database **before touching
trellis**. This is the only "unknown" and it's cheap to settle empirically.

Tasks:
- Stand up a throwaway PostgreSQL (matching the prod major version).
- Create two roles: `app_rw` (NOSUPERUSER, **NOBYPASSRLS**) and `migrator`
  (owns the schema, runs DDL).
- Create a `posts`-like table with `tenant_id text not null`, seed two tenants.
- Apply the policy template (below) with `ENABLE` + `FORCE ROW LEVEL SECURITY`.
- As `app_rw`, in a transaction that first runs
  `select set_config('app.current_tenant', $tid, true)`, assert:
  1. `SELECT * FROM posts` returns **only** the active tenant's rows.
  2. `SELECT * FROM posts WHERE id = '<other-tenant-row>'` (primary-key lookup)
     returns **nothing**.
  3. `$queryRaw`-style raw SQL is **also** filtered.
  4. `INSERT ... (tenant_id => other_tenant)` is **rejected** by `WITH CHECK`.
  5. With **no** `app.current_tenant` set, queries return **0 rows** / error
     (fail-closed), never all rows.
- Benchmark a tenant-scoped query with and without a `(tenant_id, …)` index;
  confirm the policy predicate uses the index (EXPLAIN).
- (If a pooler is in scope) repeat 1–5 behind **PgBouncer in transaction mode**
  to confirm `SET LOCAL`/`set_config(...,true)` does not leak across pooled
  connections; confirm session-level `SET` *does* leak (so we never use it).

**Exit criteria:** a short spike note with the validated SQL, the connection/
transaction pattern, and the EXPLAIN/benchmark. This converts "RLS is the plan"
into "RLS is proven for our shapes." Findings 1/2/9 from the PR-21 review
(unique-id, raw SQL, by-relation) must each be shown closed by RLS here.

Policy + role template (the artifact P4 rolls out):
```sql
-- once per role set (P2)
CREATE ROLE app_rw LOGIN NOSUPERUSER NOBYPASSRLS;
-- per tenant-owned table (P4)
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE posts FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON posts
  USING      (tenant_id = current_setting('app.current_tenant'))   -- cuid → text
  WITH CHECK (tenant_id = current_setting('app.current_tenant'));
```

---

## P1 — Schema readiness (every tenant-owned table has non-null `tenant_id`)  ✅ DONE

> **Complete (2026-05-31). Nothing is live, so this was a direct schema
> replacement — no migrations, no backfill, no shadow DB.** Edited
> `trellis/prisma/schema.prisma`, regenerated the Prisma client (`prisma
> generate`, not `migrate`); `prisma/migrations/` will be reset at first deploy.
> `tsc --build` clean; full unit suite green (6453 passed).

RLS can only key on a column that exists and is populated. Closes the
`04-data-model-inventory` gaps.

- [x] `ProductTaxonomyTag`: **denormalized `tenant_id`** (resolves the orphan).
      `productId` is an external **Shopify** string — there is no local `Product`
      table to define and the tags are tenant-owned, so the column is the right
      fix. Also closed a real cross-tenant read leak in
      `getProductTaxonomyTags`/`removeProductTaxonomyTags` (was keyed by
      `productId` only).
- [x] Added non-null `tenant_id` (FK to `Tenant`, `onDelete: Cascade`, indexed)
      to `PostGeoIndex`, `LinkCheck`, `PostMedia`, `PostSentiment` + the back-
      relations on `Tenant`.
- [x] `SecurityEvent`/`AuditEvent`: left `tenant_id` **nullable** (system rows);
      `AuditEvent` frozen-type contract intact.
- [x] **Write-site stamping:** the type system surfaced 6 create sites + 1
      `tx: any`-masked site (`data-router` PostMedia); all now stamp `tenant_id`
      from the owning parent / `this.tenantId`. `link-security-handler`
      `queueThreatIntelCheck` gained a required `tenantId` param.
- N/A — zero-NULL migration check (no live data to backfill; the column is
      NOT NULL from creation).

**Note:** the five by-relation children are stamped **explicitly from their
parent**, and stay classified `by-relation`/unscoped in the WS2 extension on
purpose — they are written from contexts where the ambient tenant isn't set
(ActivityPub federation, async link checks), so the extension must not
auto-stamp them from ambient context. RLS (P4) enforces them at the DB
regardless.

**Also fixed (pre-existing gap):** `DataRouter.createPost` never set
`Post.tenant_id` (NOT NULL since v0.7, masked by `as any`/`tx: any`). Added a
required `tenantId` param threaded from the handler's `activeTenantId`.

---

## P2 — Database roles & grants  [needs infra]

In the infrastructure repo (no infra in the trellis repo):
- [ ] Create the request-path role `app_rw` (NOSUPERUSER, **NOBYPASSRLS**) and a
      separate `migrator`/operator role (owns schema, runs DDL/migrations).
- [ ] The application's runtime secret (Secrets Manager `DATABASE_URL`) connects
      as `app_rw`. Migrations run as `migrator`.
- [ ] (Optional, for the operator path) a policy-exempt analytics/admin role used
      only by the explicit `runUnscoped()` connection.

**Verify:** `app_rw` cannot `SET ROLE` to a privileged role; `SELECT
rolbypassrls FROM pg_roles WHERE rolname='app_rw'` is false.

---

## P3 — Tenant-scoped transaction wrapper (the app seam)  ✅ BUILT (not activated)

> **`withTenantTx` added (2026-05-31)** to
> `trellis/apps/api/src/lib/database-connection-manager.ts`, with unit tests
> (`with-tenant-tx.test.ts`): sets the GUC transaction-locally and passes `tx`
> through when an ambient tenant is present; fails closed (throws, opens no
> transaction) when absent. It uses the exact P0-validated statement
> (`set_config('app.current_tenant', $1, true)`, parameterized).
> **Deliberately not wired into any request path** — routing request DB access
> through it is the *activation* step and must not precede P4 (RLS) in prod.

Today trellis runs queries individually (`executeWithRetry`), not in per-request
transactions. RLS-via-GUC requires the tenant context and the queries to share a
transaction. Add **one** wrapper, sourced from the WS1 ambient tenant (already
built, PR #21):

```ts
// the single place that establishes DB-level tenant context
export function withTenantTx<T>(prisma, fn: (tx) => Promise<T>): Promise<T> {
  const tid = getCurrentTenantId();            // from WS1 ambient tenant
  if (!tid) throw new Error("no tenant context"); // fail closed
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tid}, true)`;
    return fn(tx);                              // all queries here are RLS-scoped
  });
}
```

- [ ] Route request-path DB access through `withTenantTx` (the natural home is
      `database-connection-manager`, alongside `executeWithRetry`).
- [ ] Operator/cross-tenant paths use `runUnscoped(reason, …)` on the
      policy-exempt connection (P2) — never `app_rw` with the tenant unset acting
      as a bypass.
- [ ] Decide the wrapper's interaction with the existing retry/circuit-breaker
      (wrap the transaction, not individual statements).

**Verify:** unit/integration tests that `withTenantTx` sets the GUC and that a
query inside it is scoped; "no tenant context" throws.

**Note:** P3 is correct on trellis's current in-process pool. If/when an external
pooler is added, use **PgBouncer transaction mode** (not RDS Proxy) — see
[04](04-connection-pooling-resolved.md).

---

## P4 — Enable RLS, table-by-table  [needs DB]

Roll out the P0 policy template across the tenant-owned tables, highest-value
first (`Post`, `PostComment`, `Notification`, `Entity`, `Group*`, taxonomy,
connection-codes, + the P1-denormalized children). Staged and reversible.

- [ ] `ENABLE` + `FORCE ROW LEVEL SECURITY` + `USING`/`WITH CHECK` per table.
- [ ] System-row exception for `SecurityEvent`/`AuditEvent` (operator role only).
- [ ] Each table can be toggled independently; keep a documented `DISABLE`
      rollback per table.
- [ ] Confirm migrations (run as `migrator`) are unaffected (owner runs DDL; not
      subject to `app_rw` policies).

**Verify (the real gate):** with RLS on, raw SQL, `findUnique`-by-id, and a
deliberately unscoped `findMany` as `app_rw` all return only active-tenant rows;
a cross-tenant `INSERT`/`UPDATE` is rejected.

---

## P5 — Verification & guardrails  [needs DB]

- [ ] **Cross-tenant leak suite** against **real PostgreSQL with RLS on** (RLS is
      DB behavior — not mockable). Seed tenants A and B with overlapping
      users/content; for every (operation × tenant-owned model) assert acting as
      A never reads/writes a B row, including via raw SQL and primary-key lookup.
      Reuse the `test/integration/predeployment` harness shape.
- [ ] **DB-level coverage check** (CI/migration): every tenant-owned table has
      RLS enabled + a policy. Fails when a new table is added without one — the
      database-level analogue of the WS2 model-classification test.
- [ ] **Monitoring:** alarm on RLS-denied / empty-tenant-context errors;
      `DatabaseConnectionsCurrentlySessionPinned` if a pooler is ever introduced.
- [ ] **Runbook:** tenant suspension, the operator cross-tenant procedure,
      "delete a tenant" (cascade + shared-blob handling for content-addressed
      `MediaFile`), and per-table RLS rollback.

---

## P6 — Application ergonomics (the Prisma extension, already built)  [done-ish]

WS1+WS2 (PR #21) stay, **explicitly as ergonomics + defense-in-depth, not the
boundary**:
- Keep the ambient-tenant middleware (WS1) — it now also feeds P3's wrapper.
- Keep the Prisma `$extends` extension (WS2) for concise, auto-scoped app queries
  and an extra app-side layer. Run it in `shadow` to find unscoped call sites,
  then `enforce` for ergonomics. **Enabling its `enforce` mode is not what makes
  trellis isolated — RLS (P4) is.** Update the PR #21 description to say so on
  merge.

---

## Tiering (deferred until a contract demands it)

For an enterprise tenant requiring physical isolation, add a **silo premium
tier** (dedicated database, routed by extending the region connection registry in
`database-connection-manager` to a tenant→connection map), running the same
product version. Do not build this preemptively.

---

## Dependencies, gating, and ownership

| Phase | Depends on | Needs | Owner | Status |
| --- | --- | --- | --- | --- |
| P0 spike | — | throwaway Postgres | app/DBA | ✅ done |
| P1 schema | P0 | (none — nothing live) | app | ✅ done |
| P2 roles | — | infra repo | infra/DBA | todo |
| P3 wrapper | WS1 (done) | — | app | ✅ built, not wired |
| P4 enable RLS | P1, P2, P3 | DB | app/DBA | todo (needs DB) |
| P5 verify | P4 | DB | app | todo (needs DB) |
| P6 extension | P3 | — (built) | app | ✅ built (WS2) |

Critical path: **P0 → P1 → P4 → P5** is the boundary. P2 (roles) parallels P1.
P3 (wrapper) needs only WS1. P6 is independent ergonomics.

## Risk register

| Risk | Severity | Mitigation |
| --- | --- | --- |
| RLS misconfigured (policy gap on a table) | High | P5 DB-level coverage check; `FORCE` + NOBYPASSRLS so a gap fails closed, not open. |
| App role accidentally `BYPASSRLS`/owner | High | P2 asserts `rolbypassrls=false`; migrations under a separate role. |
| Per-request transaction overhead | Med | P0 benchmark; `tenant_id`-leading indexes; transaction wraps the request's DB work, not each statement. |
| Backfill leaves NULL `tenant_id` | Med | P1 migration check fails the deploy. |
| External pooler later pins (RDS Proxy) | Med | Decided: PgBouncer transaction mode for the tenant path ([04](04-connection-pooling-resolved.md)). |
| Operator path mis-scoped | Med | Explicit `runUnscoped` on a policy-exempt role; tested in P5. |

Everything here is a documented, time-tested step. The foundational deliverable
is **P0 → P5**; nothing about the boundary depends on the application extension.
