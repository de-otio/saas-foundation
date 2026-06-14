/**
 * Unit + property tests for `SecretCache`.
 *
 * Frozen clock injected via `clock: () => number` per the determinism
 * rules in doc/02-monorepo-layout.md (no `Date.now()` in tests).
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { SecretCache } from "../../src/secrets/cache.js";

/**
 * A test clock that returns the value of `nowRef.current`. Tests
 * mutate `nowRef.current` to advance time.
 */
function makeClock(): { current: number; clock: () => number } {
  const ref = { current: 0 };
  return {
    get current() {
      return ref.current;
    },
    set current(v: number) {
      ref.current = v;
    },
    clock: () => ref.current,
  };
}

describe("SecretCache — basic operations", () => {
  it("returns null on cache miss", () => {
    const c = new SecretCache({ clock: () => 0 });
    expect(c.get("key")).toBeNull();
  });

  it("stores and retrieves a value", () => {
    const c = new SecretCache({ clock: () => 0 });
    const value = Buffer.from("secret-plaintext", "utf-8");
    c.set("key", value);
    const hit = c.get("key");
    if (hit === null) throw new Error("expected hit");
    expect(hit.equals(Buffer.from("secret-plaintext", "utf-8"))).toBe(true);
  });

  it("respects TTL — entry expires after ttlSeconds", () => {
    const t = makeClock();
    const c = new SecretCache({ ttlSeconds: 60, clock: t.clock });
    c.set("k", Buffer.from("v"));
    t.current = 59_000;
    expect(c.get("k")).not.toBeNull();
    t.current = 60_000;
    expect(c.get("k")).toBeNull();
  });

  it("LRU evicts the least-recently-used entry on overflow", () => {
    const c = new SecretCache({ maxEntries: 2, clock: () => 0 });
    c.set("a", Buffer.from("A"));
    c.set("b", Buffer.from("B"));
    // touch 'a' to make it MRU
    c.get("a");
    c.set("c", Buffer.from("C"));
    // 'b' should be evicted (LRU); 'a' and 'c' survive
    expect(c.get("b")).toBeNull();
    expect(c.get("a")).not.toBeNull();
    expect(c.get("c")).not.toBeNull();
  });

  it("invalidate removes a single entry and returns true", () => {
    const c = new SecretCache({ clock: () => 0 });
    c.set("k", Buffer.from("v"));
    expect(c.invalidate("k")).toBe(true);
    expect(c.get("k")).toBeNull();
    expect(c.invalidate("k")).toBe(false);
  });

  it("clear removes every entry", () => {
    const c = new SecretCache({ clock: () => 0 });
    c.set("a", Buffer.from("A"));
    c.set("b", Buffer.from("B"));
    c.clear();
    expect(c.get("a")).toBeNull();
    expect(c.get("b")).toBeNull();
    expect(c.size()).toBe(0);
  });

  it("set on existing key zeroizes the old buffer and replaces it", () => {
    const c = new SecretCache({ clock: () => 0 });
    const oldBuf = Buffer.from("OLD", "utf-8");
    const newBuf = Buffer.from("NEW", "utf-8");
    c.set("k", oldBuf);
    c.set("k", newBuf);
    // Old buffer is zeroized
    expect(oldBuf.every((b) => b === 0)).toBe(true);
    // New value is stored
    const hit = c.get("k");
    if (hit === null) throw new Error("expected hit");
    expect(hit.equals(Buffer.from("NEW", "utf-8"))).toBe(true);
  });

  it("invalidate zeroizes the underlying buffer", () => {
    const c = new SecretCache({ clock: () => 0 });
    const buf = Buffer.from("secret-bytes", "utf-8");
    c.set("k", buf);
    c.invalidate("k");
    expect(buf.every((b) => b === 0)).toBe(true);
  });

  it("clear zeroizes every underlying buffer", () => {
    const c = new SecretCache({ clock: () => 0 });
    const a = Buffer.from("AAA", "utf-8");
    const b = Buffer.from("BBB", "utf-8");
    c.set("a", a);
    c.set("b", b);
    c.clear();
    expect(a.every((x) => x === 0)).toBe(true);
    expect(b.every((x) => x === 0)).toBe(true);
  });

  it("eviction-on-overflow zeroizes the evicted buffer", () => {
    const c = new SecretCache({ maxEntries: 1, clock: () => 0 });
    const a = Buffer.from("AAA", "utf-8");
    c.set("a", a);
    c.set("b", Buffer.from("BBB", "utf-8"));
    expect(a.every((b) => b === 0)).toBe(true);
  });

  it("TTL-expired get zeroizes the underlying buffer", () => {
    const t = makeClock();
    const c = new SecretCache({ ttlSeconds: 1, clock: t.clock });
    const buf = Buffer.from("secret", "utf-8");
    c.set("k", buf);
    t.current = 5_000;
    expect(c.get("k")).toBeNull();
    expect(buf.every((b) => b === 0)).toBe(true);
  });

  it("uses default options when none provided", () => {
    // Sanity: no exceptions, returns null on miss with real Date.now.
    const c = new SecretCache();
    expect(c.get("missing")).toBeNull();
  });
});

describe("SecretCache — property-based", () => {
  const RUN_OPTIONS = { numRuns: 200, seed: 0xc0ffee } as const;

  it("TTL invariant: get returns the value iff (now - setAt) < ttlSeconds*1000", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 16 }),
        fc.uint8Array({ minLength: 1, maxLength: 64 }),
        fc.integer({ min: 1, max: 600 }), // ttlSeconds
        fc.integer({ min: 0, max: 1_000_000 }), // setAtMs
        fc.integer({ min: 0, max: 1_200_000 }), // queryAtMs
        (key, value, ttlSec, setAtMs, queryAtMs) => {
          const t = makeClock();
          const c = new SecretCache({ ttlSeconds: ttlSec, clock: t.clock });
          t.current = setAtMs;
          c.set(key, Buffer.from(value));
          t.current = queryAtMs;
          const ttlMs = ttlSec * 1000;
          const expired = queryAtMs - setAtMs >= ttlMs;
          if (expired) {
            expect(c.get(key)).toBeNull();
          } else {
            const hit = c.get(key);
            if (hit === null) throw new Error("expected hit");
            expect(hit.equals(Buffer.from(value))).toBe(true);
          }
        },
      ),
      RUN_OPTIONS,
    );
  });

  it("maxEntries invariant: size never exceeds maxEntries", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.array(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 0, maxLength: 50 }),
        (max, keys) => {
          const c = new SecretCache({ maxEntries: max, clock: () => 0 });
          for (const k of keys) {
            c.set(k, Buffer.from(k));
          }
          expect(c.size()).toBeLessThanOrEqual(max);
        },
      ),
      RUN_OPTIONS,
    );
  });

  it("invalidate then get always returns null", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 16 }),
        fc.uint8Array({ minLength: 1, maxLength: 64 }),
        (key, value) => {
          const c = new SecretCache({ clock: () => 0 });
          c.set(key, Buffer.from(value));
          c.invalidate(key);
          expect(c.get(key)).toBeNull();
        },
      ),
      RUN_OPTIONS,
    );
  });
});
