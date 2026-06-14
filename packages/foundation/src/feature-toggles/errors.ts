/**
 * Named error types for the feature-toggles module.
 *
 * Each carries a discriminant `name` field so call sites can use
 * `instanceof` checks or the `name` field for branching.
 */

/**
 * Thrown when a `FeatureToggleStore` is configured with invalid options.
 */
export class FeatureToggleConfigError extends Error {
  public override readonly name = "FeatureToggleConfigError" as const;

  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
  }
}

/**
 * Thrown by `get` when a key is not found and the caller needs to
 * distinguish "not found" from "disabled". `isEnabled` never throws
 * this — it returns `false` for missing keys.
 */
export class FeatureToggleNotFoundError extends Error {
  public override readonly name = "FeatureToggleNotFoundError" as const;
  public readonly key: string;

  public constructor(key: string, options?: { cause?: unknown }) {
    super(
      `Feature toggle not found: ${key}`,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.key = key;
  }
}
