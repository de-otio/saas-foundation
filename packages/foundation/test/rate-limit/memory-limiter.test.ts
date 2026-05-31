/**
 * Tests for `MemoryTokenBucketLimiter`.
 *
 * Uses fake timers (vi.useFakeTimers) to control the clock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MemoryTokenBucketLimiter } from "../../src/rate-limit/memory-limiter.js";
import { RateLimitConfigError } from "../../src/rate-limit/errors.js";
import type { TokenBucketConfig } from "../../src/rate-limit/types.js";

const FROZEN_EPOCH_MS = 1_779_611_415_000;

const CONFIG: TokenBucketConfig = { capacity: 5, refillRate: 1 };

describe("MemoryTokenBucketLimiter — construction", () => {
  it("constructs with default config", () => {
    expect(() => new MemoryTokenBucketLimiter()).not.toThrow();
  });

  it("throws RateLimitConfigError on invalid defaultConfig (capacity = 0)", () => {
    expect(
      () => new MemoryTokenBucketLimiter({ defaultConfig: { capacity: 0, refillRate: 1 } }),
    ).toThrow(RateLimitConfigError);
  });

  it("throws RateLimitConfigError on invalid defaultConfig (refillRate negative)", () => {
    expect(
      () => new MemoryTokenBucketLimiter({ defaultConfig: { capacity: 5, refillRate: -1 } }),
    ).toThrow(RateLimitConfigError);
  });
});

describe("MemoryTokenBucketLimiter — consume", () => {
  let limiter: MemoryTokenBucketLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
    limiter = new MemoryTokenBucketLimiter({ defaultConfig: CONFIG });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("first call is allowed (full bucket)", async () => {
    const result = await limiter.consume("user:alice", 1);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("calls within capacity are all allowed", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await limiter.consume("user:alice", 1);
      expect(r.allowed).toBe(true);
    }
  });

  it("call over capacity is denied", async () => {
    for (let i = 0; i < 5; i++) {
      await limiter.consume("user:alice", 1);
    }
    const denied = await limiter.consume("user:alice", 1);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("retryAfter is positive when denied", async () => {
    // Drain the bucket.
    for (let i = 0; i < 5; i++) {
      await limiter.consume("key", 1, CONFIG);
    }
    const denied = await limiter.consume("key", 1, CONFIG);
    expect(denied.retryAfter).toBeDefined();
    expect(denied.retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("different keys have independent buckets", async () => {
    // Drain alice's bucket.
    for (let i = 0; i < 5; i++) {
      await limiter.consume("user:alice", 1);
    }
    // Bob is untouched.
    const bobResult = await limiter.consume("user:bob", 1);
    expect(bobResult.allowed).toBe(true);
  });

  it("tokens refill over time", async () => {
    // Drain.
    for (let i = 0; i < 5; i++) {
      await limiter.consume("key", 1);
    }
    // Advance 3 seconds → 3 new tokens (refillRate = 1/s).
    vi.setSystemTime(FROZEN_EPOCH_MS + 3000);
    const result = await limiter.consume("key", 1);
    expect(result.allowed).toBe(true);
  });

  it("per-call config override is respected", async () => {
    const smallConfig: TokenBucketConfig = { capacity: 2, refillRate: 0.5 };
    const r1 = await limiter.consume("key", 1, smallConfig);
    const r2 = await limiter.consume("key", 1, smallConfig);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    // Third call with the small config should be denied (only 2 capacity).
    const r3 = await limiter.consume("key", 1, smallConfig);
    expect(r3.allowed).toBe(false);
  });

  it("throws RateLimitConfigError on invalid per-call config", async () => {
    await expect(limiter.consume("key", 1, { capacity: -1, refillRate: 1 })).rejects.toThrow(
      RateLimitConfigError,
    );
  });
});

describe("MemoryTokenBucketLimiter — peek", () => {
  let limiter: MemoryTokenBucketLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
    limiter = new MemoryTokenBucketLimiter({ defaultConfig: CONFIG });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("peek on a fresh key shows full bucket", async () => {
    const result = await limiter.peek("key");
    expect(result.remaining).toBe(CONFIG.capacity);
    expect(result.allowed).toBe(true);
  });

  it("peek after partial consumption shows remaining tokens", async () => {
    await limiter.consume("key", 2);
    const result = await limiter.peek("key");
    expect(result.remaining).toBe(3);
  });

  it("peek does not consume tokens", async () => {
    await limiter.peek("key");
    await limiter.peek("key");
    const consume = await limiter.consume("key", 5);
    // All 5 tokens should still be available.
    expect(consume.allowed).toBe(true);
  });
});

describe("MemoryTokenBucketLimiter — reset", () => {
  let limiter: MemoryTokenBucketLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
    limiter = new MemoryTokenBucketLimiter({ defaultConfig: CONFIG });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reset allows subsequent consume to start fresh", async () => {
    // Drain.
    for (let i = 0; i < 5; i++) {
      await limiter.consume("key", 1);
    }
    await limiter.reset("key");
    const result = await limiter.consume("key", 1);
    expect(result.allowed).toBe(true);
  });
});

describe("MemoryTokenBucketLimiter — unknownKeyStrategy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shared-bucket (default): unknown-IP calls share one bucket", async () => {
    const limiter = new MemoryTokenBucketLimiter({
      defaultConfig: CONFIG,
      unknownKeyStrategy: "shared-bucket",
    });
    // Both 'unknown' keys collapse to the same bucket.
    const r1 = await limiter.consume("ip:unknown", 1);
    const r2 = await limiter.consume("ip:unknown", 1);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    // After 5 total calls, the shared bucket is exhausted.
    await limiter.consume("ip:unknown", 1);
    await limiter.consume("ip:unknown", 1);
    await limiter.consume("ip:unknown", 1);
    const denied = await limiter.consume("ip:unknown", 1);
    expect(denied.allowed).toBe(false);
  });

  it("reject: unknown-IP calls are always denied without a DB round-trip", async () => {
    const limiter = new MemoryTokenBucketLimiter({
      defaultConfig: CONFIG,
      unknownKeyStrategy: "reject",
    });
    const result = await limiter.consume("ip:unknown", 1);
    expect(result.allowed).toBe(false);
    // A normal key is still allowed.
    const normal = await limiter.consume("ip:1.2.3.4", 1);
    expect(normal.allowed).toBe(true);
  });

  it("allow: unknown-IP calls pass through unrestricted", async () => {
    const limiter = new MemoryTokenBucketLimiter({
      defaultConfig: CONFIG,
      unknownKeyStrategy: "allow",
    });
    const result = await limiter.consume("ip:unknown", 1);
    expect(result.allowed).toBe(true);
  });

  it("reject: bare 'unknown' key is also rejected", async () => {
    const limiter = new MemoryTokenBucketLimiter({
      defaultConfig: CONFIG,
      unknownKeyStrategy: "reject",
    });
    const result = await limiter.consume("unknown", 1);
    expect(result.allowed).toBe(false);
  });
});
