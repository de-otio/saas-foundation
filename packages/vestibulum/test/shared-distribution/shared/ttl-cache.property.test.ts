/**
 * Property-based tests for TtlCache (review fix N2).
 *
 * Spec: doc/vestibulum/shared-distribution/06-trigger-handlers.md § TtlCache helper.
 *
 * Properties tested:
 * - Same key within TTL → single loader invocation, all callers get same value.
 * - Same key after TTL → fresh loader invocation.
 * - Concurrent loaders for same key in the same tick → single loader
 *   invocation (promise coalescing); all promises resolve with the same value.
 * - Loader rejects → entry evicted; next call invokes loader again.
 * - Stale rejection does NOT evict a newer load (identity guard).
 *
 * Coverage target: 100 % branch.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TtlCache } from '../../../src/lambda/shared-distribution/shared/ttl-cache.js';

const RUN_OPTIONS = { numRuns: 1000, seed: 0xc0ffee } as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a loader that counts calls and rejects with the given error. */
function makeRejectingLoader(err: Error): { loader: () => Promise<never>; callCount: () => number } {
  let n = 0;
  return {
    loader: () => {
      n++;
      return Promise.reject(err);
    },
    callCount: () => n,
  };
}

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('TtlCache — property tests (fast-check, seed 0xc0ffee)', () => {
  it('same key within TTL → single loader call, consistent value', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 2, max: 16 }),
        async (key, ttlMs, value, concurrency) => {
          // Freeze the clock. With the real Date.now default and a generated
          // ttlMs as small as 1 ms, a slow runner (coverage instrumentation)
          // can cross the TTL between the synchronous getOrLoad calls below,
          // forcing a second loader call — a wall-clock flake (seen in CI).
          // A frozen clock keeps every call strictly within the TTL window,
          // which is exactly the property under test.
          const cache = new TtlCache<number>({ ttlMs, now: () => 1_000_000 });
          let callCount = 0;
          const loader = () => {
            callCount++;
            return Promise.resolve(value);
          };
          // All calls happen within the same synchronous tick → same promise.
          const promises = Array.from({ length: concurrency }, () =>
            cache.getOrLoad(key, loader),
          );
          const results = await Promise.all(promises);
          // Single loader invocation despite multiple callers.
          expect(callCount).toBe(1);
          // All results are the same value.
          for (const r of results) {
            expect(r).toBe(value);
          }
        },
      ),
      RUN_OPTIONS,
    );
  });

  it('same key after TTL expiry → fresh loader call', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.integer({ min: 100, max: 500 }),
        fc.integer({ min: 1, max: 10_000 }),
        async (key, value, ttlMs) => {
          // Use an injectable clock so expiry is deterministic — no real sleeping.
          let fakeNow = 1_000_000;
          const cache = new TtlCache<number>({ ttlMs, now: () => fakeNow });
          let callCount = 0;
          const loader = () => {
            callCount++;
            return Promise.resolve(value);
          };

          // First load.
          const r1 = await cache.getOrLoad(key, loader);
          expect(r1).toBe(value);
          expect(callCount).toBe(1);

          // Advance the clock past the TTL without any real-time sleep.
          fakeNow += ttlMs + 1;

          // Second load (TTL expired).
          const r2 = await cache.getOrLoad(key, loader);
          expect(r2).toBe(value);
          expect(callCount).toBe(2);
        },
      ),
      RUN_OPTIONS, // Full 1000 runs — no real sleeps needed.
    );
  });

  it('loader rejects → entry evicted; next call invokes loader again', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }),
        async (key) => {
          const cache = new TtlCache<string>({ ttlMs: 60_000 });
          const err = new Error('transient DDB error');
          const { loader, callCount } = makeRejectingLoader(err);

          // First call: should reject.
          await expect(cache.getOrLoad(key, loader)).rejects.toThrow('transient DDB error');
          expect(callCount()).toBe(1);

          // Second call: entry should have been evicted; loader is called again.
          await expect(cache.getOrLoad(key, loader)).rejects.toThrow('transient DDB error');
          expect(callCount()).toBe(2);
        },
      ),
      RUN_OPTIONS,
    );
  });

  it('concurrent loaders for same key → single loader, all resolve same value', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.integer({ min: 0, max: 9999 }),
        async (key, value) => {
          const cache = new TtlCache<number>({ ttlMs: 60_000 });
          let callCount = 0;
          const loader = () => {
            callCount++;
            return Promise.resolve(value);
          };
          // Fire concurrently in same synchronous batch.
          const [a, b, c] = await Promise.all([
            cache.getOrLoad(key, loader),
            cache.getOrLoad(key, loader),
            cache.getOrLoad(key, loader),
          ]);
          expect(callCount).toBe(1);
          expect(a).toBe(value);
          expect(b).toBe(value);
          expect(c).toBe(value);
        },
      ),
      RUN_OPTIONS,
    );
  });

  it('stale rejection does NOT evict a newer load (identity guard)', async () => {
    // The identity guard `this.entries.get(key)?.promise === promise` prevents
    // a stale rejection's .catch() from evicting an entry that was replaced
    // by a subsequent load.
    //
    // Test strategy:
    //  1. Start a load with a pending (not-yet-settled) loader for key.
    //  2. Advance the injected clock past the TTL — entry is logically expired
    //     but still present (it only gets evicted on next getOrLoad).
    //  3. Start a second load (TTL expired) — the second loader replaces the entry.
    //  4. Reject the FIRST loader's promise — identity guard sees it no longer
    //     matches the current entry, so it does NOT evict.
    //  5. Verify p2 still resolves (entry was not evicted by step 4).

    let fakeNow = 1_000_000;
    const cache = new TtlCache<string>({ ttlMs: 100, now: () => fakeNow });
    const key = 'identity-guard-key';

    // --- Step 1: first call → pending loader ---
    let rejectFirst!: (e: unknown) => void;
    const firstLoaderPromise = new Promise<string>((_res, rej) => {
      rejectFirst = rej;
    });

    const p1 = cache.getOrLoad(key, () => firstLoaderPromise);

    // --- Step 2: advance clock past TTL ---
    fakeNow += 200; // well past the 100 ms TTL

    // --- Step 3: second call (TTL expired) → successful loader ---
    let secondCallCount = 0;
    const p2 = cache.getOrLoad(key, () => {
      secondCallCount++;
      return Promise.resolve('new-value');
    });

    // --- Step 4: now reject the FIRST loader ---
    // Its .catch() fires but the entry has been replaced by p2's promise —
    // the identity guard prevents eviction.
    rejectFirst(new Error('stale error'));

    // p1 should reject.
    await expect(p1).rejects.toThrow('stale error');

    // p2 should resolve because its entry was NOT evicted by p1's rejection.
    const r2 = await p2;
    expect(r2).toBe('new-value');
    expect(secondCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for branch coverage
// ---------------------------------------------------------------------------

describe('TtlCache — unit tests (branch coverage)', () => {
  it('returns cached value on second call within TTL', async () => {
    const cache = new TtlCache<string>({ ttlMs: 60_000 });
    let n = 0;
    const loader = () => Promise.resolve(`val-${++n}`);

    const r1 = await cache.getOrLoad('k', loader);
    const r2 = await cache.getOrLoad('k', loader);
    expect(r1).toBe('val-1');
    expect(r2).toBe('val-1');
    expect(n).toBe(1);
  });

  it('returns new value after TTL expires', async () => {
    let fakeNow = 0;
    const cache = new TtlCache<string>({ ttlMs: 100, now: () => fakeNow });
    let n = 0;
    const loader = () => Promise.resolve(`val-${++n}`);

    await cache.getOrLoad('k', loader);
    fakeNow += 200; // advance past the 100 ms TTL
    const r2 = await cache.getOrLoad('k', loader);
    expect(r2).toBe('val-2');
    expect(n).toBe(2);
  });

  it('null is a valid cached value (not treated as cache miss)', async () => {
    const cache = new TtlCache<string | null>({ ttlMs: 60_000 });
    let n = 0;
    const loader = () => {
      n++;
      return Promise.resolve(null);
    };

    const r1 = await cache.getOrLoad('k', loader);
    const r2 = await cache.getOrLoad('k', loader);
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(n).toBe(1);
  });

  it('different keys are cached independently', async () => {
    const cache = new TtlCache<string>({ ttlMs: 60_000 });
    const counts: Record<string, number> = {};
    const loader = (key: string) => () => {
      counts[key] = (counts[key] ?? 0) + 1;
      return Promise.resolve(`${key}-value`);
    };

    const r1 = await cache.getOrLoad('a', loader('a'));
    const r2 = await cache.getOrLoad('b', loader('b'));
    const r3 = await cache.getOrLoad('a', loader('a'));
    expect(r1).toBe('a-value');
    expect(r2).toBe('b-value');
    expect(r3).toBe('a-value');
    expect(counts['a']).toBe(1);
    expect(counts['b']).toBe(1);
  });

  it('error evicts entry so the next call retries', async () => {
    const cache = new TtlCache<string>({ ttlMs: 60_000 });
    let n = 0;
    const err = new Error('boom');
    const loader = () => {
      n++;
      if (n === 1) return Promise.reject(err);
      return Promise.resolve('ok');
    };

    await expect(cache.getOrLoad('k', loader)).rejects.toBe(err);
    expect(n).toBe(1);
    const r = await cache.getOrLoad('k', loader);
    expect(r).toBe('ok');
    expect(n).toBe(2);
  });

  it('getOrLoad is synchronous up to the first await (entry written before settle)', async () => {
    const cache = new TtlCache<string>({ ttlMs: 60_000 });
    let n = 0;
    let resolveFirst!: (v: string) => void;
    const firstPromise = new Promise<string>((res) => {
      resolveFirst = res;
    });
    const slowLoader = () => {
      n++;
      return firstPromise;
    };

    // Both calls are dispatched before either settles.
    const p1 = cache.getOrLoad('k', slowLoader);
    const p2 = cache.getOrLoad('k', slowLoader);

    expect(n).toBe(1); // only one loader call dispatched

    resolveFirst('value');
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('value');
    expect(r2).toBe('value');
    expect(n).toBe(1);
  });
});
