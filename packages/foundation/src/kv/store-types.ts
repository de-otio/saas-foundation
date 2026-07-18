/**
 * `KvStore` — a narrow typed record store, sibling to the Cloudflare-compat
 * `KVNamespace` (see `cloudflare-types.ts`).
 *
 * WHY A SIBLING, NOT A WIDENING: `KVNamespace`/`DynamoKv` are the
 * Cloudflare-Workers string-KV shape (`get`/`put`/`delete`/`list`) consumed by
 * the plain string-KV bindings that need nothing more. `KvStore` adds the five
 * atomic primitives the raw-DynamoDB call sites actually require
 * (`putIfAbsent`, `putIfFresher`, `compareAndSet`, `increment`, version-guarded
 * `delete`) plus a single named secondary index (`queryByIndex`). Bolting those
 * onto `KVNamespace` would break its Cloudflare-compat contract and burden the
 * string-KV bindings with methods they never call. Adapters: `MemoryKvStore`
 * (tests), `DynamoKvStore` (AWS), `PostgresKvStore` (Scaleway, sub-path).
 *
 * FROZEN INTERFACE (WS-1 T1). WS-2's scheduler and WS-3.1's `sub` rename build
 * against this signature; changing it after freeze is a cross-plan break. In
 * particular WS-2 consumes
 * `putIfAbsent(key, value, { ttlSeconds, overwriteExpired }) -> KvCasResult`
 * (`.applied`) on the `cron` namespace.
 *
 * Deliberately omits `list`/`scan`, batch, and cross-key transactions — none of
 * the call sites use them.
 */

/** A stored record. `value` is always a JSON-serialisable object. */
export interface KvRecord<T> {
  readonly value: T;
  /**
   * Optimistic-concurrency token. Monotonically increasing per key; starts at 1
   * on create. `compareAndSet`/`delete` match against it. Adapters guarantee a
   * write bumps it by exactly 1. Opaque to callers except for equality.
   */
  readonly version: number;
  /** Absolute expiry, epoch seconds. Absent = no expiry. */
  readonly expiresAt?: number;
}

export interface KvWriteOptions {
  /** Relative TTL from now, seconds. Mutually exclusive with `expiresAt`. */
  readonly ttlSeconds?: number;
  /** Absolute expiry, epoch seconds. */
  readonly expiresAt?: number;
  /**
   * Value for the single named secondary index (see `queryByIndex`). Only
   * `refresh-detection` (session rows -> `u#<userId>`) sets this today.
   */
  readonly indexedKey?: string;
}

export interface KvCasResult<T> {
  /** True iff this write won (version matched / key was absent as required). */
  readonly applied: boolean;
  /** The current live record AFTER the attempt (the winner's, on conflict). */
  readonly record: KvRecord<T> | null;
}

/**
 * Field-identifier pattern for `increment` (security F3). A bare identifier —
 * no path segments, no `__proto__`, no dots. Both adapters validate `field`
 * against this and throw a `TypeError` on violation, guarding the Postgres
 * `jsonb_set` path (and DynamoDB attribute path) from document corruption even
 * though parameterization already precludes injection.
 */
export const KV_FIELD_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/**
 * The frozen set of `KvStore` namespaces (WS-1 T1 / X1). `cron` is the
 * single-fire lock namespace WS-2's in-process scheduler consumes via
 * `putIfAbsent(cronKey, { firedAt }, { ttlSeconds, overwriteExpired: true })`.
 * `ratelimit` is intentionally NOT here — the token bucket uses a dedicated
 * single-statement limiter, not `KvStore` (see rate-limit module).
 */
export const KV_NAMESPACES = [
  "costtrack",
  "costbudget",
  "discexposure",
  "invitations",
  "idem",
  "claims",
  "agent-refresh",
  "device",
  "job",
  "cron",
] as const;

export type KvNamespaceName = (typeof KV_NAMESPACES)[number];

