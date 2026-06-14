/**
 * Region detection from inbound request headers.
 *
 * Detection order (sync fast path):
 *   1. `cdn-geo-header` — CloudFront `CloudFront-Viewer-Country` and
 *      Cloudflare `CF-IPCountry`. Mapped via `RegionRegistry.countryToRegion`.
 *   2. `accept-language` — coarse fallback. `zh-CN` → CN region,
 *      European language codes → EU (consumer configures the mapping
 *      via the `RegionRegistry`).
 *   3. `default` — registry's configured default.
 *
 * Async path adds:
 *   4. `tenant-residency` — `ResidencyPolicy.getResidencyRegion` for
 *      requests scoped to a specific tenant.
 *
 * The async path returns the tenants's residency region as an override
 * even if the sync path determined a different region. This is correct:
 * a US-served request for an EU-residency tenant should be routed to
 * the EU database.
 *
 * ## Consumer note
 *
 * The trellis source had hardcoded country→region mappings. Foundation
 * makes the mapping consumer-supplied via `RegionRegistry`. This removes
 * domain-specific enums from foundation while keeping the detection
 * algorithm generic.
 */

import type { TenantId } from "../types/frozen/tenant.js";
import type { Region } from "./types.js";
import type { RegionRegistry } from "./registry.js";
import type { ResidencyPolicy } from "./residency.js";

export interface RegionDetectorConfig {
  /**
   * Ordered list of sources to try in the sync path. The async path
   * always adds `tenant-residency` at the end.
   *
   * @default ['cdn-geo-header', 'accept-language', 'default']
   */
  readonly fallbackOrder?: ReadonlyArray<"cdn-geo-header" | "accept-language" | "default">;
}

const CDN_GEO_HEADERS = ["CloudFront-Viewer-Country", "CF-IPCountry"] as const;

/** Country codes that indicate "unknown location" from CDN providers. */
const UNKNOWN_COUNTRY_CODES = new Set(["XX", "T1", "ZZ", ""]);

/** Language-tag prefix → region logic for `accept-language` source. */
function regionFromAcceptLanguage(acceptLanguage: string, registry: RegionRegistry): Region | null {
  // Parse "en-US,en;q=0.9,zh-CN;q=0.8" → ["en-US", "en", "zh-CN"]
  const langs = acceptLanguage
    .split(",")
    .map((part) => part.split(";")[0]?.trim().toLowerCase() ?? "")
    .filter((l) => l.length > 0);

  for (const lang of langs) {
    // zh-CN / zh-Hans → CN country code
    if (lang.startsWith("zh-cn") || lang.startsWith("zh-hans") || lang.startsWith("zh")) {
      const r = registry.countryToRegion("CN");
      if (r !== null) return r;
    }

    // Map two-letter language code to a plausible country for registry lookup.
    // Heuristic: de→DE, fr→FR, es→ES, it→IT, pt→PT, nl→NL, ja→JP, ko→KR
    const langToCountry: Readonly<Record<string, string>> = {
      de: "DE",
      fr: "FR",
      es: "ES",
      it: "IT",
      pt: "PT",
      nl: "NL",
      ja: "JP",
      ko: "KR",
    };
    const twoLetter = lang.slice(0, 2);
    const country = langToCountry[twoLetter];
    if (country !== undefined) {
      const r = registry.countryToRegion(country);
      if (r !== null) return r;
    }
  }

  return null;
}

export interface RegionDetectorOptions {
  readonly residencyPolicy?: ResidencyPolicy;
}

export class RegionDetector {
  private readonly registry: RegionRegistry;
  private readonly fallbackOrder: ReadonlyArray<"cdn-geo-header" | "accept-language" | "default">;
  private readonly residencyPolicy?: ResidencyPolicy;

  public constructor(
    registry: RegionRegistry,
    config: RegionDetectorConfig = {},
    options: RegionDetectorOptions = {},
  ) {
    this.registry = registry;
    this.fallbackOrder = config.fallbackOrder ?? ["cdn-geo-header", "accept-language", "default"];
    if (options.residencyPolicy !== undefined) {
      this.residencyPolicy = options.residencyPolicy;
    }
  }

  /**
   * Sync detection — fast path. Sources limited to
   * `cdn-geo-header`, `accept-language`, and `default`.
   */
  public detectSync(request: Request): Region {
    for (const source of this.fallbackOrder) {
      const r = this.trySource(source, request);
      if (r !== null) return r;
    }
    // Always returns: 'default' source is always present by convention.
    return this.registry.getDefault();
  }

  /**
   * Async detection — adds tenant-residency as a final override after
   * the sync chain. Only needed when the consumer wants to route by
   * the tenant's data-residency region rather than the request's
   * served region.
   */
  public async detect(request: Request, tenantId?: TenantId): Promise<Region> {
    const syncRegion = this.detectSync(request);

    if (tenantId !== undefined && this.residencyPolicy !== undefined) {
      const residency = await this.residencyPolicy.getResidencyRegion(tenantId);
      if (residency !== null) return residency;
    }

    return syncRegion;
  }

  private trySource(
    source: "cdn-geo-header" | "accept-language" | "default",
    request: Request,
  ): Region | null {
    switch (source) {
      case "cdn-geo-header": {
        for (const header of CDN_GEO_HEADERS) {
          const value = request.headers.get(header);
          if (value === null || UNKNOWN_COUNTRY_CODES.has(value)) continue;
          const r = this.registry.countryToRegion(value);
          if (r !== null) return r;
        }
        return null;
      }
      case "accept-language": {
        const al = request.headers.get("Accept-Language");
        if (al === null || al.length === 0) return null;
        return regionFromAcceptLanguage(al, this.registry);
      }
      case "default":
        return this.registry.getDefault();
    }
  }
}

/**
 * Convenience function: detect the region from a request using the
 * provided registry. Equivalent to `new RegionDetector(registry).detectSync(request)`.
 *
 * Per `doc/foundation/09-region-and-residency.md`, the design favours
 * explicit registry instances over global helpers. This function is
 * exported from the barrel for callers that construct the registry
 * once and pass it in.
 */
export function detectRegion(request: Request, registry: RegionRegistry): Region {
  return new RegionDetector(registry).detectSync(request);
}
