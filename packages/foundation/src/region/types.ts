/**
 * `Region` brand and primitive validators.
 *
 * A `Region` is a branded string: 2–32 chars, `[A-Za-z0-9-]` only.
 * The brand is opaque — foundation does not enforce a specific code
 * system. Consumers using `eu-central-1`-style codes and consumers
 * using `EU`-style codes do not exchange `Region` values directly.
 *
 * Pure module.
 */

import { InvalidRegionError } from "./errors.js";
import { RegionFormatSchema } from "./schemas.js";

declare const RegionBrand: unique symbol;

/** Branded string for a region identifier. */
export type Region = string & { readonly [RegionBrand]: true };

/**
 * Parse and brand a string as a `Region`. Throws `InvalidRegionError`
 * if the format is invalid (wrong character set, out-of-range length).
 *
 * This is a format-only check. For allowlist checking, use
 * `RegionRegistry.parse`.
 */
export function region(value: string): Region {
  const result = RegionFormatSchema.safeParse(value);
  if (!result.success) {
    throw new InvalidRegionError(
      `Invalid region format: ${value}. Must be 2-32 chars, [A-Za-z0-9-] only.`,
      value,
    );
  }
  return value as Region;
}

/**
 * Parse and brand a string as a `Region`, returning `null` if invalid.
 */
export function regionOrNull(value: string): Region | null {
  const result = RegionFormatSchema.safeParse(value);
  if (!result.success) return null;
  return value as Region;
}

/**
 * Type guard: returns `true` if `value` is format-valid as a `Region`.
 */
export function isRegion(value: unknown): value is Region {
  if (typeof value !== "string") return false;
  return RegionFormatSchema.safeParse(value).success;
}
