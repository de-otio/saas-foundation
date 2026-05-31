/**
 * `RegionRegistry` — an explicit, passable instance that holds the
 * consumer-configured set of allowed regions, the default, and the
 * country-to-region mapping.
 *
 * The registry is an explicit constructor parameter on `RegionDetector`
 * and other consumers, NOT a process-global singleton. This makes tests
 * that use different allowed lists safe to run in parallel.
 */

import { InvalidRegionError } from "./errors.js";
import { RegionFormatSchema } from "./schemas.js";
import type { Region } from "./types.js";
import { regionOrNull } from "./types.js";

export interface RegionRegistryOptions {
  /** The set of valid region codes for this deployment. */
  readonly allowed: ReadonlyArray<string>;
  /** The default region when no source produces a match. */
  readonly default: string;
  /**
   * Country-code → region mapping (both in UPPER case).
   * Countries not in the map fall through to the next detection source.
   */
  readonly countryMapping?: Readonly<Record<string, string>>;
}

export class RegionRegistry {
  private readonly allowedSet: ReadonlySet<string>;
  private readonly allowedList: ReadonlyArray<Region>;
  private readonly defaultRegion: Region;
  private readonly countryMap: Readonly<Record<string, string>>;

  public constructor(options: RegionRegistryOptions) {
    if (options.allowed.length === 0) {
      throw new InvalidRegionError(
        "RegionRegistry: allowed list must not be empty",
        options.allowed,
      );
    }

    // Validate each allowed entry's format.
    for (const r of options.allowed) {
      const check = RegionFormatSchema.safeParse(r);
      if (!check.success) {
        throw new InvalidRegionError(
          `RegionRegistry: invalid region format in allowed list: ${r}`,
          r,
        );
      }
    }

    // Validate default is in allowed.
    const defaultCheck = RegionFormatSchema.safeParse(options.default);
    if (!defaultCheck.success) {
      throw new InvalidRegionError(
        `RegionRegistry: invalid default region format: ${options.default}`,
        options.default,
      );
    }
    if (!options.allowed.includes(options.default)) {
      throw new InvalidRegionError(
        `RegionRegistry: default region '${options.default}' is not in the allowed list`,
        options.default,
      );
    }

    this.allowedSet = new Set(options.allowed);
    this.allowedList = options.allowed.map((r) => r as Region);
    this.defaultRegion = options.default as Region;
    this.countryMap = options.countryMapping ?? {};
  }

  /**
   * Parse a string as a `Region`. Throws `InvalidRegionError` if:
   *   - the format is invalid, OR
   *   - the value is not in the allowed list.
   */
  public parse(value: string): Region {
    const formatted = RegionFormatSchema.safeParse(value);
    if (!formatted.success) {
      throw new InvalidRegionError(`Invalid region format: ${value}`, value);
    }
    if (!this.allowedSet.has(value)) {
      throw new InvalidRegionError(`Region '${value}' is not in the allowed list`, value);
    }
    return value as Region;
  }

  /**
   * Parse a string as a `Region`, returning `null` on any validation
   * failure.
   */
  public parseOrNull(value: string): Region | null {
    const fmt = regionOrNull(value);
    if (fmt === null) return null;
    if (!this.allowedSet.has(value)) return null;
    return value as Region;
  }

  /** Returns the configured default region. */
  public getDefault(): Region {
    return this.defaultRegion;
  }

  /**
   * Map a country code (e.g. `"DE"`, `"CN"`) to a `Region` using the
   * consumer-supplied country mapping. Returns `null` if the country is
   * not in the mapping.
   */
  public countryToRegion(country: string): Region | null {
    const mapped = this.countryMap[country.toUpperCase()];
    if (mapped === undefined) return null;
    return this.parseOrNull(mapped);
  }

  /** Returns the full allowed list. */
  public allowed(): ReadonlyArray<Region> {
    return this.allowedList;
  }
}
