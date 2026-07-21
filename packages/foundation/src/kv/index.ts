/**
 * `@de-otio/saas-foundation/kv` — DynamoDB-backed KVNamespace shim.
 *
 * Primary exports:
 * - `DynamoKv` — Cloudflare KVNamespace interface over a DynamoDB table.
 * - `KVNamespace` — the Cloudflare-compat interface type.
 * - `MemoryKv` — in-memory shim for tests (@beta-test-only).
 * - `KvStore` — the typed atomic-primitive store (sibling port) + its adapters.
 * - Error types: `KvNotFoundError`, `KvTransientError`, `KvCursorError`.
 * - Client factory: `createDefaultDynamoClient`.
 */

export { DynamoKv } from "./dynamo-kv.js";
export type { KvNamespaceOptions } from "./dynamo-kv.js";

export type { KVNamespace, KvPutOptions, KvListOptions, KvListResult } from "./cloudflare-types.js";

export { MemoryKv } from "./memory.js";

// KvStore — the typed atomic-primitive store (WS-1 T1 frozen interface).
export type {
  KvStore,
  KvRecord,
  KvWriteOptions,
  KvCasResult,
  KvNamespaceName,
} from "./store-types.js";
export { KV_NAMESPACES, KV_FIELD_PATTERN } from "./store-types.js";

export { MemoryKvStore } from "./memory-kv-store.js";
export type { MemoryKvStoreOptions } from "./memory-kv-store.js";

export { DynamoKvStore } from "./dynamo-kv-store.js";
export type { DynamoKvLayout, DynamoKvStoreOptions } from "./dynamo-kv-store.js";

export { KvNotFoundError, KvTransientError, KvCursorError } from "./errors.js";

export { createDefaultDynamoClient } from "./clients.js";

export { CursorKeySchema } from "./schemas.js";
export type { CursorKey } from "./schemas.js";
