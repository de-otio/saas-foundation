/**
 * `SecretCache` — in-process LRU + per-entry TTL cache for resolved
 * secret plaintext.
 *
 * Per doc/foundation/03-secrets.md and review S-Sec1: values are stored
 * as `Buffer` instances (not JS strings) so that on eviction the cache
 * can overwrite the underlying bytes with `buf.fill(0)`. This is a
 * best-effort defence-in-depth measure — JavaScript garbage collection
 * is non-deterministic, so:
 *
 *   - until the Buffer is GC'd, an old reference may still point at the
 *     original bytes;
 *   - an attacker with arbitrary read on the process can scrape the
 *     live cache directly.
 *
 * The only secure-erase guarantee this class offers is "eviction zeroes
 * the buffer the cache owns." Consumers MUST NOT treat the cache as a
 * substitute for limiting RCE blast radius or rotating credentials on
 * exposure.
 *
 * Time is injected via `clock: () => number` so tests can pin a fixed
 * "now" and verify TTL invariants without `vi.useFakeTimers()`.
 */

export interface SecretCacheOptions {
  /** Maximum entries before LRU eviction. Defaults to 100. */
  readonly maxEntries?: number;
  /** Per-entry time-to-live in seconds. Defaults to 300 (5 minutes). */
  readonly ttlSeconds?: number;
  /**
   * Injectable monotonic-ish clock returning ms-since-epoch. Defaults
   * to `Date.now`. Tests inject a deterministic source.
   */
  readonly clock?: () => number;
}

interface Entry {
  readonly value: Buffer;
  readonly expiresAt: number;
}

/**
 * Cache key derivation: `(arn, versionId)` for SecretRef-shaped keys.
 * Callers pass an already-derived string key — see `resolveSecret`.
 */
export class SecretCache {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly clock: () => number;
  // Map preserves insertion order in JS; we use that for LRU.
  private readonly entries: Map<string, Entry> = new Map();

  constructor(options?: SecretCacheOptions) {
    this.maxEntries = options?.maxEntries ?? 100;
    this.ttlMs = (options?.ttlSeconds ?? 300) * 1000;
    this.clock = options?.clock ?? Date.now;
  }

  /**
   * Return the cached value, or `null` on miss / expiry. Touches the
   * entry to move it to the LRU "most-recent" position.
   */
  get(key: string): Buffer | null {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt <= this.clock()) {
      // Expired — evict eagerly (and zeroize the buffer).
      this.evictKey(key);
      return null;
    }
    // LRU touch: re-insert to move to end.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /**
   * Store a value. Caller-owned `value` Buffer is taken by reference;
   * the cache will zeroize it on eviction. If the caller needs to
   * retain the bytes after eviction, they MUST pass a copy.
   */
  set(key: string, value: Buffer): void {
    // If replacing an existing entry, zeroize the old value first.
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.entries.delete(key);
      existing.value.fill(0);
    }
    const expiresAt = this.clock() + this.ttlMs;
    this.entries.set(key, { value, expiresAt });
    this.evictOverflow();
  }

  /**
   * Invalidate a single entry. The underlying buffer is zeroized.
   * Returns true if an entry was removed, false otherwise.
   */
  invalidate(key: string): boolean {
    return this.evictKey(key);
  }

  /**
   * Clear every entry, zeroizing each underlying buffer.
   */
  clear(): void {
    for (const entry of this.entries.values()) {
      entry.value.fill(0);
    }
    this.entries.clear();
  }

  /**
   * Internal: returns the current entry count. For tests; not part of
   * the public API surface.
   */
  size(): number {
    return this.entries.size;
  }

  private evictKey(key: string): boolean {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return false;
    }
    entry.value.fill(0);
    this.entries.delete(key);
    return true;
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      // The first key in a Map's iteration is the least-recently-
      // inserted/accessed entry — our LRU victim.
      const oldest = this.entries.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.evictKey(oldest.value);
    }
  }
}
