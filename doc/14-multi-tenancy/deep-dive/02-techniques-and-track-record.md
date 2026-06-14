# 02 — Techniques and their track record

Each canonical technique against the R1–R4 criteria from [01](01-problem-and-requirements.md).
Two axes: the **partitioning model** (where tenant data physically lives) and,
for the shared model, the **enforcement mechanism** (how isolation is guaranteed).

## Partitioning models

### Silo — database/instance per tenant
- **Mechanism:** each tenant gets its own database (or cluster). The connection
  *is* the isolation — you physically cannot query another tenant's DB.
- **Track record:** the oldest model; every "dedicated instance" enterprise
  deployment. Decades of use.
- **R1 robust:** strongest — isolation is physical, no shared rows to leak.
- **R2 scalable:** poor for many tenants — per-tenant provisioning, migration
  fan-out across N databases, connection sprawl. **Disqualified by trellis's
  personal-tenant-per-user model** (a database per user is absurd).
- **Verdict:** not the base model. Retained only as a **premium tier** for the
  few enterprise tenants who require physical isolation (see
  [05](05-recommendation-and-reassessment.md) and AWS *tier-based isolation*).

### Bridge — schema per tenant
- **Mechanism:** one database; a PostgreSQL schema (namespace) per tenant;
  `search_path` selects it.
- **Track record:** common in moderate-tenant-count B2B SaaS (hundreds–low
  thousands). Well documented (e.g. the Rails `apartment` gem era).
- **R1 robust:** strong logical separation; cross-tenant query requires an
  explicit schema switch.
- **R2 scalable:** breaks down as tenant count grows — N × every table → tens of
  thousands of objects, migrations must run across all schemas, planner/catalog
  overhead. **Also disqualified by personal-tenant-per-user** (a schema per
  user). And trellis has surfaces that are intentionally cross-tenant (the
  ActivityPub federation graph, content-addressed media) which schema separation
  fights.
- **Verdict:** not a fit for this data shape.

### Pool — shared schema, `tenant_id` per row
- **Mechanism:** all tenants share tables; every tenant-owned row carries a
  `tenant_id`; isolation is enforced per-row (see enforcement mechanisms below).
- **Track record:** the dominant model at scale; what most large multi-tenant
  SaaS run. AWS's recommended default for managed PostgreSQL multi-tenancy.
- **R1 robust:** depends *entirely* on the enforcement mechanism (next section).
  With RLS: strong (DB-enforced). With app-only scoping: weak.
- **R2 scalable:** excellent — one schema, one migration, rapid onboarding (no
  per-tenant infra), scales to very large tenant counts; the only model
  compatible with personal-tenant-per-user.
- **Verdict:** **the base model for trellis.** trellis is already shaped this way
  (12 content models already carry `tenant_id`).

## Enforcement mechanisms for the pool model

Given pool, *how* is the per-row boundary guaranteed? Three options:

### A. Application-layer scoping only
- **Mechanism:** every query includes `WHERE tenant_id = :active` (via an ORM
  scope, a query helper, or a Prisma `$extends` extension).
- **Track record:** extremely common (Rails `acts_as_tenant`, Django managers,
  Hibernate filters). Battle-tested as a *convenience*.
- **R1 robust:** **fails.** The boundary is in application code, so it protects
  only the queries it is wired into. One forgotten filter, one raw query, one
  `findUnique`-by-id, one new code path → cross-tenant leak. The PR #21 security
  review demonstrated exactly these gaps in the Prisma-extension approach.
- **Verdict:** acceptable as *ergonomics and defense-in-depth*, **never as the
  sole boundary**.

### B. PostgreSQL RLS with a runtime variable  ← chosen
- **Mechanism:** a policy on each table, `USING (tenant_id =
  current_setting('app.current_tenant'))`; the app sets `app.current_tenant`
  per request. PostgreSQL enforces it on every statement.
- **Track record:** core PostgreSQL feature since **9.5 (2016)**; AWS's
  recommended pool-model mechanism; the basis of **Supabase**'s authorization
  model (millions of databases); documented production patterns in Rails
  (pganalyze), Java, .NET, and security-product SaaS (Picus).
- **R1 robust:** **strong** — boundary is in the DB; survives forgotten filters,
  raw SQL, and primary-key lookups. With `FORCE ROW LEVEL SECURITY` and a
  non-`BYPASSRLS` app role, there is no in-app bypass.
- **R2 scalable:** excellent — index `tenant_id` (lead composite indexes with it)
  and the policy predicate is cheap; scales with the pool model. Composes with
  pooling via transaction-scoped context ([04](04-connection-pooling-resolved.md)).
- **R3/R4:** a documented core feature used by a large, well-known population.
- **Verdict:** **the isolation boundary.** Details in [03](03-rls-as-the-boundary.md).

### C. RLS keyed on a database role per tenant
- **Mechanism:** a PostgreSQL role per tenant; policy `USING (tenant_id =
  current_user)`; connect/`SET ROLE` as the tenant.
- **Track record:** used, but a minority pattern.
- **R1 robust:** strong (same DB enforcement as B).
- **R2 scalable:** **poor** — role explosion (a role per tenant → per user here),
  and role management/connection-context overhead. AWS explicitly recommends the
  **runtime variable (B) over per-tenant roles** for this reason.
- **Verdict:** rejected — B gives the same robustness without role explosion.

## Summary

| Technique | R1 robust | R2 scalable | R3 time-tested | Fits trellis | Role |
| --- | --- | --- | --- | --- | --- |
| Silo (DB/tenant) | ★★★ | ✗ (per-tenant infra) | ★★★ | only as premium tier | tier exception |
| Bridge (schema/tenant) | ★★ | ✗ (N×schema) | ★★ | ✗ | — |
| Pool + app-scoping only | ✗ | ★★★ | ★★★ | partial | ergonomics only |
| **Pool + RLS (runtime var)** | **★★★** | **★★★** | **★★★** | **yes** | **the boundary** |
| Pool + RLS (role/tenant) | ★★★ | ✗ (role explosion) | ★★ | ✗ | — |

The conclusion is not close: **pool + RLS (runtime variable)** is the only option
that satisfies all of R1–R4 for trellis's data shape, with silo retained purely
as an optional premium tier. The next two docs make RLS the boundary concrete and
resolve the one interaction (pooling) that needs care.
