# 05 — Enforcement design & migration plan

How to turn the existing row tagging into *enforced* isolation, and a phased,
independently-shippable path to get there. Nothing here is implemented yet.

## Enforcement: two layers, deliberately redundant

### Layer 1 — application: a Prisma client extension (correctness by construction)

A Prisma client extension (`$extends` with a `query` component) intercepts every
operation on tenant-scoped models and:

- **reads** auto-inject `where: { tenantId: getCurrentTenantId() }`;
- **writes** auto-set `data.tenantId = getCurrentTenantId()` (and reject a write
  whose explicit `tenantId` disagrees).

```ts
// sketch — not final
const TENANT_SCOPED = new Set(["Post","PostComment","Entity","Notification",
  "Group","GroupMember","EntityOwnership","ConnectionCode",
  "ConnectionCodeRedemption","TaxonomyDimension","TaxonomyCategory","TaxonomyTaxon",
  /* + denormalized children: PostMedia, PostSentiment, LinkCheck, PostGeoIndex */]);

prisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!TENANT_SCOPED.has(model)) return query(args);
        const tid = getCurrentTenantId();
        if (!tid) throw new Error(`tenant-scoped ${model}.${operation} with no tenant context`);
        // inject where for reads/updates/deletes; set data for creates
        return query(scopeArgs(operation, args, tid));
      },
    },
  },
});
```

- **Driven by the ALS carrier** ([03](03-foundation-fit.md)) — no handler passes
  `tenantId` by hand anymore; "forgot the filter" stops being possible on the
  common path.
- **Escape hatch:** an explicit `unscoped(prisma, () => …)` (or a separate
  operator client) for the legitimate cross-tenant paths — super-admin tooling,
  the federation graph, operator analytics. Cross-tenant access becomes a thing
  you *type on purpose*, visible in review.
- **Known limits:** extensions don't reliably cover nested relation writes,
  `$queryRaw`, or every filter shape. That gap is exactly why Layer 2 exists.

### Layer 2 — database: PostgreSQL RLS (fail-closed backstop)

For each scoped table:

```sql
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE posts FORCE ROW LEVEL SECURITY;          -- applies to table owner too
CREATE POLICY tenant_isolation ON posts
  USING      (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
```

The app sets `app.tenant_id` for each unit of work from `getCurrentTenantId()`.
Now a missed app-level filter (raw query, nested write, a new model someone
forgot) **cannot cross tenants** — Postgres filters it.

Requirements / sharp edges:

- The application DB role **must not** have `BYPASSRLS`; migrations/superuser
  paths run as a different role.
- **Pooling interaction is the main cost.** Trellis shares a `pg.Pool` per
  region (`database-connection-manager`). `app.tenant_id` must be set on the
  *specific* pooled connection for the duration of the unit of work and reset
  on release, or it leaks to the next checkout. Two viable patterns:
  1. **Transaction-scoped** `SET LOCAL app.tenant_id = …` at the start of a
     Prisma `$transaction` (auto-reset at commit/rollback). Cleanest; pushes
     work into transactions.
  2. **Per-checkout** `SET`/`RESET` via a pool `connect`/release hook in the
     `PrismaPg` adapter wiring. Works for non-transactional queries but needs
     careful reset discipline.
  This needs a spike (see open decisions).

### Why both

Layer 1 makes the right thing automatic and fast, and models the *intentional*
cross-tenant paths explicitly. Layer 2 guarantees that anything Layer 1 misses
fails closed at the database. Either alone is insufficient: app-only repeats
today's "isolation by discipline"; RLS-only is correct but loses the ergonomic
auto-scoping and the explicit escape hatch, and is easy to mis-set under pooling.

## Composition with region

