/**
 * `RegionConfigStore` — a small lookup map from region code to
 * per-region endpoint and timeout configuration.
 *
 * This replaces trellis's `region-config.ts` (630 LOC). The feature-flag
 * enum from that file does NOT graduate — per
 * `doc/foundation/09-region-and-residency.md`, the toggle vocabulary is
 * consumer-defined.
 *
 * Pure module; no I/O.
 */

import type { Region } from "./types.js";

export interface RegionEndpoints {
  readonly api: string;
  readonly frontend?: string;
  readonly cdn?: string;
}

export interface RegionTimeouts {
  readonly apiMs?: number;
  readonly databaseMs?: number;
  readonly storageMs?: number;
}

export interface RegionConfig {
  readonly region: Region;
  readonly endpoints: RegionEndpoints;
  readonly timeouts?: RegionTimeouts;
}

export class RegionConfigStore {
  private readonly map: ReadonlyMap<string, RegionConfig>;

  public constructor(configs: ReadonlyArray<RegionConfig>) {
    const entries = configs.map((c) => [c.region, c] as const);
    this.map = new Map(entries);
  }

  public get(r: Region): RegionConfig | null {
    return this.map.get(r) ?? null;
  }
}
