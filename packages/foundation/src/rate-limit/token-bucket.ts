/**
 * Pure token-bucket algorithm.
 *
 * All functions in this module are pure: given the same inputs they
 * return the same outputs and have no side effects. Storage and I/O
 * are concerns of the caller (`DynamoTokenBucketLimiter`,
 * `MemoryTokenBucketLimiter`).
 *
 * ## Algorithm: token bucket
 *
 * A "bucket" holds up to `capacity` tokens. Tokens refill at
 * `refillRate` tokens/second. Each request consumes `cost` tokens.
 * If the bucket has enough tokens, the request is allowed; otherwise
 * it is denied and the caller receives a `retryAfter` estimate.
 *
 * Token bucket was chosen over sliding-window and leaky-bucket because:
 *   - Bursts up to `capacity` are tolerated (good UX for normal
 *     interactive traffic).
 *   - State is minimal: only `(tokens, lastRefillMs)`.
 *   - The trellis source already implements this shape; the port is
 *     mechanical.
 *
 * ## OSS alternative note
 *
 * The implementation is ~30 LOC and the math is straightforward. We
 * keep it in-house rather than depending on `@upstash/ratelimit` or
 * `rate-limiter-flexible` because both libraries pull in a storage
 * abstraction (Redis-shaped / Upstash-shaped) that does not compose
 * with foundation's DynamoDB-first posture.
 *
 * If a future consumer demands sliding-window semantics or a
 * Redis-backed limiter, the right move is to wrap the relevant OSS
 * library behind the same `RateLimitResult` return shape rather than
 * extending this implementation.
 */

import type { TokenBucketConfig, RateLimitResult } from "./types.js";

/**
 * Persistent state for a single bucket.
 * Stored in the backing KV; the algorithm reads and writes it atomically.
 */
export interface BucketState {
  /** Current token count (float; may be fractional). */
  readonly tokens: number;
  /** Epoch ms at which the last refill was computed. */
  readonly lastRefillMs: number;
}

/**
 * Result of `computeConsumeResult` — the new state to persist and the
 * allow/deny decision.
 */
export interface ConsumeComputeResult {
  readonly newState: BucketState;
  readonly result: RateLimitResult;
}

/**
 * Compute the new bucket state and rate-limit result after attempting
 * to consume `cost` tokens.
 *
 * Pure function: no I/O, no clocks, no randomness. The caller supplies
 * the current state and the current time.
 *
 * @param state    Current persisted bucket state. Pass `null` for a
 *                 bucket that doesn't exist yet (treated as a full bucket).
 * @param nowMs    Current epoch milliseconds (caller-supplied clock).
 * @param cost     Number of tokens to consume (must be positive).
 * @param config   Bucket configuration (capacity, refillRate).
 *
 * @returns        `{ newState, result }` — the caller persists `newState`
 *                 and returns `result` to the caller of `consume`.
 */
export function computeConsumeResult(
  state: BucketState | null,
  nowMs: number,
  cost: number,
  config: TokenBucketConfig,
): ConsumeComputeResult {
  const { capacity, refillRate } = config;

  // Initialise a new bucket at full capacity.
  const effectiveState: BucketState = state ?? {
    tokens: capacity,
    lastRefillMs: nowMs,
  };

  // Refill: add tokens proportional to the elapsed time.
  const elapsedMs = Math.max(0, nowMs - effectiveState.lastRefillMs);
  const refilled = Math.min(capacity, effectiveState.tokens + (elapsedMs * refillRate) / 1000);

  const resetAt = nowMs + Math.ceil(((capacity - refilled) / refillRate) * 1000);

  if (refilled >= cost) {
    // Allow: consume tokens and persist updated state.
    const remaining = refilled - cost;
    const newState: BucketState = {
      tokens: remaining,
      lastRefillMs: nowMs,
    };
    return {
      newState,
      result: {
        allowed: true,
        remaining: Math.floor(remaining),
        resetAt,
      },
    };
  } else {
    // Deny: persist the refilled (but unconsumed) state so we don't
    // lose the refill progress.
    const newState: BucketState = {
      tokens: refilled,
      lastRefillMs: nowMs,
    };
    const retryAfterMs = Math.ceil(((cost - refilled) / refillRate) * 1000);
    const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
    return {
      newState,
      result: {
        allowed: false,
        remaining: 0,
        resetAt,
        retryAfter,
      },
    };
  }
}

/**
 * Compute a peek result (what the bucket looks like now, without
 * consuming any tokens).
 *
 * This is informational only. Between a `peek` and any subsequent
 * `consume`, other callers may consume tokens. Do NOT use the result
 * of `peek` as a precondition for `consume`.
 */
export function computePeekResult(
  state: BucketState | null,
  nowMs: number,
  config: TokenBucketConfig,
): RateLimitResult {
  const { capacity, refillRate } = config;

  const effectiveState: BucketState = state ?? {
    tokens: capacity,
    lastRefillMs: nowMs,
  };

  const elapsedMs = Math.max(0, nowMs - effectiveState.lastRefillMs);
  const refilled = Math.min(capacity, effectiveState.tokens + (elapsedMs * refillRate) / 1000);

  const resetAt = nowMs + Math.ceil(((capacity - refilled) / refillRate) * 1000);

  return {
    allowed: refilled >= 1,
    remaining: Math.floor(refilled),
    resetAt,
  };
}

/**
 * Compute the TTL (in seconds from `nowMs`) for a bucket entry.
 *
 * An entry can be deleted once it is guaranteed to be fully refilled
 * and the caller would simply get a fresh full bucket. We add a small
 * safety margin (60 s) to avoid premature deletion near the boundary.
 */
export function computeBucketTtlSeconds(
  state: BucketState,
  _nowMs: number,
  config: TokenBucketConfig,
): number {
  const { capacity, refillRate } = config;
  const tokensNeeded = Math.max(0, capacity - state.tokens);
  const secondsToFull = tokensNeeded / refillRate;
  return Math.ceil(secondsToFull) + 60;
}
