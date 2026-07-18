---
"@de-otio/saas-foundation": minor
---

Add the `KvStore` typed atomic-primitive port + adapters (WS-1 KV port)

A sibling to the Cloudflare-compat `KVNamespace`, `KvStore` adds the atomic
primitives the raw-DynamoDB call sites need: `get` (TTL-aware, optionally
strongly-consistent or `includeExpired`), `put`, `putIfAbsent`
(expired-as-absent), `putIfFresher` (TTL-monotonic freshness), `compareAndSet`,
`increment` (server-side add, field-identifier validated), version-guarded
`delete`, and `queryByIndex`. All additive/non-breaking.

Adapters: `MemoryKvStore` (tests), `DynamoKvStore` (AWS reference, byte-compat
layout-parameterized, `allowSeparatorInKey` for composite keys), and — behind
the new `@de-otio/saas-foundation/kv/postgres` sub-path so no `pg`/SQL surface
leaks into the core `kv` barrel — `PostgresKvStore` + `SqlExecutor` +
`sweepExpiredKvEntries`. Also adds `PostgresTokenBucketLimiter` to the
`rate-limit` module (raw-SQL sibling of the Dynamo limiter, bounded-retry
fail-open, F5). A shared adapter-contract suite proves all three adapters
behaviourally identical, incl. real-concurrency lanes on DynamoDB/Postgres.

Coordinated with the `@de-otio/vestibulum` minor bump in the same release
window (single-owner publish, EXECUTION-COORDINATION X3).
