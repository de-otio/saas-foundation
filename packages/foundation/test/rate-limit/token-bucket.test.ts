/**
 * Tests for the pure token-bucket algorithm.
 *
 * Property-based tests (fast-check): any monotonic time sequence,
 * the bucket monotonically refills and never exceeds capacity.
 *
 * Determinism: seeded at 0xc0ffee per project convention.
 * No real Date calls — time is passed as a parameter.
 */

import fc from "fast-check";
import { describe, it, expect } from "vitest";

import {
  computeConsumeResult,
  computePeekResult,
  computeBucketTtlSeconds,
  type BucketState,
} from "../../src/rate-limit/token-bucket.js";
import type { TokenBucketConfig } from "../../src/rate-limit/types.js";

const RUN_OPTIONS = { numRuns: 1000, seed: 0xc0ffee } as const;

const DEFAULT_CONFIG: TokenBucketConfig = {
  capacity: 10,
  refillRate: 1,
};

// A frozen epoch in ms for deterministic tests.
const T0 = 1_779_611_415_000;

// ─── Unit tests ──────────────────────────────────────────────────────────────

describe("computeConsumeResult — unit tests", () => {
  it("first call on a null state grants tokens from a full bucket", () => {
    const { result, newState } = computeConsumeResult(null, T0, 1, DEFAULT_CONFIG);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9); // 10 - 1
    expect(newState.tokens).toBeCloseTo(9);
    expect(newState.lastRefillMs).toBe(T0);
  });

  it("under-limit call is allowed", () => {
    const state: BucketState = { tokens: 5, lastRefillMs: T0 };
    const { result } = computeConsumeResult(state, T0, 3, DEFAULT_CONFIG);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  it("exact-limit call (consume all tokens) is allowed", () => {
    const state: BucketState = { tokens: 5, lastRefillMs: T0 };
    const { result } = computeConsumeResult(state, T0, 5, DEFAULT_CONFIG);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it("over-limit call is denied", () => {
    const state: BucketState = { tokens: 2, lastRefillMs: T0 };
    const { result } = computeConsumeResult(state, T0, 5, DEFAULT_CONFIG);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it("tokens refill over time", () => {
    const state: BucketState = { tokens: 0, lastRefillMs: T0 };
    // 5 seconds later at refillRate = 1 token/s → 5 new tokens
    const { result } = computeConsumeResult(state, T0 + 5000, 1, DEFAULT_CONFIG);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("tokens do not exceed capacity after long idle period", () => {
    const state: BucketState = { tokens: 0, lastRefillMs: T0 };
    // 1000 seconds later — capacity is 10, should not exceed 10
    const { newState } = computeConsumeResult(state, T0 + 1_000_000, 1, DEFAULT_CONFIG);
    expect(newState.tokens).toBeLessThanOrEqual(DEFAULT_CONFIG.capacity);
  });

  it("retryAfter is positive when denied", () => {
    const state: BucketState = { tokens: 0, lastRefillMs: T0 };
    const { result } = computeConsumeResult(state, T0, 1, DEFAULT_CONFIG);
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("retryAfter is undefined when allowed", () => {
    const state: BucketState = { tokens: 5, lastRefillMs: T0 };
    const { result } = computeConsumeResult(state, T0, 1, DEFAULT_CONFIG);
    expect(result.allowed).toBe(true);
    expect(result.retryAfter).toBeUndefined();
  });
});

describe("computePeekResult — unit tests", () => {
  it("peek on null state shows full bucket", () => {
    const result = computePeekResult(null, T0, DEFAULT_CONFIG);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(DEFAULT_CONFIG.capacity);
  });

  it("peek on empty bucket shows 0 remaining", () => {
    const state: BucketState = { tokens: 0, lastRefillMs: T0 };
    const result = computePeekResult(state, T0, DEFAULT_CONFIG);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("peek does not mutate the state object", () => {
    const state: BucketState = { tokens: 5, lastRefillMs: T0 };
    computePeekResult(state, T0, DEFAULT_CONFIG);
    expect(state.tokens).toBe(5); // unchanged
  });
});

describe("computeBucketTtlSeconds — unit tests", () => {
  it("full bucket has TTL equal to safety margin only", () => {
    const state: BucketState = { tokens: 10, lastRefillMs: T0 };
    const ttl = computeBucketTtlSeconds(state, T0, DEFAULT_CONFIG);
    // capacity = 10, tokens = 10 → 0 seconds to refill + 60 safety
    expect(ttl).toBe(60);
  });

  it("empty bucket has TTL proportional to capacity / refillRate + margin", () => {
    const state: BucketState = { tokens: 0, lastRefillMs: T0 };
    const ttl = computeBucketTtlSeconds(state, T0, DEFAULT_CONFIG);
    // 10 tokens / 1 per second = 10 s + 60 margin = 70
    expect(ttl).toBe(70);
  });
});

// ─── Property-based tests ─────────────────────────────────────────────────────

describe("computeConsumeResult — property-based", () => {
  it("bucket never exceeds capacity after any sequence of consumes", () => {
    const configArb = fc.record({
      capacity: fc.integer({ min: 1, max: 100 }).map((n) => n),
      refillRate: fc.integer({ min: 1, max: 100 }).map((n) => n / 10), // 0.1 to 10 tokens/s
    });

    const timeStepsArb = fc.array(
      fc.integer({ min: 0, max: 5000 }), // elapsed ms per step
      { minLength: 2, maxLength: 20 },
    );

    fc.assert(
      fc.property(configArb, timeStepsArb, (config, steps) => {
        let state: BucketState | null = null;
        let nowMs = T0;

        for (const step of steps) {
          nowMs += step;
          const { newState } = computeConsumeResult(state, nowMs, 1, config);
          // Tokens must never exceed capacity.
          expect(newState.tokens).toBeLessThanOrEqual(config.capacity + Number.EPSILON);
          state = newState;
        }
      }),
      RUN_OPTIONS,
    );
  });

  it("bucket monotonically refills over monotonic time (no consumption)", () => {
    fc.assert(
      fc.property(
        fc.record({
          capacity: fc.integer({ min: 2, max: 50 }),
          refillRate: fc.integer({ min: 1, max: 10 }).map((n) => n / 10),
        }),
        fc.integer({ min: 1, max: 5000 }),
        (config, elapsedMs) => {
          // Start with a partially depleted bucket.
          const state: BucketState = { tokens: 0, lastRefillMs: T0 };
          // Peek at now vs now + elapsed — later time has >= tokens.
          const earlier = computePeekResult(state, T0, config);
          const later = computePeekResult(state, T0 + elapsedMs, config);
          expect(later.remaining).toBeGreaterThanOrEqual(earlier.remaining);
        },
      ),
      RUN_OPTIONS,
    );
  });

  it("resetAt is always >= nowMs", () => {
    fc.assert(
      fc.property(
        fc.record({
          capacity: fc.integer({ min: 1, max: 100 }),
          refillRate: fc.integer({ min: 1, max: 100 }).map((n) => n / 10),
        }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (config, elapsedMs) => {
          const nowMs = T0 + elapsedMs;
          const state: BucketState = {
            tokens: config.capacity / 2,
            lastRefillMs: T0,
          };
          const { result } = computeConsumeResult(state, nowMs, 1, config);
          expect(result.resetAt).toBeGreaterThanOrEqual(nowMs);
        },
      ),
      RUN_OPTIONS,
    );
  });

  it("allowed=false iff retryAfter is defined", () => {
    fc.assert(
      fc.property(
        fc.record({
          capacity: fc.integer({ min: 1, max: 20 }),
          refillRate: fc.integer({ min: 1, max: 10 }).map((n) => n / 10),
        }),
        fc.integer({ min: 1, max: 30 }), // cost
        fc.integer({ min: 0, max: 20 }), // initial tokens
        (config, cost, tokens) => {
          const cappedTokens = tokens < config.capacity ? tokens : config.capacity;
          const state: BucketState = { tokens: cappedTokens, lastRefillMs: T0 };
          const { result } = computeConsumeResult(state, T0, cost, config);
          if (!result.allowed) {
            expect(result.retryAfter).toBeDefined();
            expect(result.retryAfter).toBeGreaterThanOrEqual(1);
          } else {
            expect(result.retryAfter).toBeUndefined();
          }
        },
      ),
      RUN_OPTIONS,
    );
  });

  it("remaining is always an integer (floor applied)", () => {
    fc.assert(
      fc.property(
        fc.record({
          capacity: fc.integer({ min: 2, max: 50 }),
          refillRate: fc.integer({ min: 1, max: 10 }).map((n) => n / 3), // fractional
        }),
        fc.integer({ min: 0, max: 2000 }),
        (config, elapsedMs) => {
          const state: BucketState = {
            tokens: config.capacity / 3,
            lastRefillMs: T0,
          };
          const { result } = computeConsumeResult(state, T0 + elapsedMs, 1, config);
          // remaining must be an integer (floor applied in the algorithm)
          expect(result.remaining).toBe(result.remaining | 0);
        },
      ),
      RUN_OPTIONS,
    );
  });
});
