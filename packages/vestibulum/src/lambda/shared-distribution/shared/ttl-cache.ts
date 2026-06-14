/**
 * Promise-only TTL cache (review fix N2).
 *
 * Always stores the promise in the entry — never an unwrapped value.
 * This eliminates the microtask-ordering race where a caller arriving
 * between promise-resolution and the `.then()` callback would see
 * `undefined` cast to `T`.
 *
 * Concurrent calls for the same key in the same tick share one promise
 * (implicit coalescing: the entry is written before `loader()` settles).
 *
 * On rejection the entry is evicted only when the stored promise is still
 * *this* rejection's promise — prevents a stale rejection from evicting a
 * newer successful load that raced ahead of the eviction.
 */

export interface TtlCacheOptions {
  readonly ttlMs: number;
  /**
   * Injectable clock function for deterministic testing. Defaults to
   * `Date.now`. Tests pass a controlled monotonic clock to avoid
   * timing-sensitive races with the TTL expiry check.
   */
  readonly now?: () => number;
}

interface Entry<T> {
  readonly promise: Promise<T>;
  readonly expiresAt: number;
}

export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor({ ttlMs, now = Date.now }: TtlCacheOptions) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  getOrLoad(key: string, loader: () => Promise<T>): Promise<T> {
    const now = this.now();
    const entry = this.entries.get(key);
    if (entry !== undefined && entry.expiresAt > now) {
      return entry.promise;
    }
    // Cache miss or expired — start a fresh load. Promise-coalescing is
    // implicit: concurrent callers arriving in the same tick all hit the
    // same Promise object because the entry is written synchronously here,
    // before any microtask can run.
    const promise = loader().catch((err: unknown) => {
      // Don't cache failures: if the load rejects, evict so the next
      // caller retries. Check identity first to avoid evicting a newer
      // load that already replaced this entry.
      if (this.entries.get(key)?.promise === promise) {
        this.entries.delete(key);
      }
      throw err;
    });
    this.entries.set(key, { promise, expiresAt: now + this.ttlMs });
    return promise;
  }
}
