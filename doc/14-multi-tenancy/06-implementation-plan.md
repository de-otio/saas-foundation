# 06 — Implementation plan

> **⚠️ SUPERSEDED by [`deep-dive/06-implementation-plan.md`](deep-dive/06-implementation-plan.md)
> (RLS-first).** This version leads with the application-level Prisma extension
> (WS2) and treats RLS as a "backstop". The deep-dive analysis corrected that:
> **RLS is the isolation boundary and must lead; the extension is ergonomics
> only.** Use the RLS-first plan. This file is kept for history and its still-
> valid AWS-grounded notes (pinning, the runtime-variable pattern), but its
> ordering/emphasis is obsolete.

Operationalizes the phased plan in [05](05-enforcement-and-migration.md) into
concrete workstreams, grounded in AWS guidance for multi-tenant PostgreSQL.
Nothing here is implemented yet. Each workstream is independently shippable and
verifiable; later workstreams depend on earlier ones as noted.

## AWS-grounded decisions (what the research settled)

### Partitioning model — "pool" (row-level), confirmed

AWS classifies multi-tenant PostgreSQL into **silo** (DB per tenant), **bridge**
(schema per tenant), and **pool** (shared tables, row-level). Trellis is already
shaped as **pool**, and AWS recommends RLS as the isolation mechanism for the
pool model. We adopt the pool model with RLS. (Sources: AWS Prescriptive
Guidance, *Implementing managed PostgreSQL for multi-tenant SaaS applications*;
*Guidance for Multi-Tenant Architectures on AWS*.)

### RLS mechanism — runtime variable, not per-tenant DB users

AWS explicitly recommends the **runtime-variable** form of RLS over per-tenant
PostgreSQL users:

> "a SaaS application that uses PostgreSQL should be responsible for setting a
> tenant-specific context at runtime … `current_setting('app.current_tenant')`"
> — AWS Prescriptive Guidance, *Row-level security recommendations*

So policies look like:

```sql
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE posts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON posts
  USING      (tenant_id = current_setting('app.current_tenant'))
  WITH CHECK (tenant_id = current_setting('app.current_tenant'));
```

**Trellis-specific detail:** tenant ids are **cuid strings**, not UUIDs — compare
as `text` (the AWS sample casts to `::UUID`; we do **not**). Reference
implementation to crib from: `aws-samples/aws-saas-factory-postgresql-rls`.

The app sets the variable per unit of work with **`set_config('app.current_tenant', $tid, true)`**
(the `true` = transaction-local, i.e. `SET LOCAL` semantics — auto-resets at
commit/rollback, so it cannot bleed to the next user of a pooled connection).

### The RDS Proxy collision (the top risk) — decide before adopting Proxy

AWS docs are explicit that for **RDS for PostgreSQL**, "Using `SET` commands" and
`set_config` **pin** the client connection — and there is **no `SET LOCAL`
exemption for PostgreSQL** (that exemption exists only for MySQL/MariaDB). A
pinned connection stays pinned **until the client connection ends**, not just for
the transaction. (Source: AWS RDS User Guide, *Avoiding pinning an RDS Proxy* →
*Conditions that cause pinning for RDS for PostgreSQL*.)

Consequences:

- **Today trellis has no RDS Proxy** — `database-connection-manager` holds a
  per-task `pg.Pool` straight to RDS (via the Secrets Manager `DATABASE_URL`).
  In this topology, setting `app.current_tenant` per transaction is **safe and
  cheap** — there is no proxy to pin.
- **`scaling-health.ts` lists RDS Proxy as the recommended pooler for >8 tasks.**
  If/when that lands, GUC-based RLS would pin every connection that ever sets the
  tenant variable — collapsing Proxy multiplexing.

**Decision for the plan:** ship RLS now on the direct-pool topology. **Couple any
future RDS Proxy adoption with one of:**
1. keep the RLS (tenant-scoped) workload on a **direct RDS endpoint**, using the
   Proxy only for workloads that don't set session state; or
2. accept per-connection pinning for tenant-scoped traffic, size the Proxy/pool
   accordingly, and monitor **`DatabaseConnectionsCurrentlySessionPinned`**; or
3. revisit if AWS adds PostgreSQL session-var tracking.

The app-level Prisma extension (WS2) does **not** rely on session variables, so it
is Proxy-safe and remains the first line of isolation regardless of this decision.
This is the core reason for the two-layer design.

### DB role

The application's DB role **must not** have `BYPASSRLS`. Use `FORCE ROW LEVEL
SECURITY` so the table owner is subject to policy too. Migrations / operator
tasks run as a separate role. (Infra/CDK change — see WS3.)

## Workstreams

```
WS0 schema gaps ──► WS1 ambient tenant ──► WS2 app extension (shadow→enforce)
                                              │
                                              └─► WS3 RLS backstop ──► WS4 verify & roll out
