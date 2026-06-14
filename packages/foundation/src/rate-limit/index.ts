/**
 * `@de-otio/saas-foundation/rate-limit` barrel.
 *
 * Token-bucket rate limiter backed by DynamoDB (`DynamoTokenBucketLimiter`)
 * or in-memory for tests (`MemoryTokenBucketLimiter`).
 *
 * Public API:
 *   - `TokenBucketConfig` — capacity + refill-rate configuration
 *   - `RateLimitResult`   — allow/deny decision + retry-after
 *   - `DynamoTokenBucketLimiter` — production DynamoDB-backed limiter
 *   - `MemoryTokenBucketLimiter` — test-only in-memory limiter
 *   - `RateLimitConfigError` — thrown on bad configuration
 *   - Pure algorithm: `computeConsumeResult`, `computePeekResult`,
 *     `computeBucketTtlSeconds` + `BucketState` / `ConsumeComputeResult`.
 *     Exported so a consumer that must run the token-bucket decision
 *     synchronously (the foundation limiters are async-only, by storage
 *     contract) can reuse the exact same math rather than copying it.
 *
 * `MemoryTokenBucketLimiter` is NOT re-exported from the top-level
 * barrel (`@de-otio/saas-foundation`) because it is test-only. It is
 * available from this sub-path only.
 *
 * @see doc/foundation/08-rate-limit.md
 */

export type { TokenBucketConfig, RateLimitResult } from "./types.js";

/**
 * Pure token-bucket algorithm. No I/O, no clock, no randomness — the
 * caller supplies state and `nowMs`. Use these when a synchronous
 * decision is required; the async limiters wrap exactly these functions.
 */
export type { BucketState, ConsumeComputeResult } from "./token-bucket.js";
export {
  computeConsumeResult,
  computePeekResult,
  computeBucketTtlSeconds,
} from "./token-bucket.js";

export type { DynamoTokenBucketLimiterOptions } from "./dynamo-limiter.js";
export { DynamoTokenBucketLimiter } from "./dynamo-limiter.js";

/**
 * @beta-test-only — in-memory store; not cross-process safe.
 */
export { MemoryTokenBucketLimiter } from "./memory-limiter.js";
export type { MemoryTokenBucketLimiterOptions } from "./memory-limiter.js";

export { RateLimitConfigError } from "./errors.js";
export { TokenBucketConfigSchema } from "./schemas.js";
