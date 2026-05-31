/**
 * Named error types for the region module.
 */

/**
 * Thrown when `RegionRegistry.parse` receives a value that is not
 * format-valid (wrong character set / length) or is not in the
 * registry's allowed list.
 */
export class InvalidRegionError extends Error {
  public override readonly name = "InvalidRegionError" as const;
  public readonly input: unknown;

  public constructor(message: string, input: unknown, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.input = input;
  }
}

/**
 * Thrown by `RegionDetector` when the registry has no default and no
 * source produced a valid region.
 */
export class RegionResolutionError extends Error {
  public override readonly name = "RegionResolutionError" as const;

  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
  }
}
