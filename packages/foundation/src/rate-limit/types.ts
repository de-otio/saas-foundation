/**
 * Shared types for the rate-limit module.
 *
 * Kept in a dedicated file so `token-bucket.ts` (pure) and the limiter
 * implementations can all import from one place without circular
 * dependencies.
 */

export interface TokenBucketConfig {
  /** Maximum tokens in the bucket. */
  readonly capacity: number;
  /** Tokens added per second. May be fractional (e.g. 0.5 = 30/min). */
  readonly refillRate: number;
}

export interface RateLimitResult {
  /** Whether the request is allowed. */
  readonly allowed: boolean;
  /** Tokens remaining after this attempt (floor). */
  readonly remaining: number;
  /** Epoch ms at which the bucket will be fully refilled. */
  readonly resetAt: number;
  /** Seconds until the caller should retry. Only set when `allowed` is false. */
  readonly retryAfter?: number;
}
