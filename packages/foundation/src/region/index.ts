/**
 * `@de-otio/saas-foundation/region` barrel.
 *
 * Region detection and residency policy primitives.
 *
 * Public API:
 *   - `Region`              — branded string type
 *   - `region(s)`           — format-only parser + brand
 *   - `regionOrNull(s)`     — nullable variant
 *   - `isRegion(v)`         — type guard
 *   - `RegionRegistry`      — consumer-configured allowed list + mapping
 *   - `RegionDetector`      — header-based detection + async residency
 *   - `detectRegion`        — convenience function
 *   - `ResidencyPolicy`     — interface for tenant → region lookup
 *   - `CachedResidencyPolicy` — TTL-caching wrapper
 *   - `getResidencyRegionForTenant` — static-mapping helper
 *   - `RegionResolution`    — served-region + residency-region pair
 *   - `RegionConfigStore`   — per-region endpoint config lookup
 *   - Named errors
 *
 * @see doc/foundation/09-region-and-residency.md
 */

export type { Region } from "./types.js";
export { region, regionOrNull, isRegion } from "./types.js";

export type { RegionRegistryOptions } from "./registry.js";
export { RegionRegistry } from "./registry.js";

export type { RegionDetectorConfig, RegionDetectorOptions } from "./detect.js";
export { RegionDetector, detectRegion } from "./detect.js";

export type { ResidencyPolicy, RegionResolution } from "./residency.js";
export { CachedResidencyPolicy, getResidencyRegionForTenant } from "./residency.js";

export type { RegionEndpoints, RegionTimeouts, RegionConfig } from "./config.js";
export { RegionConfigStore } from "./config.js";

export { InvalidRegionError, RegionResolutionError } from "./errors.js";
export { RegionFormatSchema, RegionRegistryOptionsSchema } from "./schemas.js";
