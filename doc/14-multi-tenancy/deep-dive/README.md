# Multi-tenancy deep dive — choosing a robust, scalable, time-tested isolation boundary

_2026-05-31. In-depth analysis requested because tenant data isolation is a
critical, foundational function: it must not depend on experimental or unclear
mechanisms, must be robust and scalable, and should use well-documented,
time-tested techniques. This folder is that analysis, grounded in primary
sources._

## The question

How should trellis isolate one B2B tenant's data from another's, such that the
isolation is (a) **robust** — it survives application bugs, forgotten filters,
raw SQL, and ORM quirks; (b) **scalable** — to many tenants on shared
infrastructure; and (c) **time-tested** — a boring, widely-deployed,
well-documented technique, not a clever one-off?

## TL;DR — the answer is a solved, common problem

Tenant isolation in a shared relational database is a textbook problem with a
textbook answer:

> **Shared schema + a `tenant_id` discriminator column + PostgreSQL Row-Level
> Security (RLS) as the database-enforced isolation boundary.** This is AWS's
> recommended "pool" model, it is the mechanism PostgreSQL ships for exactly this
> purpose (a core feature since 9.5, 2016), and it is in large-scale production
> use across the industry (it is the entire basis of Supabase's authorization
> model, and a documented pattern in Rails, Java, and .NET SaaS).

Two corollaries that make it robust *and* boring:

1. **The boundary lives in the database, not the application.** RLS filtering
   happens in PostgreSQL, so a missed `WHERE tenant_id = …` in app code — or a
   raw query, or a `findUnique`-by-id — still cannot cross tenants. The app role
   runs **without `BYPASSRLS`** and tables use **`FORCE ROW LEVEL SECURITY`**, so
   there is no privileged path around the policy.
2. **The connection-pooling concern is solved, not a "spike."** The tenant is set
   per request with `set_config('app.current_tenant', <id>, true)` /
   `SET LOCAL` **inside a transaction** — transaction-scoped, so it is safe under
   a transaction-mode pooler (PgBouncer) and never leaks to the next user of a
   pooled connection. This is the documented, widely-used pattern; see
   [04](04-connection-pooling-resolved.md).

For the minority of enterprise tenants who contractually require *physical*
isolation, the time-tested answer is **tier-based isolation**: keep everyone on
the pooled RLS database, and offer a dedicated-database ("silo") **premium tier**
for the few who need it (AWS Well-Architected SaaS Lens). Don't build silo for
everyone.

## What changed from the earlier analysis (honest reassessment)

The earlier docs (`../02`, `../05`, `../06`) reached the same destination —
row-level + RLS — but framed it in two ways this deep dive corrects:

- **RLS was framed as a "backstop" behind an application-level Prisma `$extends`
  extension as the "first line."** That is backwards for a security boundary.
  **RLS is the boundary; the Prisma extension is ergonomics only** (it makes the
  common query path concise and adds defense-in-depth), and must never be relied
  on as the isolation guarantee — the security review of PR #21 showed it cannot
  cover `findUnique`-by-id, raw SQL, or relation models. See
  [05](05-recommendation-and-reassessment.md).
- **The connection-pooling/RDS-Proxy interaction was called the "biggest risk"
  and a required "spike."** It is neither — it is a solved problem with a
  documented pattern. [04](04-connection-pooling-resolved.md) resolves it.

The earlier WS1+WS2 work (the ambient-tenant middleware and the Prisma extension,
PR #21) is still useful — but as the *ergonomic* layer, explicitly subordinate to
RLS. WS3 (RLS) is the actual foundational deliverable and should lead.

## Reading order

| Doc | Contents |
| --- | --- |
| [01-problem-and-requirements.md](01-problem-and-requirements.md) | The problem stated as the common one it is; the robustness/scalability/maturity requirements turned into explicit evaluation criteria and design principles. |
| [02-techniques-and-track-record.md](02-techniques-and-track-record.md) | The canonical techniques (silo / bridge / pool; app-scoping vs RLS vs role-per-tenant) — mechanism, who runs it and since when, robustness, scalability, failure modes. |
| [03-rls-as-the-boundary.md](03-rls-as-the-boundary.md) | RLS in depth and why it is the *primary* boundary: maturity, `USING`/`WITH CHECK`, `FORCE` + non-`BYPASSRLS`, runtime-variable vs role-per-tenant, performance + indexing, the operator path, known pitfalls + standard mitigations. |
| [04-connection-pooling-resolved.md](04-connection-pooling-resolved.md) | The pooling question, resolved with primary sources: transaction-scoped `set_config`, PgBouncer modes, the RDS Proxy pinning limitation, and the concrete trellis seam change. |
| [05-recommendation-and-reassessment.md](05-recommendation-and-reassessment.md) | The decisive recommendation + the exact stack, the tiering option, the scalability ceiling, and the reassessment of the earlier WS docs. |
| [06-implementation-plan.md](06-implementation-plan.md) | The **RLS-first implementation plan** (P0 spike → P1 schema → P2 roles → P3 tenant-tx wrapper → P4 enable RLS → P5 verify; P6 = the extension as ergonomics). Supersedes `../06`. |
| [07-spike-results.md](07-spike-results.md) | **P0 results — RLS proven on real RDS PostgreSQL 16.9 (7/7 checks).** The validated policy + transaction-scoped `set_config` artifacts for P4. |

## Primary sources

- PostgreSQL manual — *Row Security Policies* (`USING`/`WITH CHECK`, `FORCE`,
  `BYPASSRLS`): https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- AWS Prescriptive Guidance — *Implementing managed PostgreSQL for multi-tenant
  SaaS* (pool model, RLS recommendations):
  https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-managed-postgresql/pool.html
- AWS Well-Architected **SaaS Lens** — isolation models + *tier-based isolation*:
  https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/tier-based-isolation.html
- AWS — *SaaS Tenant Isolation Strategies* whitepaper (silo/bridge/pool).
- AWS RDS User Guide — *Avoiding pinning an RDS Proxy* (PostgreSQL `SET` pins):
  https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-pinning.html
- PgBouncer — *Features / pooling modes* (`SET` in transaction mode):
  https://www.pgbouncer.org/features.html
- Track record: Supabase RLS (https://supabase.com/docs/guides/database/postgres/row-level-security);
  pganalyze, *Postgres RLS in Rails* (https://pganalyze.com/blog/postgres-row-level-security-ruby-rails);
  Picus Security Engineering, *DB-level multi-tenancy with RLS*.
