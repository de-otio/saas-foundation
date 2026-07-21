/**
 * Shared adapter-contract suite for `KvStore` (ws1-kv-port-plan §6.1.2).
 *
 * ONE spec, run against every adapter (`MemoryKvStore`, `DynamoKvStore`,
 * `PostgresKvStore`) so all three are proven behaviourally identical. Callers
 * provide an `AdapterUnderTest` that mints a FRESH, isolated store bound to an
 * injected clock. Time is driven through the injected clock (no real `Date`,
 * per the repo's determinism lint rule).
 *
 * The concurrency cases (`Promise.all` of N writers) are simulated on the
 * single-threaded MemoryKvStore but exercise real row-lock atomicity on the
 * DynamoDB/Postgres lanes (security F11) — the same test code, both lanes.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { KvStore } from "../../src/kv/store-types.js";

/** Deterministic frozen epoch: 2023-11-14T22:13:20Z. */
export const FROZEN_EPOCH_S = 1_700_000_000;
const FROZEN_EPOCH_MS = FROZEN_EPOCH_S * 1000;

/** A controllable clock (epoch ms) for frozen-clock expiry tests. */
export interface TestClock {
  readonly now: () => number;
  /** Advance the clock forward by `seconds`. */
  advanceSeconds(seconds: number): void;
}

export function makeClock(startMs: number = FROZEN_EPOCH_MS): TestClock {
  let t = startMs;
  return {
    now: () => t,
    advanceSeconds: (seconds: number) => {
      t += seconds * 1000;
    },
  };
}

export interface AdapterUnderTest {
  readonly name: string;
  /**
   * Mint a fresh, isolated store bound to `now`. `indexed: true` returns a
   * store whose layout carries the single secondary index (`queryByIndex`).
   */
  make(now: () => number, opts?: { readonly indexed?: boolean }): Promise<KvStore>;
  /** fast-check runs for the property tests (dynamo/postgres lanes lower this). */
  readonly propertyRuns?: number;
}

interface Counter {
  readonly [field: string]: unknown;
}

