# 04 — Connection pooling, resolved

The one interaction that needs care, with a documented answer. The earlier
analysis called this the "biggest risk" and a required "spike." It is neither —
it is a known problem with a standard, widely-deployed solution.

## The problem in one sentence

RLS reads the tenant from a session variable (`app.current_tenant`) on the
connection; with connection pooling a single physical connection is reused across
many requests/tenants, so **the tenant context must be scoped so it cannot
outlive the request and bleed to the next user of that connection.**

## The solution: transaction-scoped context

Set the tenant with the **transaction-local** form, **inside a transaction** that
also runs the request's queries:

```sql
BEGIN;
SELECT set_config('app.current_tenant', $1, true);   -- is_local = true  (== SET LOCAL)
-- ... all of this request's queries ...
COMMIT;                                                -- setting auto-resets here
```

- `set_config(name, value, is_local => true)` is the function form of `SET
  LOCAL`: the value lives **only until the transaction ends**, then resets
  automatically.
- Because the setting is gone by `COMMIT`/`ROLLBACK`, the connection returns to
  the pool **clean** — it cannot leak the previous tenant to the next request.
- This is the pattern every primary source converges on:
  > "Use transaction-scoped `set_config`; if you use PgBouncer in transaction
  > mode, set the third parameter to `true`." … "with connection pooling, set it
  > at the start of each transaction, not per-connection."

## How this maps onto the poolers

### PgBouncer (the time-tested Postgres pooler)
PgBouncer's feature table lists session-level **`SET`/`RESET` as "Never"
compatible with transaction-pooling mode** — *because session-level `SET`
persists on the connection past the transaction and would leak when the
connection is returned to the pool.* That warning is about **session** `SET`.
The three modes:

| Mode | Tenant GUC behavior | Use for RLS? |
| --- | --- | --- |
| **session** | A client holds a connection for its whole session; session-level `SET` works but multiplexing is minimal. | Works, but least scalable. |
| **transaction** | Connection assigned per *transaction*, returned at `COMMIT`. Session-level `SET` is unsafe ("Never") — but **`SET LOCAL`/`set_config(...,true)` is safe** because it is part of the transaction and already reset before the connection is returned. | **Yes — the recommended mode**, with the transaction-scoped GUC above. |
| **statement** | No multi-statement transactions. RLS context (even `SET LOCAL`) cannot be reliably maintained — *will* return wrong-tenant rows under concurrency. | **No. Never use statement mode with RLS.** |

So the supported, scalable configuration is **PgBouncer in transaction mode +
transaction-scoped `set_config`**.

### RDS Proxy (AWS's managed pooler) — the limitation to know
For **RDS for PostgreSQL**, RDS Proxy **pins** the client connection on any
`SET`/`set_config` (the PostgreSQL pinning list has **no `SET LOCAL` exemption** —
that exemption exists only for MySQL). A pinned connection stops multiplexing
until the client connection ends. So RDS Proxy + GUC-based RLS largely defeats the
purpose of RDS Proxy.

**Implication:** do **not** put the RLS workload behind RDS Proxy expecting
multiplexing. Use **PgBouncer in transaction mode**, or the application's own
in-process pool, for the tenant-scoped path. (If RDS Proxy is wanted for other
workloads — e.g. failover handling for non-tenant-scoped/system connections —
keep them on a separate path.)

## Where trellis is today, and the concrete change

- **Today: no external pooler.** `database-connection-manager` holds an
  in-process `pg.Pool` (per region) straight to RDS. In this topology the
  transaction-scoped GUC works immediately — each request checks out a
  connection, runs its transaction with `set_config(...,true)` first, and the
  setting resets at `COMMIT`. **RLS can ship now without any pooler decision.**
- **The seam change:** trellis currently runs queries individually via
  `executeWithRetry(...)` (not wrapped in a per-request transaction). RLS-via-GUC
  requires that the tenant context and the queries share a transaction. So the
  data-access layer needs a **tenant-scoped transaction wrapper**:

  ```ts
  // sketch — runs the request's DB work in one transaction with the tenant GUC set
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return work(tx);                       // all queries here are RLS-scoped
  });
  ```

  This wrapper lives where `getCurrentTenantId()` is available (the WS1 ambient
  tenant) and is the single place that establishes DB-level tenant context. It
  composes cleanly with PgBouncer transaction mode if/when a pooler is added.

- **Future pooler choice:** when trellis outgrows the in-process pool (the
  `scaling-health.ts` ">8 tasks" threshold), choose **PgBouncer transaction
  mode**, not RDS Proxy, for the tenant-scoped path — precisely because of the
  pinning limitation above. This is now a *decided* design point, not an open
  spike.

## Robustness ranking of the options (most to least)

1. **Transaction-scoped `set_config` + PgBouncer transaction mode (or in-process
   pool).** Documented, scalable, leak-safe. ← chosen
2. Session-mode pooling + session `SET`. Correct but least scalable (≈ connection
   per active session).
3. RDS Proxy + GUC. Correct but pins → loses multiplexing. Avoid for this
   workload.
4. Statement-mode pooling. **Unsafe with RLS — excluded.**

## Net

The pooling question has a boring, documented answer: **set the tenant with
`set_config(..., true)` inside the request's transaction.** It is leak-safe by
construction (transaction-local), works with the standard Postgres pooler
(PgBouncer transaction mode) and with trellis's current in-process pool, and the
only "gotcha" (RDS Proxy pinning PostgreSQL `SET`) is handled by simply not using
RDS Proxy for the tenant-scoped path. No experimental behavior, no unresolved
risk.

## Sources
- PgBouncer — *Features / pooling modes*: https://www.pgbouncer.org/features.html
- AWS RDS — *Avoiding pinning an RDS Proxy* (PostgreSQL `SET` pins; no `SET LOCAL`
  exemption for PG):
  https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-pinning.html
- PostgreSQL — `set_config(setting, value, is_local)`:
  https://www.postgresql.org/docs/current/functions-admin.html
- Corroborating production write-ups: pganalyze (*Postgres RLS in Rails*),
  Picus Security Engineering (*DB-level multi-tenancy with RLS*), ClickHouse
  (*multi-tenant SaaS on Postgres*), ricofritzsche (*Mastering Postgres RLS for
  multi-tenancy*) — all specify transaction-scoped `set_config`/`SET LOCAL` under
  PgBouncer transaction mode.
