/**
 * Tests for `getResidencyRegionForTenant` and `CachedResidencyPolicy`.
 *
 * Covers:
 *   - Static mapping lookup: found, not found
 *   - Default region (null return)
 *   - `CachedResidencyPolicy`: cache hit, cache miss, TTL expiry
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getResidencyRegionForTenant,
  CachedResidencyPolicy,
  type ResidencyPolicy,
} from "../../src/region/residency.js";
import type { Region } from "../../src/region/types.js";
import { tenantId } from "../../src/types/frozen/tenant.js";

const EU = "EU" as Region;
const US = "US" as Region;

const FROZEN_EPOCH_MS = 1_779_611_415_000;

describe("getResidencyRegionForTenant", () => {
  const mapping: Readonly<Record<string, Region>> = {
    "tenant-a": EU,
    "tenant-b": US,
  };

  it("returns the tenant's residency region", () => {
    const result = getResidencyRegionForTenant(tenantId("tenant-a"), mapping);
    expect(result).toBe("EU");
  });

  it("returns null for a tenant not in the mapping", () => {
    const result = getResidencyRegionForTenant(tenantId("tenant-x"), mapping);
    expect(result).toBeNull();
  });

  it("returns null for an empty mapping", () => {
    const result = getResidencyRegionForTenant(tenantId("tenant-a"), {});
    expect(result).toBeNull();
  });
});

describe("CachedResidencyPolicy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delegates to inner policy on cache miss", async () => {
    const spy = vi.fn().mockResolvedValue(EU);
    const inner: ResidencyPolicy = { getResidencyRegion: spy };
    const cached = new CachedResidencyPolicy(inner, 60_000);
    const result = await cached.getResidencyRegion(tenantId("tenant-a"));
    expect(result).toBe("EU");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("returns cached value on second call within TTL", async () => {
    const spy = vi.fn().mockResolvedValue(EU);
    const inner: ResidencyPolicy = { getResidencyRegion: spy };
    const cached = new CachedResidencyPolicy(inner, 60_000);
    await cached.getResidencyRegion(tenantId("tenant-a"));
    await cached.getResidencyRegion(tenantId("tenant-a"));
    // Only one call to inner.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after TTL expiry", async () => {
    const spy = vi.fn().mockResolvedValue(EU);
    const inner: ResidencyPolicy = { getResidencyRegion: spy };
    const cached = new CachedResidencyPolicy(inner, 1_000); // 1 second TTL
    await cached.getResidencyRegion(tenantId("tenant-a"));
    // Advance past TTL.
    vi.setSystemTime(FROZEN_EPOCH_MS + 2_000);
    await cached.getResidencyRegion(tenantId("tenant-a"));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("caches null (no residency) correctly", async () => {
    const spy = vi.fn().mockResolvedValue(null);
    const inner: ResidencyPolicy = { getResidencyRegion: spy };
    const cached = new CachedResidencyPolicy(inner, 60_000);
    const r1 = await cached.getResidencyRegion(tenantId("tenant-a"));
    const r2 = await cached.getResidencyRegion(tenantId("tenant-a"));
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("caches different tenants independently", async () => {
    const spy = vi.fn((id: string) => Promise.resolve(id === "tenant-eu" ? EU : US));
    const inner: ResidencyPolicy = { getResidencyRegion: spy };
    const cached = new CachedResidencyPolicy(inner, 60_000);
    const r1 = await cached.getResidencyRegion(tenantId("tenant-eu"));
    const r2 = await cached.getResidencyRegion(tenantId("tenant-us"));
    expect(r1).toBe("EU");
    expect(r2).toBe("US");
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
