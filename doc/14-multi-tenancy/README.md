# 14 — Multi-tenancy & data isolation (trellis)

_Full analysis. Created 2026-05-30. Companion to follow-up #3 in
`plans/trellis-migration/follow-ups.md` — which this supersedes._

## Why this exists

B2B customer organizations ("tenants") will have data that must be **isolated**
from one another. This folder is the architecture analysis for getting trellis
from where it is today to enforced per-tenant data isolation.

## The headline finding (correcting the earlier note)

The earlier follow-up note said trellis was "effectively single-tenant — nothing
for `resolveTenant` to resolve." **That was wrong**, and the code review proves
it. Trellis is better described as **logically multi-tenant but not enforced**:

- The **tenant identity layer already exists** — `Tenant`, `TenantMember`,
  `TenantDomain`, `TenantIdentityProvider`, `TenantRoleMapping`,
  `TenantInvitation` (B2B SSO/federation, members, roles, domains).
- **~12 content models already carry a `tenantId`** column with a real FK to
  `Tenant` (Post, PostComment, Entity, Notification, Group, GroupMember,
  EntityOwnership, ConnectionCode(+Redemption), Taxonomy{Dimension,Category,Taxon}).
- Every authenticated request **already knows its tenant**: the Cognito
  PreTokenGeneration Lambda writes `custom:activeTenantId` into the JWT, and
  `AuthContext.activeTenantId` is populated per request.
- Each user has a **personal tenant** plus zero-or-more **organization**
  memberships (a user can belong to *many* tenants).

What's missing is the part that actually makes it "isolation":

- **No enforcement.** `tenantId` is populated on write but queries are not
  reliably scoped by it. Reads commonly filter by `authorId`/`userId` only.
- Because **one user can be in multiple tenants**, an unscoped
  `where: { authorId }` is a genuine **cross-tenant read path**, not a
  hypothetical.
- **No automatic scoping seam.** Every handler hand-builds `where` clauses;
  there is no choke point that guarantees `tenantId = <active>`.
- Several models are **outside** the row-level model and need a decision
  (content-addressed `MediaFile`, `DirectMessage`, `PostGeoIndex`, `LinkCheck`,
  the orphaned `ProductTaxonomyTag`).

So the work is **not** greenfield multi-tenancy. It is **hardening an existing
row-level design into an enforced one** — far cheaper, but security-critical.

## ⇒ For the foundational decision, read `deep-dive/` first

A rigorous, source-backed analysis of *which isolation technique* to use — and
why it is the robust, scalable, time-tested choice — lives in
**[deep-dive/](deep-dive/)**. It supersedes the framing in `02`/`05`/`06` on two
points: **RLS is the isolation boundary (not a "backstop"), and the
connection-pooling question is resolved (not a "spike").** Start with
[deep-dive/README.md](deep-dive/README.md). The docs below remain accurate on the
*current state* and the *data-model inventory*; treat the deep dive as
authoritative on the *architecture decision*.

## Recommendation in one paragraph (updated by the deep dive)

Use the **pool model** — shared schema, `tenant_id` per row (trellis is already
shaped this way) — with **PostgreSQL Row-Level Security as the database-enforced
isolation boundary**: `FORCE ROW LEVEL SECURITY`, a non-`BYPASSRLS` app role, and
the tenant set per request via `set_config('app.current_tenant', <id>, true)`
inside a transaction. RLS is the guarantee because it holds in the database — it
survives forgotten filters, raw SQL, and primary-key lookups. The **Prisma client
extension** (WS2, PR #21), driven by foundation's `runWithTenantContext` /
`getCurrentTenantId` ALS carrier, is kept as **ergonomics + defense-in-depth
only — never the boundary**. Resolve the tenant from the verified **JWT claim**.
For enterprise tenants who require physical isolation, offer a dedicated-database
**silo premium tier** rather than changing the base model. Full justification and
sources in [deep-dive/](deep-dive/).

## Reading order

| Doc | What it covers |
| --- | --- |
| [01-current-state.md](01-current-state.md) | Exactly what exists today: identity layer, `tenantId` columns, claim-based resolution, region orthogonality, and the enforcement gaps (with file:line). |
| [02-isolation-strategies.md](02-isolation-strategies.md) | The four isolation models (row-level app-enforced, row-level + RLS, schema-per-tenant, DB-per-tenant), trade-offs, and the recommendation for trellis. |
| [03-foundation-fit.md](03-foundation-fit.md) | What `@de-otio/saas-foundation/tenant` does (resolution + ALS) and does **not** do (isolation). Which parts trellis adopts now vs later. |
| [04-data-model-inventory.md](04-data-model-inventory.md) | Model-by-model classification: scoped / global-by-design / needs-`tenantId` / derive-via-relation, plus the specific gaps. |
| [05-enforcement-and-migration.md](05-enforcement-and-migration.md) | The Prisma-extension + RLS enforcement design, the multi-tenant-user leak risk, a phased migration plan, test strategy, and open decisions. |
| [06-implementation-plan.md](06-implementation-plan.md) | The concrete, AWS-grounded implementation plan: workstreams WS0–WS4 with task checklists, the RDS-Proxy↔RLS pinning decision, the runtime-variable RLS pattern, dependencies, and a risk register. |

## Status

Analysis only — no code changes proposed here are implemented. The migration
plan in [05](05-enforcement-and-migration.md) is sequenced so each phase is
independently shippable and verifiable.
