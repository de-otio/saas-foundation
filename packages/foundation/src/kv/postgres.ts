/**
 * `@de-otio/saas-foundation/kv/postgres` — the Postgres `KvStore` adapter,
 * quarantined behind a sub-path so the core `kv` barrel stays free of any
 * SQL/`pg` surface (mirrors the `audit/prisma` precedent). Import ONLY via this
 * sub-path:
 *
 *   import { PostgresKvStore, sweepExpiredKvEntries } from "@de-otio/saas-foundation/kv/postgres";
 */

export { PostgresKvStore, sweepExpiredKvEntries } from "./postgres-kv-store.js";
export type { SqlExecutor, PostgresKvStoreOptions } from "./postgres-kv-store.js";
