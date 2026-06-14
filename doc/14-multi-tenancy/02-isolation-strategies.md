# 02 — Isolation strategies

The four standard isolation models, judged against trellis's actual shape (row
tagging already present; shared RDS per region; one app; B2B orgs of widely
varying size).

## The options

### A. Row-level, application-enforced (where trellis is today, un-enforced)

One shared schema; every tenant-scoped row carries `tenantId`; the application
adds `WHERE tenant_id = ?` to every query.

- **Pros:** zero schema/infra change (trellis already has the columns);
  cheapest; easy cross-tenant analytics for the operator; one connection pool.
- **Cons:** isolation is only as good as the discipline of every query. A single
  missed filter = silent cross-tenant leak. No backstop. This is precisely the
  current gap.

### B. Row-level + PostgreSQL RLS (recommended)

Same shared schema and `tenantId` columns, **plus** a Postgres Row-Level
Security policy on each tenant-scoped table: `USING (tenant_id = current_setting('app.tenant_id'))`.
The app sets `app.tenant_id` per transaction/connection from the resolved
tenant; the database then filters every read/write itself.

- **Pros:** keeps the cheap shared-schema model; the database becomes the
  **backstop** — a forgotten app-level filter still cannot cross tenants;
  defense-in-depth pairs naturally with an app-level scoping extension (B + the
  Prisma extension from [05](05-enforcement-and-migration.md)).
- **Cons:** RLS interacts with connection pooling (the per-tenant setting must
  be set on the pooled connection for the duration of the unit of work, then
  reset); the app DB role must **not** be `BYPASSRLS`; migrations/superuser
  paths need care. Manageable, but real engineering.

### C. Schema-per-tenant

One database, a Postgres schema (namespace) per tenant; `search_path` selects
the tenant.

- **Pros:** stronger logical separation; per-tenant backup/restore is simpler.
- **Cons:** N× schema objects (trellis has ~68 models → thousands of tables at
  scale); migrations must fan out across all schemas; connection/`search_path`
  juggling; cross-tenant queries (operator analytics, the federated social
  graph) get awkward. **Poor fit** for a social product where some surfaces are
  intentionally cross-tenant.

### D. Database-per-tenant

A separate database (or cluster) per tenant.

- **Pros:** hard isolation; per-tenant residency/scaling/blast-radius; easiest
  "delete a tenant" and "move a tenant's region".
- **Cons:** highest operational cost; provisioning/migration tooling per tenant;
  trellis's region pooling (`database-connection-manager`) would need a
  per-tenant connection registry. Justified only for a small number of large,
  compliance-driven tenants — not for a personal-tenant-per-user model where
  tenant count ≈ user count.

## Why trellis's data shape constrains the choice

Two structural facts matter:

1. **Personal tenants make tenant-count ≈ user-count.** Every user gets a
   `PERSONAL` tenant. Schema-per-tenant (C) or DB-per-tenant (D) would mean a
   schema/DB per *user* — absurd. C/D only make sense if you *also* split the
   model into "personal social space" (massive, shared) vs "org space"
   (fewer, isolatable) — a much bigger re-architecture.
2. **Some surfaces are intentionally cross-tenant.** DMs cross personal tenants;
   the ActivityPub federation graph is global; content-addressed media is
   deduplicated across tenants. Hard physical separation (C/D) fights these.

Both push decisively toward the **row-level** family (A/B).

## Recommendation: B (row-level + RLS), layered with app-level scoping

- **Keep the shared schema and the existing `tenantId` columns.** No data
  migration of the storage model; trellis is already row-level by design.
- **Enforce in the application** with a Prisma client extension that injects
  `tenantId` from the ambient context (so the common path is correct by
  construction) — see [05](05-enforcement-and-migration.md).
- **Backstop in the database** with RLS so a missed/incorrect app filter fails
  closed at Postgres rather than leaking. This is the difference between
  "isolation by code review" (A) and "isolation by the database" (B).

Defense-in-depth is the point: the app extension makes the right thing easy and
fast (and supports cross-tenant operator paths explicitly); RLS makes the wrong
thing impossible to ship silently.

## When to revisit C/D

Only for a **specific large enterprise tenant** with a contractual
physical-isolation or single-region-residency requirement that row-level cannot
satisfy. At that point a *hybrid* is reasonable: most tenants on the shared
row-level cluster, a named few on dedicated databases — routed by extending the
region pool registry in `database-connection-manager` to a tenant→connection
map. Don't build this until a contract demands it.
