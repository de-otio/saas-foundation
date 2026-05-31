# 01 — The problem, and the requirements as evaluation criteria

## This is a common, solved problem — treat it as one

"Keep each customer's data in a shared database invisible to other customers" is
one of the most-studied problems in SaaS engineering. It has a stable vocabulary
(silo / bridge / pool), a stable set of mechanisms, and decades of production
deployment behind each. We are **selecting** from well-known options, not
inventing. The bar for any choice here is: *can you point at a manual page and a
fleet of companies that have run it for years?* If not, it does not belong in a
foundational isolation boundary.

The industry taxonomy we will use (AWS *SaaS Tenant Isolation Strategies* and the
Well-Architected SaaS Lens; the same three appear in essentially every treatment
of the subject):

- **Silo** — dedicated database (or instance) per tenant.
- **Bridge** — one database, dedicated schema (namespace) per tenant.
- **Pool** — one database and schema shared by all tenants; rows carry a
  `tenant_id`; isolation is enforced per-row.

## The requirements, made concrete

The request named four properties. Turned into testable criteria:

### R1 — Robust (survives mistakes)
The isolation must hold even when application code is wrong. Concretely:
- A handler that forgets `WHERE tenant_id = …` must **not** leak.
- A raw SQL query (`$queryRaw`) must **not** leak.
- A `findUnique`/`update`/`delete` by primary key must **not** return/modify
  another tenant's row.
- There must be **no privileged in-app path** that silently bypasses the boundary
  (no `BYPASSRLS`, no superuser app role, owner subject to policy).
- Failure mode is **fail-closed**: missing tenant context denies, never
  broadens.

This criterion is the reason the boundary must be **in the database**, not in
application code. Application-layer scoping (an ORM filter, a query helper) fails
R1 by construction: it only protects the queries it is wired into.

### R2 — Scalable
- To **many** tenants on shared infrastructure without per-tenant provisioning.
  Note trellis creates a **personal tenant per user**, so tenant-count ≈
  user-count — any model requiring per-tenant infrastructure (a schema or
  database each) is disqualified for the bulk of tenants.
- Read/write performance must not degrade materially vs. the non-isolated
  baseline (i.e., the isolation predicate must be index-friendly).
- Must compose with connection pooling (the standard scaling lever for Postgres).

### R3 — Time-tested
- A mechanism with a long track record and first-class documentation. Preference
  for **core database features** over libraries, and for libraries/patterns with
  years of broad production use over anything novel.
- Explicitly **excludes**: bespoke isolation schemes; reliance on an unresolved
  interaction (the earlier "RDS Proxy pinning spike"); anything whose correctness
  we cannot cite from a primary source.

### R4 — Common
- The same problem thousands of SaaS companies have solved the same way, so the
  failure modes and operational practices are well-known and the hiring/operating
  pool understands it.

## Design principles that follow

1. **The boundary is the database.** Application-level scoping is, at most,
   ergonomics and defense-in-depth — never the guarantee (R1).
2. **Least privilege at the DB.** The application connects as a role that
   *cannot* bypass the policy; tables `FORCE` the policy on owners too (R1).
3. **Fail closed.** No tenant context ⇒ no rows / error, never "all rows" (R1).
4. **Prefer core features and proven patterns.** A 2016-era core PostgreSQL
   feature over a clever ORM trick (R3, R4).
5. **Pick the model the data shape forces, then tier the exceptions.** The
   personal-tenant-per-user reality forces *pool* for the masses; satisfy the few
   who need physical isolation with a *silo premium tier* rather than imposing
   silo/bridge on everyone (R2, and AWS tier-based isolation).
6. **Resolve, don't defer, the hard interactions.** The pooling question gets a
   documented answer here, not a "spike" ([04](04-connection-pooling-resolved.md)).

[02](02-techniques-and-track-record.md) evaluates each technique against R1–R4.
