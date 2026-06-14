# 03 — RLS as the isolation boundary

Why RLS is robust enough to *be* the boundary (not a backstop), how it works, and
the standard mitigations for its two known pitfalls. Source: the PostgreSQL
manual, *Row Security Policies*
(https://www.postgresql.org/docs/current/ddl-rowsecurity.html), plus AWS
Prescriptive Guidance.

## Maturity

RLS is a **core PostgreSQL feature since 9.5 (January 2016)** — ~10 years in
production across the entire Postgres ecosystem (RDS, Aurora, self-managed). It is
not an extension, not experimental, and not AWS-specific. It is the mechanism the
database ships specifically for "restrict which rows a query can see/modify."

## How it works

A policy is a boolean expression the planner adds to every statement on the
table:

```sql
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE posts FORCE  ROW LEVEL SECURITY;          -- owners subject to it too
CREATE POLICY tenant_isolation ON posts
  USING      (tenant_id = current_setting('app.current_tenant'))   -- read/visibility
  WITH CHECK (tenant_id = current_setting('app.current_tenant'));  -- write
```

- **`USING`** governs which rows are *visible* to `SELECT`/`UPDATE`/`DELETE`.
- **`WITH CHECK`** governs which rows may be *written* by `INSERT`/`UPDATE` — this
  is what stops a tenant from writing a row stamped with *another* tenant's id.
  (If omitted, `USING` applies to writes too.)
- The predicate is applied **inside the database** for *every* statement —
  ORM query, raw SQL, primary-key lookup, a query that forgot its filter. This is
  precisely the R1 property the application layer cannot provide.
- `tenant_id` is compared as **text** (`current_setting` returns text). trellis
  ids are **cuid strings**, so compare directly — do **not** cast to `::uuid`
  (the AWS sample uses UUID tenant ids and casts; that does not apply here).

### Policy combination (a safety property)
Multiple **permissive** policies combine with `OR`; **restrictive** policies
combine with `AND`. The tenant policy should be the baseline. If finer rules are
added later, prefer `AS RESTRICTIVE` for anything that must *narrow* access, so it
can never widen the tenant boundary.

## Why it can be the boundary: closing the bypass paths

RLS is bypassed in exactly three documented cases (PG manual): **superusers**,
roles with **`BYPASSRLS`**, and **table owners** (by default). All three are
closed by configuration:

1. The application connects as a **dedicated role that is NOT a superuser and
   does NOT have `BYPASSRLS`.**
2. Every tenant table uses **`FORCE ROW LEVEL SECURITY`**, so even the table owner
   is subject to the policy.
3. **Migrations / operator tasks** run as a *separate*, privileged role — never
   the request-path app role.

With those three, there is no in-application path around the policy. This is the
difference between "isolation by code review" and "isolation by the database."

## The operator / cross-tenant path (explicit, not accidental)

Some work is legitimately cross-tenant: super-admin tooling, the federation
graph, operator analytics, the cross-tenant membership lookup. Handle it
explicitly, not by weakening the default:

- Preferred: those paths use a **distinct connection/role** that is policy-exempt
  (or simply do not set `app.current_tenant` while connected as a role allowed to
  see all rows), and the choice is **visible in code** (the `runUnscoped()`
  wrapper from WS2, which now logs every use).
- Never give the normal request-path role `BYPASSRLS`.

## Performance and scalability

- The policy adds `tenant_id = …` to the query. **Index for it:** make
  `tenant_id` the leading column of the composite indexes that back tenant-scoped
  access patterns (e.g. `(tenant_id, created_at)` for feeds). Then RLS queries are
  as fast as the equivalent hand-written filter — which is what large pool-model
  deployments rely on.
- `current_setting('app.current_tenant')` is an in-memory GUC read — negligible
  cost.
- This is the model AWS documents for the pool tier and that Supabase runs across
  a very large fleet; performance at scale is a solved, documented concern (index
  discipline + the usual read-replica/cache offload for noisy-neighbor load, per
  the AWS pool-model page).

## Known pitfalls and their standard mitigations

| Pitfall | Mitigation (standard, documented) |
| --- | --- |
| Owner/superuser/`BYPASSRLS` bypass | `FORCE RLS` + dedicated non-`BYPASSRLS` app role; migrations under a separate role. |
| Connection-context **leak** under pooling (the tenant GUC outliving the request) | Set it **transaction-locally** (`set_config(...,true)` / `SET LOCAL`) inside a per-request transaction. See [04](04-connection-pooling-resolved.md). |
| Forgetting to set the context ⇒ which rows? | Fail closed: with no `app.current_tenant`, `current_setting('app.current_tenant')` errors (or, with the 2-arg `true` form, returns NULL → matches no rows). Make the app set it at the start of every request transaction; treat "unset" as an error. |
| `WITH CHECK` omitted ⇒ cross-tenant writes | Always specify `WITH CHECK` equal to `USING` on writable tables. |
| Policy logic drift as tables are added | A migration/CI check that every tenant-owned table has RLS enabled + a policy (mirrors the WS2 model-classification coverage test, but at the DB level). |

Every one of these has a one-line, documented answer. That is what "time-tested"
buys: the failure modes are known and the mitigations are standard.

## Net

RLS satisfies R1 (DB-enforced, fail-closed, no in-app bypass), R2 (index-friendly,
scales with the pool model), R3 (a 2016 core feature), and R4 (the common pattern,
used at very large scale). It is the boundary. The only thing that needs care is
*how the per-request tenant context reaches the connection under pooling* — which
is the subject of [04](04-connection-pooling-resolved.md).
