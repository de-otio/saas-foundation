/**
 * `MemoryTokenBucketLimiter` — in-memory token-bucket limiter.
 *
 * IMPORTANT: This implementation is NOT production-safe.
 *
 *   - State is per-process; cross-process callers see independent buckets.
 *   - On worker/process restart all state is lost.
 *   - No distributed coordination whatsoever.
 *
 * Exported, marked `@beta-test-only`. Use `DynamoTokenBucketLimiter`
 * in production.
 *
 * @beta-test-only
 */

import { getLogger } from "../logger/index.js";
import type { TokenBucketConfig, RateLimitResult } from "./types.js";
import type { BucketState } from "./token-bucket.js";
import { computeConsumeResult, computePeekResult } from "./token-bucket.js";
import { RateLimitConfigError } from "./errors.js";
import { TokenBucketConfigSchema } from "./schemas.js";

export interface MemoryTokenBucketLimiterOptions {
  readonly defaultConfig?: TokenBucketConfig;
  /**
   * Behaviour when the key ends in `:unknown` (typically: IP derivation
   * failed).
   *
   * - `'shared-bucket'` (default): all unknown-key callers share one
   *   bucket, which limits throughput across the unknown segment but
   *   keeps the service available.
   * - `'reject'`: every unknown-key call returns `{ allowed: false }`.
   *   Use when fail-closed is preferred (e.g., an unauthenticated
   *   endpoint where the rate-limit is the only authorization gate).
   * - `'allow'`: pass-through with no rate limiting. Only for dev/debug.
   *
   * @default 'shared-bucket'
   */
  readonly unknownKeyStrategy?: "shared-bucket" | "reject" | "allow";
}

const DEFAULT_CONFIG: TokenBucketConfig = {
  capacity: 60,
  refillRate: 1,
};

/**
 * In-memory token-bucket limiter for tests.
 *
 * @beta-test-only — not cross-process safe; use `DynamoTokenBucketLimiter`
 * in production.
 */
export class MemoryTokenBucketLimiter {
  private readonly buckets = new Map<string, BucketState>();
  private readonly defaultConfig: TokenBucketConfig;
  private readonly unknownKeyStrategy: "shared-bucket" | "reject" | "allow";

  public constructor(options: MemoryTokenBucketLimiterOptions = {}) {
    const rawConfig = options.defaultConfig ?? DEFAULT_CONFIG;
    const parsed = TokenBucketConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      throw new RateLimitConfigError(`Invalid defaultConfig: ${parsed.error.message}`);
    }
    this.defaultConfig = rawConfig;
    this.unknownKeyStrategy = options.unknownKeyStrategy ?? "shared-bucket";
  }

  /**
   * Attempt to consume `cost` tokens for `key`.
   *
   * Returns the result; does not throw on rate-limit-exceeded — the
   * caller decides whether to 429 / queue / fail.
   */
  public consume(key: string, cost: number, config?: TokenBucketConfig): Promise<RateLimitResult> {
    try {
      const effectiveKey = this.resolveKey(key);
      if (effectiveKey === null) {
        // unknownKeyStrategy === 'reject'
        return Promise.resolve({
          allowed: false,
          remaining: 0,
          resetAt: Date.now(),
          retryAfter: 0,
        });
      }

      const effectiveConfig = this.resolveConfig(config);
      const nowMs = Date.now();
      const state = this.buckets.get(effectiveKey) ?? null;
      const { newState, result } = computeConsumeResult(state, nowMs, cost, effectiveConfig);

      this.buckets.set(effectiveKey, newState);

      const logger = getLogger();
      if (result.allowed) {
        logger.debug({ key, cost, remaining: result.remaining }, "rate-limit: allowed");
      } else {
        logger.warn({ key, cost, retryAfter: result.retryAfter }, "rate-limit: denied");
      }

      return Promise.resolve(result);
    } catch (err) {
      // Re-propagate the original caught error unchanged; its type is
      // `unknown` here and the rule cannot prove it is an Error.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(err);
    }
  }

  /**
   * Peek at the current bucket state without consuming.
   *
   * The result is informational only — between `peek()` and any
   * subsequent `consume()` call, other callers may consume tokens.
   * Do NOT use `peek` as a precondition for `consume`.
   */
  public peek(key: string, config?: TokenBucketConfig): Promise<RateLimitResult> {
    const effectiveKey = this.resolveKey(key) ?? key;
    const effectiveConfig = this.resolveConfig(config);
    const nowMs = Date.now();
    const state = this.buckets.get(effectiveKey) ?? null;
    return Promise.resolve(computePeekResult(state, nowMs, effectiveConfig));
  }

  /**
   * Reset a bucket. Removes the in-memory entry.
   *
   * Useful for tests and admin operations. Not production-safe across
   * processes (a reset on one instance does not propagate to others).
   */
  public reset(key: string): Promise<void> {
    this.buckets.delete(key);
    return Promise.resolve();
  }

  private resolveKey(key: string): string | null {
    const isUnknown = key === "unknown" || key.endsWith(":unknown");

    if (!isUnknown) return key;

    switch (this.unknownKeyStrategy) {
      case "reject":
        return null;
      case "allow":
        return key;
      case "shared-bucket":
      default:
        return key; // fall through — the shared bucket is the key itself
    }
  }

  private resolveConfig(override?: TokenBucketConfig): TokenBucketConfig {
    if (override === undefined) return this.defaultConfig;
    const parsed = TokenBucketConfigSchema.safeParse(override);
    if (!parsed.success) {
      throw new RateLimitConfigError(`Invalid TokenBucketConfig: ${parsed.error.message}`);
    }
    return override;
  }
}
