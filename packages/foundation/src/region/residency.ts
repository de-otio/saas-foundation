/**
 * Residency policy primitives.
 *
 * Foundation defines the `ResidencyPolicy` contract; consumers provide
 * the implementation (typically a tenant-table lookup). Foundation ships
 * only `CachedResidencyPolicy` — a wrapper that adds per-instance TTL
 * caching around any `ResidencyPolicy`.
 *
 * ## Tenant → region mapping (consumer-supplied)
 *
 * `getResidencyRegionForTenant` is a convenience helper for deployments
 * that hold the mapping in a plain `Record<tenantId, Region>` — useful
 * for edge functions, tests, and small-scale deployments.
 *
 * ## No global singletons
 *
 * `CachedResidencyPolicy` is per-instance. Tests can construct isolated
 * instances without shared state.
 */

import type { TenantId } from "../types/frozen/tenant.js";
import type { Region } from "./types.js";

export interface ResidencyPolicy {
  /**
   * Return the residency region for a tenant, or `null` if the tenant
   * has no specific residency requirement (use the request's served
   * region as the effective region).
   */
  getResidencyRegion(tenantId: TenantId): Promise<Region | null>;
}

/**
 * `RegionResolution` — the outcome of resolving both the served-region
 * and the tenant's residency region for a request.
 */
export interface RegionResolution {
  /** The region where this request is being served. */
  readonly region: Region;
  /**
   * The region where the tenant's data must live. May differ from
   * `region` when a US-served request belongs to an EU-residency tenant.
   * Handlers that read/write tenant data should use `residencyRegion`.
   */
  readonly residencyRegion: Region;
}

/**
 * A `ResidencyPolicy` that wraps another policy and caches results in
 * a per-instance `Map` with a TTL.
 */
export class CachedResidencyPolicy implements ResidencyPolicy {
  private readonly cache = new Map<TenantId, { region: Region | null; expires: number }>();

  public constructor(
    private readonly inner: ResidencyPolicy,
    private readonly ttlMs = 60_000,
  ) {}

  public async getResidencyRegion(tenantId: TenantId): Promise<Region | null> {
    const cached = this.cache.get(tenantId);
    if (cached !== undefined && cached.expires > Date.now()) return cached.region;
    const r = await this.inner.getResidencyRegion(tenantId);
    this.cache.set(tenantId, { region: r, expires: Date.now() + this.ttlMs });
    return r;
  }
}

/**
 * Return the residency region for a tenant from a static mapping.
 *
 * Convenience helper for tests and small deployments that don't need a
 * full database-backed `ResidencyPolicy`.
 *
 * @param tenantId  The tenant whose residency region to look up.
 * @param mapping   A `Record<string, Region>` supplied by the consumer.
 *                  Can be partial — tenants not in the mapping return `null`.
 * @returns         The tenant's residency region, or `null` if not found.
 */
export function getResidencyRegionForTenant(
  tenantId: TenantId,
  mapping: Readonly<Record<string, Region>>,
): Region | null {
  return mapping[tenantId] ?? null;
}
