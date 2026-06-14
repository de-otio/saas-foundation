/**
 * Tests for `RegionDetector` / `detectRegion`.
 *
 * Covers:
 *   - CloudFront-Viewer-Country happy path
 *   - CF-IPCountry fallback
 *   - Unknown CDN values (XX, T1) fall through
 *   - Accept-Language fallback
 *   - Default region when no source matches
 *   - Async detect with residency override
 */

import { describe, it, expect } from "vitest";
import { RegionRegistry } from "../../src/region/registry.js";
import { RegionDetector, detectRegion } from "../../src/region/detect.js";
import type { Region } from "../../src/region/types.js";
import type { ResidencyPolicy } from "../../src/region/residency.js";
import type { TenantId } from "../../src/types/frozen/tenant.js";
import { tenantId } from "../../src/types/frozen/tenant.js";

const registry = new RegionRegistry({
  allowed: ["EU", "US", "CN"],
  default: "EU",
  countryMapping: {
    DE: "EU",
    FR: "EU",
    US: "US",
    CA: "US",
    CN: "CN",
    HK: "CN",
  },
});

function makeRequest(headers: Record<string, string>): Request {
  return new Request("https://example.com/", { headers });
}

describe("RegionDetector.detectSync — cdn-geo-header", () => {
  const detector = new RegionDetector(registry);

  it("maps CloudFront-Viewer-Country: DE → EU", () => {
    const req = makeRequest({ "cloudfront-viewer-country": "DE" });
    expect(detector.detectSync(req)).toBe("EU");
  });

  it("maps CloudFront-Viewer-Country: US → US", () => {
    const req = makeRequest({ "cloudfront-viewer-country": "US" });
    expect(detector.detectSync(req)).toBe("US");
  });

  it("maps CloudFront-Viewer-Country: CN → CN", () => {
    const req = makeRequest({ "cloudfront-viewer-country": "CN" });
    expect(detector.detectSync(req)).toBe("CN");
  });

  it("maps CF-IPCountry: FR → EU (fallback header)", () => {
    const req = makeRequest({ "cf-ipcountry": "FR" });
    expect(detector.detectSync(req)).toBe("EU");
  });

  it("falls through on XX (unknown country)", () => {
    // XX → falls to accept-language, then default
    const req = makeRequest({ "cloudfront-viewer-country": "XX" });
    // No Accept-Language → default = EU
    expect(detector.detectSync(req)).toBe("EU");
  });

  it("falls through on T1 (Tor exit node)", () => {
    const req = makeRequest({ "cloudfront-viewer-country": "T1" });
    expect(detector.detectSync(req)).toBe("EU");
  });

  it("falls through on unmapped country code → default", () => {
    const req = makeRequest({ "cloudfront-viewer-country": "AQ" }); // Antarctica
    expect(detector.detectSync(req)).toBe("EU");
  });
});

describe("RegionDetector.detectSync — accept-language fallback", () => {
  const detector = new RegionDetector(registry);

  it("zh-CN maps to CN via the zh-cn prefix", () => {
    const req = makeRequest({ "accept-language": "zh-CN,en;q=0.9" });
    expect(detector.detectSync(req)).toBe("CN");
  });

  it("de maps to EU via the de language code", () => {
    const req = makeRequest({ "accept-language": "de,en;q=0.9" });
    expect(detector.detectSync(req)).toBe("EU");
  });

  it("no language header falls through to default", () => {
    const req = makeRequest({});
    expect(detector.detectSync(req)).toBe("EU");
  });

  it("unknown language falls through to default", () => {
    const req = makeRequest({ "accept-language": "sw" }); // Swahili — unmapped
    expect(detector.detectSync(req)).toBe("EU");
  });
});

describe("RegionDetector.detectSync — default region", () => {
  it("returns the configured default when no source matches", () => {
    const usRegistry = new RegionRegistry({
      allowed: ["EU", "US"],
      default: "US",
      countryMapping: { DE: "EU" },
    });
    const detector = new RegionDetector(usRegistry);
    const req = makeRequest({});
    expect(detector.detectSync(req)).toBe("US");
  });
});

describe("RegionDetector.detect — async residency override", () => {
  it("returns tenant residency region even when CDN says otherwise", async () => {
    const mockPolicy: ResidencyPolicy = {
      async getResidencyRegion(_tenantId: TenantId): Promise<Region | null> {
        return "EU" as Region;
      },
    };
    const detector = new RegionDetector(registry, {}, { residencyPolicy: mockPolicy });

    // CDN says US, but tenant's residency is EU.
    const req = makeRequest({ "cloudfront-viewer-country": "US" });
    const result = await detector.detect(req, tenantId("acme"));
    expect(result).toBe("EU");
  });

  it("falls back to sync region when residency policy returns null", async () => {
    const mockPolicy: ResidencyPolicy = {
      async getResidencyRegion(_tenantId: TenantId): Promise<Region | null> {
        return null;
      },
    };
    const detector = new RegionDetector(registry, {}, { residencyPolicy: mockPolicy });

    const req = makeRequest({ "cloudfront-viewer-country": "US" });
    const result = await detector.detect(req, tenantId("acme"));
    expect(result).toBe("US");
  });

  it("uses sync region when no tenantId is supplied", async () => {
    const mockPolicy: ResidencyPolicy = {
      getResidencyRegion: async () => "EU" as Region,
    };
    const detector = new RegionDetector(registry, {}, { residencyPolicy: mockPolicy });

    const req = makeRequest({ "cloudfront-viewer-country": "US" });
    // No tenantId → residency not queried.
    const result = await detector.detect(req);
    expect(result).toBe("US");
  });
});

describe("detectRegion — convenience function", () => {
  it("maps headers using the supplied registry", () => {
    const req = makeRequest({ "cloudfront-viewer-country": "CN" });
    const result = detectRegion(req, registry);
    expect(result).toBe("CN");
  });
});
