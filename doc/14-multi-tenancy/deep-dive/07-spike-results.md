# 07 — P0 spike results (RLS proven on RDS PostgreSQL)

_2026-05-31. Satisfies the P0 exit criterion in
[06-implementation-plan.md](06-implementation-plan.md). The throwaway database
was created and destroyed via a CDK app on AWS profile `dot-dev`
(eu-central-1); nothing persists._

## What was run

- **Real Amazon RDS PostgreSQL 16.9** (db.t4g.micro), reached over TLS.
- A non-privileged app role `app_rw` (`NOSUPERUSER`, `NOBYPASSRLS`), a `posts`
  table with `tenant_id text NOT NULL`, `ENABLE` + **`FORCE ROW LEVEL SECURITY`**,
  and the policy below. Tenant context set **transaction-locally** with
  `set_config('app.current_tenant', <id>, true)`.

## Result: 7/7 checks passed

| Check | Result |
| --- | --- |
| `app_rw` is `NOSUPERUSER` + `NOBYPASSRLS` | PASS (`rolsuper=false, rolbypassrls=false`) |
| tenant-a `SELECT` returns only A's rows | PASS (`a1,a2`) |
| **`findUnique`-by-id of another tenant's row → 0 rows** | PASS (`rowCount=0`) |
| tenant-b `SELECT` returns only B's row | PASS (`b1`) |
| **no tenant context → 0 rows (fail-closed)** | PASS (`n=0`) |
| **cross-tenant `INSERT` rejected by `WITH CHECK`** | PASS (`new row violates row-level security policy`) |
| own-tenant `INSERT` succeeds | PASS |

The three bold rows are exactly the cross-tenant paths the application-level
Prisma extension **cannot** cover (primary-key lookup, missing filter, write of a
foreign `tenant_id`). RLS blocks all of them **at the database**. This is the
empirical confirmation that RLS — not the app extension — is the boundary.

## Validated artifacts (use these verbatim in P4)

Policy + role (the P4 template, confirmed working):
```sql
CREATE ROLE app_rw LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON posts TO app_rw;

ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE posts FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON posts
  USING      (tenant_id = current_setting('app.current_tenant', true))   -- 2-arg → NULL if unset → fail-closed
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true));
```

Per-request context (the P3 wrapper, confirmed working under `app_rw`):
```sql
BEGIN;
SELECT set_config('app.current_tenant', $1, true);   -- transaction-local
-- … queries …
COMMIT;
```

Two confirmed properties worth restating:
- **`current_setting('app.current_tenant', true)`** (the 2-arg form) returns NULL
  when unset, so `tenant_id = NULL` matches nothing → **fail-closed**. (The 1-arg
  form would raise instead — also safe, but noisier.)
- Comparison is **text** (cuid ids); no `::uuid` cast.

## EXPLAIN

```
Seq Scan on posts  (cost=0.00..1.04 rows=1 width=96)
  Filter: ((body IS NOT NULL) AND (tenant_id = current_setting('app.current_tenant'::text, true)))
```

The policy predicate is appended to the query plan automatically. (Seq Scan here
only because the table holds 3 rows; at real volume the `(tenant_id, …)` index
serves it — index discipline per [03](03-rls-as-the-boundary.md) §Performance.)

## Conclusion

P0 is **complete and green**. The recommended mechanism — pool + `tenant_id` +
RLS as the DB-enforced boundary, with transaction-scoped `set_config` — works as
documented on the actual target engine (RDS PostgreSQL 16). The implementation
can proceed to P1 (schema) → P4 (enable RLS) with no remaining unknowns in the
core mechanism.

_Reproduction: the CDK app + `run-spike.js` lived in `tmp/rls-spike-cdk/`
(deleted after the run). Re-create from [06](06-implementation-plan.md) §P0 if
needed._