Region selects the **database** (`database-connection-manager` pools per region);
tenant selects the **rows**. They compose: within a region's DB, RLS + the
extension filter to the active tenant. One wrinkle: an **org tenant whose members
span regions** would have its rows split across regional DBs (each member's
content lands in that member's region, tagged with the same `tenantId`).
Per-region isolation still holds; *aggregating* one tenant across regions is a
separate concern already gated by `CrossRegionConsent`. **Decision needed:** are
org tenants single-region (enforce at tenant creation) or region-spanning
(accept split storage)? See open decisions.

## The multi-tenant-user risk, handled

Because a user belongs to many tenants, the **active tenant** must be the sole
scoping key — never `userId` alone. The ALS value comes from
`auth.activeTenantId` (the verified claim), switching only via
`POST /api/auth/switch-tenant` (which re-issues the claim and invalidates the
cache). The extension + RLS both key on that ambient tenant, so "this user's
posts" is always "this user's posts *in the active tenant*."

## Migration plan (phased, each phase shippable & verifiable)

### Phase 0 — close the schema gaps (no enforcement yet)
- Resolve the [04](04-data-model-inventory.md) gap table: define/remove
  `Product`(+`ProductTaxonomyTag`); add `tenantId` to `PostGeoIndex`,
  `LinkCheck` (+ chosen denormalized children); decide the
  `SecurityEvent`/`AuditEvent` nullable-`tenantId` contract.
- Backfill `tenantId` on new columns from the parent rows; add `NOT NULL` once
  backfilled. Verify no NULLs remain on scoped tables.

### Phase 1 — adopt the ALS carrier (observe-only)
- Wrap authenticated request handling in
  `runWithTenantContext(tenantId(auth.activeTenantId), …)`.
- Validate `activeTenantId` through `tenantId()` at the auth seam; reject empty
  active-tenant claims early.
- No query changes yet. Add telemetry: log queries on scoped models that lack a
  `tenantId` filter ("shadow mode") to quantify the gap before enforcing.

### Phase 2 — application extension (shadow → enforce)
- Add the Prisma extension in **shadow mode**: compute the scoped args, log
  divergence, but run the original query. Confirms no surprises (esp. operator
  paths) against real traffic/tests.
- Flip to **enforce**; add the explicit `unscoped()` escape hatch and migrate
  the known cross-tenant call sites (super-admin, federation, analytics) onto it.

### Phase 3 — RLS backstop (table by table)
- Run the app as a non-`BYPASSRLS` role; wire `app.tenant_id` per unit of work
  (pattern chosen in the spike).
- Enable `FORCE ROW LEVEL SECURITY` + policies on scoped tables, starting with
  the highest-value (`Post`, `PostComment`, `Notification`) and expanding.
- Operator role / `unscoped()` paths use a connection without the tenant GUC (or
  a role exempt by policy), so they keep working — explicitly.

### Phase 4 — verification & guardrails
- Cross-tenant leak test suite (below).
- CI coverage check: every Prisma model is either in `TENANT_SCOPED` or on the
  documented global/user-scoped allowlist — **fails when a new model is added
  without a decision** (closes the "silent hole" risk).

## Test strategy

- **Leak tests (the core):** seed tenant A and tenant B with overlapping
  users/content; for every scoped surface, assert that acting as A never returns
  or mutates a B row — and vice versa. Property-style over a matrix of
  (operation × model).
- **Enforce-by-default test:** issue a deliberately *unscoped* query under a
  tenant context and assert it returns only active-tenant rows (proves the
  extension), then bypass the extension with raw SQL and assert RLS still filters
  (proves the backstop).
- **Escape-hatch test:** `unscoped()` returns cross-tenant rows *only* under the
  operator path, and is unreachable on normal request paths.
- **RLS against real Postgres:** reuse the existing
  `test/integration/predeployment/data-residency` harness shape — RLS is a DB
  behavior and must be tested on a real engine, not mocks.
- **Pooling-safety test:** interleave two tenants' queries on the same pool and
  assert no `app.tenant_id` bleed across checkouts.

## Open decisions

1. **RLS GUC propagation under the shared `pg.Pool`** — transaction-scoped
   `SET LOCAL` vs per-checkout `SET`/`RESET`. Needs a spike with the `PrismaPg`
   adapter; it's the single biggest engineering risk here.
2. **Join-children**: denormalize `tenantId` (simpler, faster RLS) vs
   join-based policies (no column, slower). Recommendation: denormalize the hot
   ones — see [04](04-data-model-inventory.md) §C.
3. **Org tenants & regions**: single-region per org (enforce at creation) or
   region-spanning (accept split storage + `CrossRegionConsent` for
   aggregation)?
4. **`MediaFile` dedupe**: keep cross-tenant content-addressing (and define
   shared-blob deletion + per-tenant quota semantics) vs per-tenant blobs (loses
   dedupe). Recommendation: keep dedupe, enforce access via the referencing row.
5. **`SecurityEvent`/`AuditEvent` null-tenant contract**: which role/path may
   read `tenant_id IS NULL` system rows, and how the policy expresses it.
6. **Personal vs org content in shared tables**: confirmed same tables; verify
   the switch-tenant UX makes "which space am I in" unambiguous so users don't
   post org content into their personal tenant or vice versa.

## Effort & sequencing note

Phase 0–1 are low-risk and independently valuable (schema hygiene + ambient
tenant). Phase 2 is the ergonomic win. Phase 3 (RLS under pooling) is the
hardest and should not start until the spike in open-decision #1 lands. The
whole thing is a *project*, not a follow-up — but it's hardening an existing
design, not building one from scratch, which is why row-level + RLS (not
schema/DB-per-tenant) is the cost-appropriate path.