/**
 * Narrow typed record store. Superset of the get/put/delete a plain KV needs,
 * plus the five atomic primitives the trellis raw-DynamoDB call sites require
 * (putIfAbsent, putIfFresher, compareAndSet, increment, version-guarded delete;
 * see ws1-kv-port-plan §1). Deliberately omits list/scan/batch/cross-key txns.
 *
 * Every method is namespaced: an instance is bound to one `(table, namespace)`
 * and every key is implicitly prefixed. Mirrors `DynamoKv`'s namespace model.
 *
 * ## Atomicity contract
 * - `putIfAbsent`, `putIfFresher`, `compareAndSet`, `delete(expectedVersion)`,
 *   and `increment` are each a SINGLE atomic operation against the backing
 *   store. Concurrent callers see linearizable results on a single key.
 * - `get` is TTL-expiry-aware: an entry past `expiresAt` returns `null` even if
 *   the backend has not physically deleted it (matches every trellis module's
 *   belt-and-suspenders on-read expiry check).
 * - There is NO cross-key atomicity. Multi-row invariants (e.g.
 *   refresh-detection's session-row + JTI-row pair) are the caller's to
 *   sequence, exactly as today (two separate writes).
 *
 * ## Injectable clock (frozen-clock default)
 * Every adapter constructor takes an optional `now?: () => number` (epoch ms,
 * default `Date.now`). ALL TTL/expiry decisions — set-once TTL, `get` expiry
 * filtering, `putIfAbsent({overwriteExpired})`, `putIfFresher` — resolve `now`
 * through this clock, never a bare `Date.now()`. Required for deterministic
 * expiry tests here AND for WS-2's scheduler test, which freezes the clock to
 * assert single-fire lock semantics.
 *
 * ## Key safety (F4)
 * A `key` MUST NOT contain the adapter's pk separator (`:` or `#`, per the
 * namespace layout). The DynamoDB adapter builds a single-string pk
 * (`prefix + sep + key`), so an embedded separator could theoretically collide
 * across namespaces; adapters reject such keys with a `TypeError`.
 *
 * ## Error / logging discipline (F12)
 * Adapter errors carry the namespace and operation, NEVER the raw key/value —
 * device codes, JTIs, and user-code hashes are secrets.
 */
export interface KvStore {
  get<T>(key: string, opts?: { readonly consistent?: boolean }): Promise<KvRecord<T> | null>;

  /** Unconditional overwrite. Returns the written record (version bumped). */
  put<T>(key: string, value: T, opts?: KvWriteOptions): Promise<KvRecord<T>>;

  /**
   * Create-once. `applied=false` if a live record already exists.
   * An expired-but-uncleaned record is treated as absent and overwritten
   * (F1) — this is uniform for both the plain and `overwriteExpired` paths.
   * `overwriteExpired` is kept in the signature as an explicit intent marker
   * (the lock/cron *wants* expired takeover) and for WS-2's frozen call shape.
   */
  putIfAbsent<T>(
    key: string,
    value: T,
    opts?: KvWriteOptions & { readonly overwriteExpired?: boolean },
  ): Promise<KvCasResult<T>>;

  /**
   * Optimistic write. Applies iff the current version === `expectedVersion`
   * (use `0` to require absence). Covers every `attribute_exists AND status=:x`
   * transition (read the record, branch in pure code, CAS on its version).
   */
  compareAndSet<T>(
    key: string,
    expectedVersion: number,
    value: T,
    opts?: KvWriteOptions,
  ): Promise<KvCasResult<T>>;

  /**
   * TTL-monotonic conditional put (claims-cache freshness guard, F2). Writes iff
   * the key is absent OR `opts.expiresAt` is STRICTLY NEWER than the stored
   * `expiresAt`. A SINGLE atomic write — this is NOT `compareAndSet` on version;
   * version-CAS would let a stale, possibly higher-privilege claims write win
   * after a tenant-removal invalidation. `applied=false` means a fresher entry
   * already exists (swallowed by the caller — best-effort cache).
   */
  putIfFresher<T>(
    key: string,
    value: T,
    opts: KvWriteOptions & { readonly expiresAt: number },
  ): Promise<KvCasResult<T>>;

  /**
   * Atomic numeric add on a top-level field of the stored record. Creates the
   * record `{ [field]: delta }` if absent. TTL is SET-ONCE (only on the
   * creating write, matching `if_not_exists(#ttl, :ttl)`). Returns the
   * post-increment value of `field`. Also bumps the version so a concurrent
   * `compareAndSet` on the same row observes the change.
   *
   * `field` MUST match {@link KV_FIELD_PATTERN}; both adapters throw a
   * `TypeError` on violation (F3).
   */
  increment(key: string, field: string, delta: number, opts?: KvWriteOptions): Promise<number>;

  /** Unconditional delete, or version-guarded when `expectedVersion` given. */
  delete(key: string, expectedVersion?: number): Promise<boolean>;

  /**
   * The single named secondary-index lookup. Returns all live (non-expired)
   * records in this namespace whose `indexedKey` equals `indexValue`. Covers
   * `QueryCommand IndexName:"gsi1"` (refresh-detection). No pagination — the one
   * caller lists an agent's sessions (bounded, small).
   */
  queryByIndex<T>(
    indexValue: string,
  ): Promise<ReadonlyArray<KvRecord<T> & { readonly key: string }>>;
}
