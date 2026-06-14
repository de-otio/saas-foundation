/**
 * Local declarations of the Cloudflare KVNamespace interface shape.
 *
 * Foundation does not depend on `@cloudflare/workers-types`. These
 * declarations reproduce only the methods used by DynamoKv.
 *
 * The Cloudflare-compat interfaces are refactor affordances — they allow
 * consumers to swap a DynamoDB-backed shim for a real Workers KV binding
 * without changing call sites.
 */

export interface KvPutOptions {
  readonly expiration?: number; // absolute epoch seconds
  readonly expirationTtl?: number; // relative seconds from now
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface KvListOptions {
  readonly prefix?: string;
  readonly limit?: number; // default 1000
  readonly cursor?: string; // opaque, HMAC-signed if cursorSecret is set
}

export interface KvListResult {
  readonly keys: ReadonlyArray<{ readonly name: string; readonly expiration?: number }>;
  readonly list_complete: boolean;
  readonly cursor?: string;
}

/**
 * Subset of the Cloudflare `KVNamespace` interface that DynamoKv implements.
 */
export interface KVNamespace {
  /**
   * Get a value by key.
   *
   * - `get(key)` and `get(key, "text")` return the raw string value.
   * - `get<T>(key, "json")` runs `JSON.parse` on the stored value and
   *   returns `T | null`. Defaults to `unknown` if the caller does not
   *   pin a concrete shape, so misuse forces an explicit narrowing
   *   step. Matches Cloudflare's KV `get<T>(key, "json")` shape.
   */
  get(key: string, type?: "text"): Promise<string | null>;
  get<T = unknown>(key: string, type: "json"): Promise<T | null>;
  getWithMetadata<T>(
    key: string,
  ): Promise<{ readonly value: string | null; readonly metadata: T | null }>;
  put(key: string, value: string | ArrayBuffer, options?: KvPutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: KvListOptions): Promise<KvListResult>;
}