```

### WS0 — Close the schema gaps (Prisma migrations; no enforcement yet)

Resolves the gap table from [04](04-data-model-inventory.md). Each is a Prisma
schema change + migration + backfill.

- [ ] **`ProductTaxonomyTag`**: define a `Product` model with `tenantId`, or drop
  the orphan table. (Blocks RLS reasoning — it currently references a
  non-existent `Product`.)
- [ ] **`PostGeoIndex`**: add `tenantId` (denormalized from the post/entity);
  backfill; `NOT NULL` after backfill.
- [ ] **`LinkCheck`**: add `tenantId` (denormalized from post/comment); backfill.
- [ ] **Denormalize `tenantId` onto hot join-children** chosen in
  [04](04-data-model-inventory.md) §C (`PostMedia`, `PostSentiment`); backfill.
- [ ] **`SecurityEvent` / `AuditEvent`**: keep nullable `tenantId`; define the
  contract — only an operator role/path may read `tenant_id IS NULL` (encoded in
  the RLS policy in WS3).
- [ ] **Backfill audit**: verify zero NULL `tenantId` on every table destined to
  be `NOT NULL` + RLS-policied. A migration check fails the deploy if any remain.

**Verify:** migration runs clean on a prod-shaped snapshot; row counts of
backfilled `tenantId` match parent counts; no NULLs on scoped tables.

### WS1 — Ambient tenant context (foundation ALS)

- [ ] Add `@de-otio/saas-foundation/tenant` dependency (ALS half only).
- [ ] At the auth seam (`lib/auth/auth-middleware.ts`), validate
  `auth.activeTenantId` via foundation `tenantId(...)`; reject empty
  active-tenant claims (the PreTokenGeneration Lambda writes `""` when there is
  no active membership) **before** the data layer.
- [ ] Wrap authenticated request handling in
  `runWithTenantContext(tenantId(auth.activeTenantId), () => …)` (in the Hono
  middleware chain / `server.ts` dispatch).
- [ ] Add `getCurrentTenantId()` accessor usage points (no enforcement yet).
- [ ] **Telemetry (shadow):** log queries on tenant-scoped models that execute
  with no tenant filter, to quantify the gap before enforcing.

**Verify:** unit test that a request runs its handler inside a tenant scope;
`getCurrentTenantId()` returns the active tenant; requests with an empty claim
401 at the seam. No behavior change to data yet.

### WS2 — Application enforcement: Prisma client extension

The Proxy-safe first line of isolation.

- [ ] Build a `$extends` `query` interceptor over `$allModels`:
  - tenant-scoped model + read/update/delete → inject
    `where: { tenantId: getCurrentTenantId() }`;
  - create → set `data.tenantId` (reject mismatch);
  - missing tenant context on a scoped model → throw.
- [ ] Maintain the **`TENANT_SCOPED` set** and the **global/user-scoped
  allowlist** ([04](04-data-model-inventory.md)) as the single source of truth.
- [ ] Add an explicit **`unscoped(prisma, fn)`** escape hatch (or a separate
  operator client) and migrate the known cross-tenant call sites onto it:
  super-admin tooling, the ActivityPub federation graph, operator analytics.
- [ ] Ship in **shadow mode** first (compute scoped args, log divergence, run
  original), then flip to **enforce**.

**Verify:** with a tenant context, a deliberately unscoped
`post.findMany({ where: { authorId } })` returns only active-tenant rows; the
shadow-mode divergence log is empty for normal traffic before flipping;
`unscoped()` is unreachable on request paths (lint/test guard).

**Known limit (motivates WS3):** the extension does not reliably cover nested
relation writes, `$queryRaw`, or every filter shape.

### WS3 — Database backstop: PostgreSQL RLS

- [ ] **Infra/CDK:** create/confirm a non-`BYPASSRLS` application role; keep a
  separate migration/operator role; grant appropriately. (No infra in this repo —
  this is a change in the infrastructure repo.)
- [ ] **Tenant-GUC propagation:** set `app.current_tenant` on the connection for
  each unit of work. Recommended: a thin wrapper that issues
  `SELECT set_config('app.current_tenant', $1, true)` as the first statement of a
  Prisma interactive transaction, reading `getCurrentTenantId()`. (Transaction-
  local ⇒ auto-reset ⇒ no cross-request bleed.) Document the per-checkout
  alternative for non-transactional reads on the **direct-pool** topology.
- [ ] **Policies table-by-table**, highest value first (`Post`, `PostComment`,
  `Notification`), then the rest of the scoped set: `ENABLE` + `FORCE ROW LEVEL
  SECURITY`, `USING` + `WITH CHECK` on `current_setting('app.current_tenant')`
  (text compare). System-row exception for `SecurityEvent`/`AuditEvent` per WS0.
- [ ] **Operator path:** runs without the tenant GUC (or under a policy-exempt
  role) so `unscoped()` keeps working — explicitly.
- [ ] **RDS Proxy gate:** do **not** introduce RDS Proxy for the RLS workload
  without applying a mitigation from the "RDS Proxy collision" section above.

**Verify:** raw `$queryRaw` without the extension still returns only
active-tenant rows (proves the DB backstop); pooling-safety test interleaves two
tenants on one pool with no `app.current_tenant` bleed; RLS tested against a
**real** Postgres (reuse the `test/integration/predeployment` harness shape — RLS
is DB behavior, not mockable).

### WS4 — Verification, guardrails, rollout

- [ ] **Cross-tenant leak suite:** seed tenants A and B with overlapping
  users/content; for every (operation × scoped model), assert acting as A never
  reads/mutates a B row, and vice versa. Property-style.
- [ ] **Coverage meta-test (CI):** every Prisma model is either in
  `TENANT_SCOPED` or on the documented allowlist — **fails when a new model is
  added without a decision** (closes the silent-hole risk).
- [ ] **Monitoring:** dashboards/alarms on `DatabaseConnectionsCurrentlySessionPinned`
  (if Proxy is ever added) and on RLS-denied / empty-tenant-context errors.
- [ ] **Runbook:** tenant suspension (`TenantAuthorizationError` path), operator
  cross-tenant access procedure, "delete a tenant" (cascade + shared-blob
  handling for `MediaFile`).
- [ ] **Staged rollout:** shadow → enforce per workstream; per-table RLS enable;
  feature-flag the extension's enforce mode for fast rollback.

## Dependencies & sequencing

- WS0 is a prerequisite for RLS on the affected tables (can't policy a NULL
  `tenant_id`).
- WS1 is a prerequisite for WS2 and WS3 (both read the ambient tenant).
- WS2 can ship and deliver value **before** WS3 (app-level isolation, Proxy-safe).
- WS3 is the hardest; its tenant-GUC propagation spike (transaction wrapper vs
  per-checkout) should be de-risked early but only blocks WS3, not WS0–WS2.

## Risk register

| Risk | Severity | Mitigation |
| --- | --- | --- |
| RDS Proxy ⨯ GUC pinning (PostgreSQL) | **High** | Decision gate in WS3; app extension is Proxy-independent; monitor `…SessionPinned`. |
| Missed query path (raw SQL, nested writes) | High | RLS backstop (WS3) + coverage meta-test (WS4). |
| Backfill leaves NULL `tenantId` | Med | WS0 migration check fails deploy on any NULL. |
| Transaction wrapper overhead on hot reads | Med | Benchmark; per-checkout GUC for direct-pool reads; index `tenant_id`. |
| Cross-region org tenant split | Med | Decide single-region-per-org at creation (open decision #3 in [05](05-enforcement-and-migration.md)). |
| Operator path accidentally tenant-scoped | Med | Explicit `unscoped()` + policy-exempt role; tests. |

## Effort shape

WS0–WS1 are low-risk and independently valuable (schema hygiene + ambient
tenant). WS2 is the ergonomic + security win and is Proxy-safe. WS3 (RLS under
pooling, the GUC-propagation spike, the infra role change) is the bulk of the
risk and should start only after the spike. WS4 runs alongside. The whole thing
hardens an existing design — it is not greenfield — which is why the pool/RLS
path (not silo/bridge) is the cost-appropriate choice.

## Security review of WS1+WS2 (trellis PR #21)

WS1+WS2 shipped (default `off`) and were adversarially reviewed. Confirmed
correct: ALS `run()` isolation (no cross-request bleed), the `tenantId`
AND-merge (resists caller `OR`/`NOT`), create-stamp overwrite of attacker
`tenantId`, the verified-JWT tenant source, and — verified for the pinned
Prisma 6.19 — extension propagation into interactive `$transaction` callbacks
(so no `tx` bypass). Hardened in review: `runUnscoped(reason, fn)` is now
audited, and `enforce` activation logs a prominent "partial isolation" warning.

**Gates that MUST close before `enforce` is enabled in production** (the app
extension is a partial defense on its own):

1. **WS3 RLS** — the only thing that closes unique-selector ops
   (`findUnique`/`update`/`delete` by id), raw SQL, and `by-relation` models.
   Enabling `enforce` without RLS is a false sense of security.
2. **WS0** — denormalize `tenantId` onto the hot `by-relation` models and add
   them to `TENANT_SCOPED`.
3. Public/unauthenticated paths (federation, webfinger) that query scoped models
   must wrap their queries in `runUnscoped(...)`, or they fail closed (500)
   under `enforce` — fail-closed, but an availability blocker.

`off` (default) and `shadow` (observe-only) are safe to run now.

## Sources consulted (AWS)

- *Avoiding pinning an RDS Proxy* — RDS User Guide (PostgreSQL pinning
  conditions; `DatabaseConnectionsCurrentlySessionPinned`).
- *Row-level security recommendations* & *Best practices* — AWS Prescriptive
  Guidance, *Implementing managed PostgreSQL for multi-tenant SaaS applications*.
- *Multi-tenant data isolation with PostgreSQL Row Level Security* — AWS Database
  Blog; `aws-samples/aws-saas-factory-postgresql-rls`.
- *Guidance for Multi-Tenant Architectures on AWS* (silo/bridge/pool).