export function runKvStoreContract(adapter: AdapterUnderTest): void {
  const runs = adapter.propertyRuns ?? 50;

  describe(`${adapter.name} — get / put`, () => {
    it("get returns null on miss", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      expect(await store.get("missing")).toBeNull();
    });

    it("put then get round-trips the value at version 1", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      const written = await store.put("k", { a: 1, b: "x" });
      expect(written.version).toBe(1);
      const got = await store.get<{ a: number; b: string }>("k");
      expect(got).not.toBeNull();
      expect(got?.value).toEqual({ a: 1, b: "x" });
      expect(got?.version).toBe(1);
    });

    it("put overwrites and bumps version by exactly 1", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      await store.put("k", { n: 1 });
      const second = await store.put("k", { n: 2 });
      expect(second.version).toBe(2);
      const got = await store.get<{ n: number }>("k");
      expect(got?.value).toEqual({ n: 2 });
      expect(got?.version).toBe(2);
    });

    it("stored value is not aliased to the caller's object", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      const input = { n: 1 };
      await store.put("k", input);
      input.n = 999;
      const got = await store.get<{ n: number }>("k");
      expect(got?.value).toEqual({ n: 1 });
    });
  });

  describe(`${adapter.name} — TTL expiry (frozen clock)`, () => {
    it("get returns the value before its ttl elapses", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      await store.put("k", { v: 1 }, { ttlSeconds: 100 });
      clock.advanceSeconds(50);
      expect(await store.get("k")).not.toBeNull();
    });

    it("get returns null once the ttl has elapsed (expired-on-read)", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      await store.put("k", { v: 1 }, { ttlSeconds: 100 });
      clock.advanceSeconds(101);
      expect(await store.get("k")).toBeNull();
    });

    it("absolute expiresAt is honoured", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      await store.put("k", { v: 1 }, { expiresAt: FROZEN_EPOCH_S + 30 });
      clock.advanceSeconds(31);
      expect(await store.get("k")).toBeNull();
    });

    it("includeExpired returns an expired-but-uncleaned record (TTL-ignoring read)", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      await store.put("k", { v: 7 }, { ttlSeconds: 100 });
      clock.advanceSeconds(101);
      // Default read filters the expired row...
      expect(await store.get("k")).toBeNull();
      // ...but includeExpired still yields the last-known value (getActiveTenantPreference).
      const got = await store.get<{ v: number }>("k", { includeExpired: true });
      expect(got?.value).toEqual({ v: 7 });
    });

    it("includeExpired still returns null when the key never existed", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      expect(await store.get("missing", { includeExpired: true })).toBeNull();
    });
  });

  describe(`${adapter.name} — putIfAbsent`, () => {
    it("first create applies at version 1; second is rejected with the winner's record", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      const first = await store.putIfAbsent("k", { who: "a" });
      expect(first.applied).toBe(true);
      expect(first.record?.version).toBe(1);

      const second = await store.putIfAbsent("k", { who: "b" });
      expect(second.applied).toBe(false);
      // The live record is the winner's ("a"), NOT overwritten by "b".
      expect(second.record?.value).toEqual({ who: "a" });
    });

    it("treats an expired-but-unswept row as absent (F1) and bumps version on takeover", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      const first = await store.putIfAbsent("k", { who: "a" }, { ttlSeconds: 10 });
      expect(first.applied).toBe(true);
      clock.advanceSeconds(11);
      const second = await store.putIfAbsent("k", { who: "b" }, { ttlSeconds: 10 });
      expect(second.applied).toBe(true);
      expect(second.record?.value).toEqual({ who: "b" });
      // Version bumped past the crashed holder's (lock-token uniqueness).
      expect(second.record?.version).toBe(2);
    });

    it("overwriteExpired is an intent marker (same expired-as-absent behaviour)", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      await store.putIfAbsent("lock", { holder: "a" }, { ttlSeconds: 10, overwriteExpired: true });
      clock.advanceSeconds(11);
      const takeover = await store.putIfAbsent(
        "lock",
        { holder: "b" },
        { ttlSeconds: 10, overwriteExpired: true },
      );
      expect(takeover.applied).toBe(true);
      expect(takeover.record?.value).toEqual({ holder: "b" });
    });
  });

  describe(`${adapter.name} — compareAndSet`, () => {
    it("create via expectedVersion 0 on an absent key applies at version 1", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      const res = await store.compareAndSet("k", 0, { s: "new" });
      expect(res.applied).toBe(true);
      expect(res.record?.version).toBe(1);
    });

    it("applies on a matching version and bumps by 1", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      const created = await store.put("k", { s: "v1" });
      const res = await store.compareAndSet("k", created.version, { s: "v2" });
      expect(res.applied).toBe(true);
      expect(res.record?.version).toBe(created.version + 1);
      expect(res.record?.value).toEqual({ s: "v2" });
    });

    it("rejects on a stale version and leaves the live record untouched", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      const created = await store.put("k", { s: "v1" });
      const res = await store.compareAndSet("k", created.version + 7, { s: "bad" });
      expect(res.applied).toBe(false);
      expect(res.record?.value).toEqual({ s: "v1" });
      expect(res.record?.version).toBe(created.version);
    });

    it("expectedVersion 0 is rejected when a live record exists", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      await store.put("k", { s: "v1" });
      const res = await store.compareAndSet("k", 0, { s: "v2" });
      expect(res.applied).toBe(false);
    });
  });

  describe(`${adapter.name} — putIfFresher (F2 monotonic freshness)`, () => {
    it("writes when absent", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      const res = await store.putIfFresher("k", { c: 1 }, { expiresAt: FROZEN_EPOCH_S + 100 });
      expect(res.applied).toBe(true);
      expect(res.record?.expiresAt).toBe(FROZEN_EPOCH_S + 100);
    });

    it("accepts a strictly-newer expiry", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      await store.putIfFresher("k", { c: 1 }, { expiresAt: FROZEN_EPOCH_S + 100 });
      const res = await store.putIfFresher("k", { c: 2 }, { expiresAt: FROZEN_EPOCH_S + 200 });
      expect(res.applied).toBe(true);
      expect(res.record?.value).toEqual({ c: 2 });
      expect(res.record?.expiresAt).toBe(FROZEN_EPOCH_S + 200);
    });

    it("rejects an older-or-equal expiry (stale write can never win)", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      await store.putIfFresher("k", { c: 1 }, { expiresAt: FROZEN_EPOCH_S + 200 });
      const older = await store.putIfFresher("k", { c: 2 }, { expiresAt: FROZEN_EPOCH_S + 100 });
      expect(older.applied).toBe(false);
      const equal = await store.putIfFresher("k", { c: 3 }, { expiresAt: FROZEN_EPOCH_S + 200 });
      expect(equal.applied).toBe(false);
      // Stored value/expiry is still the first (fresher) write.
      const got = await store.get<{ c: number }>("k");
      expect(got?.value).toEqual({ c: 1 });
      expect(got?.expiresAt).toBe(FROZEN_EPOCH_S + 200);
    });

    it("tenant-removal regression: a stale higher-privilege write is rejected after an invalidation", async () => {
      // F2: claims written with a fresh (newer) expiry after a tenant removal
      // must not be clobbered by a stale, longer-lived higher-privilege write.
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      // A stale higher-privilege claim the caller is mid-writing, expiry T+50.
      // The invalidating write already landed with a NEWER expiry T+300.
      await store.putIfFresher("sub", { roles: ["viewer"] }, { expiresAt: FROZEN_EPOCH_S + 300 });
      const stale = await store.putIfFresher(
        "sub",
        { roles: ["tenant-admin"] },
        { expiresAt: FROZEN_EPOCH_S + 50 },
      );
      expect(stale.applied).toBe(false);
      const got = await store.get<{ roles: string[] }>("sub");
      expect(got?.value).toEqual({ roles: ["viewer"] });
    });
  });

  describe(`${adapter.name} — increment`, () => {
    it("creates the field on an absent key and returns the post-value", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      expect(await store.increment("k", "count", 5)).toBe(5);
      const got = await store.get<Counter>("k");
      expect(got?.value).toEqual({ count: 5 });
    });

    it("sums repeated increments", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      await store.increment("k", "count", 3);
      await store.increment("k", "count", 4);
      expect(await store.increment("k", "count", 2)).toBe(9);
    });

    it("bumps version so a concurrent compareAndSet observes the change", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      await store.increment("k", "count", 1);
      const before = await store.get<Counter>("k");
      await store.increment("k", "count", 1);
      const after = await store.get<Counter>("k");
      expect(after!.version).toBe(before!.version + 1);
    });

    it("TTL is set-once (a later increment does not extend expiry)", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      await store.increment("k", "count", 1, { ttlSeconds: 100 });
      const first = await store.get<Counter>("k");
      const firstExpiry = first?.expiresAt;
      clock.advanceSeconds(10);
      await store.increment("k", "count", 1, { ttlSeconds: 100 });
      const second = await store.get<Counter>("k");
      expect(second?.expiresAt).toBe(firstExpiry);
    });

    it("omits TTL entirely when no ttl option is passed (durable counter)", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      await store.increment("k", "count", 1);
      const got = await store.get<Counter>("k");
      expect(got?.expiresAt).toBeUndefined();
    });

    it("rejects a non-identifier field with a TypeError (F3)", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      await expect(store.increment("k", "bad-field", 1)).rejects.toBeInstanceOf(TypeError);
      await expect(store.increment("k", "__proto__", 1)).rejects.toBeInstanceOf(TypeError);
      await expect(store.increment("k", "1leading", 1)).rejects.toBeInstanceOf(TypeError);
      await expect(store.increment("k", "a.b", 1)).rejects.toBeInstanceOf(TypeError);
    });

    it("F12: a field-validation error carries no key or value bytes", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      const secretKey = "device-code-SUPERSECRET";
      try {
        await store.increment(secretKey, "bad-field!", 1);
        throw new Error("expected increment to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(TypeError);
        expect((err as Error).message).not.toContain(secretKey);
        expect((err as Error).message).not.toContain("bad-field!");
      }
    });
  });

  describe(`${adapter.name} — delete`, () => {
    it("unconditional delete removes an existing key and reports true", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      await store.put("k", { v: 1 });
      expect(await store.delete("k")).toBe(true);
      expect(await store.get("k")).toBeNull();
    });

    it("unconditional delete of a missing key reports false", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      expect(await store.delete("missing")).toBe(false);
    });

    it("version-guarded delete succeeds only on the matching version", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      const created = await store.put("k", { v: 1 });
      expect(await store.delete("k", created.version + 5)).toBe(false);
      expect(await store.get("k")).not.toBeNull();
      expect(await store.delete("k", created.version)).toBe(true);
      expect(await store.get("k")).toBeNull();
    });
  });

  describe(`${adapter.name} — queryByIndex`, () => {
    it("returns only the live records whose indexedKey matches", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now, { indexed: true });
      await store.put("s1", { userId: "u1" }, { indexedKey: "u#1" });
      await store.put("s2", { userId: "u1" }, { indexedKey: "u#1" });
      await store.put("s3", { userId: "u2" }, { indexedKey: "u#2" });

      const rows = await store.queryByIndex<{ userId: string }>("u#1");
      expect(rows.map((r) => r.key).sort()).toEqual(["s1", "s2"]);
      expect(rows.every((r) => r.value.userId === "u1")).toBe(true);
    });

    it("excludes expired records from the index", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now, { indexed: true });
      await store.put("s1", { userId: "u1" }, { indexedKey: "u#1", ttlSeconds: 10 });
      await store.put("s2", { userId: "u1" }, { indexedKey: "u#1" });
      clock.advanceSeconds(11);
      const rows = await store.queryByIndex<{ userId: string }>("u#1");
      expect(rows.map((r) => r.key)).toEqual(["s2"]);
    });
  });

  describe(`${adapter.name} — property: increment sum (order independence)`, () => {
    it("final value equals the sum of all deltas", async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(fc.integer({ min: -1000, max: 1000 }), { maxLength: 30 }), async (deltas) => {
          const clock = makeClock();
          const store = await adapter.make(clock.now);
          await Promise.all(deltas.map((d) => store.increment("k", "count", d)));
          const got = await store.get<{ count: number }>("k");
          const expected = deltas.reduce((a, b) => a + b, 0);
          if (deltas.length === 0) {
            expect(got).toBeNull();
          } else {
            expect(got?.value.count).toBe(expected);
          }
        }),
        { numRuns: runs },
      );
    });
  });

  describe(`${adapter.name} — property: compareAndSet version monotonicity`, () => {
    it("N read->CAS writers bump version by exactly the number of applied writes; no shared version", async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (n) => {
          const clock = makeClock();
          const store = await adapter.make(clock.now);
          await store.put("k", { hits: 0 });

          const appliedVersions: number[] = [];
          // Each writer reads then attempts a CAS; contention yields applied:false.
          await Promise.all(
            Array.from({ length: n }, async () => {
              const cur = await store.get<{ hits: number }>("k");
              if (cur === null) return;
              const res = await store.compareAndSet(
                "k",
                cur.version,
                { hits: cur.value.hits + 1 },
              );
              if (res.applied && res.record !== null) appliedVersions.push(res.record.version);
            }),
          );

          const final = await store.get<{ hits: number }>("k");
          // version started at 1 (the put); each applied CAS bumps by 1.
          expect(final?.version).toBe(1 + appliedVersions.length);
          // No two applied writes share a version.
          expect(new Set(appliedVersions).size).toBe(appliedVersions.length);
        }),
        { numRuns: runs },
      );
    });
  });

  describe(`${adapter.name} — property: putIfFresher never regresses expiry`, () => {
    it("stored expiry is the maximum of all accepted writes; lower-after-higher is rejected", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer({ min: 1, max: 10_000 }), { minLength: 1, maxLength: 25 }),
          async (offsets) => {
            const clock = makeClock();
            const store = await adapter.make(clock.now);
            let maxExpiry = 0;
            for (const off of offsets) {
              const expiresAt = FROZEN_EPOCH_S + off;
              const res = await store.putIfFresher("k", { off }, { expiresAt });
              if (expiresAt > maxExpiry) {
                expect(res.applied).toBe(true);
                maxExpiry = expiresAt;
              } else {
                expect(res.applied).toBe(false);
              }
            }
            const got = await store.get<{ off: number }>("k");
            expect(got?.expiresAt).toBe(maxExpiry);
          },
        ),
        { numRuns: runs },
      );
    });
  });

  describe(`${adapter.name} — F11 real-concurrency (simulated on memory)`, () => {
    it("N=10 parallel increments sum without lost updates", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      await Promise.all(Array.from({ length: 10 }, () => store.increment("k", "count", 1)));
      const got = await store.get<{ count: number }>("k");
      expect(got?.value.count).toBe(10);
    });

    it("N=5 parallel read->CAS on one JTI yields exactly one winner (replay guard)", async () => {
      const clock = makeClock();
      const store = await adapter.make(clock.now);
      await store.put("jti", { status: "active" });

      const outcomes = await Promise.all(
        Array.from({ length: 5 }, async () => {
          const cur = await store.get<{ status: string }>("jti");
          if (cur === null || cur.value.status !== "active") return "replay";
          const res = await store.compareAndSet("jti", cur.version, { status: "consumed" });
          return res.applied ? "ok" : "replay";
        }),
      );

      expect(outcomes.filter((o) => o === "ok")).toHaveLength(1);
    });
  });
}
