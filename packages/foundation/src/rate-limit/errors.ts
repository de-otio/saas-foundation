/**
 * Named error types for the rate-limit module.
 *
 * Each carries a discriminant `name` field so call sites can use
 * `instanceof` checks or the `name` field for branching.
 */

/**
 * Thrown when a `TokenBucketConfig` is structurally invalid (e.g.
 * capacity <= 0, refillRate <= 0, non-finite values).
 */
export class RateLimitConfigError extends Error {
  public override readonly name = "RateLimitConfigError" as const;

  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
  }
}
