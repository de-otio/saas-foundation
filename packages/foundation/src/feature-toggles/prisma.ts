/**
 * `PrismaFeatureToggleStore` — the Prisma-backed `FeatureToggleStore`.
 *
 * IMPORTANT: This file is the ONLY file under `src/feature-toggles/`
 * permitted to top-level `import { PrismaClient } from '@prisma/client'`.
 * The import-graph quarantine is what keeps `@prisma/client` an OPTIONAL
 * peer dependency in practice — see
 * `doc/foundation/01-package-api.md § Prisma sub-paths`.
 *
 * Consumers reach this file ONLY via the sub-path:
 *
 *   import { PrismaFeatureToggleStore } from "@de-otio/saas-foundation/feature-toggles/prisma";
 *
 * It is NOT re-exported from `@de-otio/saas-foundation/feature-toggles`
 * or the top-level barrel. An ESLint rule in `.eslintrc.cjs` forbids
 * `@prisma/client` imports in any other file under `src/feature-toggles/`.
 *
 * ## Cache
 *
 * A simple `Map<string, { value: boolean; expires: number }>` per
 * store instance. `isEnabled` checks the cache first; on miss it queries
 * the DB and populates. `set` and `delete` invalidate the entry.
 * The cache is per-store-instance — tests can construct a fresh store
 * with a fresh cache.
 *
 * ## Error handling
 *
 * `isEnabled` never throws — on DB error it logs and returns `false`.
 * This matches the trellis behaviour: a request that fails because the
 * feature-toggle DB is briefly unavailable is worse than a request
 * that proceeds with the default-off behaviour.
 *
 * `isTableMissingError` detects Prisma's `P2021` code and treats it
 * as "table not yet migrated" — returning `false` / empty list.
 */

// IMPORTANT: this file is the ONLY file under src/feature-toggles/
// permitted to top-level import `@prisma/client`. The ESLint rule in
// `.eslintrc.cjs` enforces the quarantine on the rest of `src/feature-toggles/`.
import { PrismaClient } from "@prisma/client";

import { getLogger } from "../logger/index.js";
import type {
  FeatureToggle,
  FeatureToggleStore,
  FeatureToggleStoreOptions,
  SetToggleInput,
} from "./store.js";

/** Default cache TTL — 60 seconds. */
const DEFAULT_CACHE_TTL_MS = 60_000;

/**
 * Subset of the Prisma client that this store actually uses. Stated
 * as a structural interface so tests can pass a mock without
 * constructing a full `PrismaClient`.
 */
export interface PrismaFeatureToggleClient {
  readonly featureToggle: {
    findUnique(args: {
      where: { key: string };
      select: {
        key: boolean;
        enabled: boolean;
        changedAt: boolean;
        changedBy: boolean;
        description: boolean;
      };
    }): Promise<{
      key: string;
      enabled: boolean;
      changedAt: Date;
      changedBy: string | null;
      description: string | null;
    } | null>;

    findMany(args: {
      select: {
        key: boolean;
        enabled: boolean;
        changedAt: boolean;
        changedBy: boolean;
        description: boolean;
      };
      orderBy: { key: "asc" | "desc" };
    }): Promise<
      Array<{
        key: string;
        enabled: boolean;
        changedAt: Date;
        changedBy: string | null;
        description: string | null;
      }>
    >;

    upsert(args: {
      where: { key: string };
      update: {
        enabled: boolean;
        changedBy: string;
        description?: string;
      };
      create: {
        key: string;
        enabled: boolean;
        changedBy: string;
        description?: string;
      };
      select: {
        key: boolean;
        enabled: boolean;
        changedAt: boolean;
        changedBy: boolean;
        description: boolean;
      };
    }): Promise<{
      key: string;
      enabled: boolean;
      changedAt: Date;
      changedBy: string | null;
      description: string | null;
    }>;

    delete(args: { where: { key: string } }): Promise<unknown>;
  };
}

interface CacheEntry {
  value: boolean;
  expires: number;
}

function isTableMissingError(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    if (code === "P2021") return true;
    // Also check the message for "does not exist" in case the error is
    // not a PrismaClientKnownRequestError but a generic error from
    // an older Prisma version.
    if (err.message.includes("does not exist")) return true;
  }
  return false;
}

function toFeatureToggle(row: {
  key: string;
  enabled: boolean;
  changedAt: Date;
  changedBy: string | null;
  description: string | null;
}): FeatureToggle {
  return {
    key: row.key,
    enabled: row.enabled,
    changedAt: row.changedAt,
    ...(row.changedBy !== null ? { changedBy: row.changedBy } : {}),
    ...(row.description !== null ? { description: row.description } : {}),
  };
}

export class PrismaFeatureToggleStore implements FeatureToggleStore {
  private readonly prisma: PrismaFeatureToggleClient;
  private readonly cacheTtlMs: number;
  private readonly cacheDisabled: boolean;
  private readonly cache = new Map<string, CacheEntry>();

  /**
   * @param prisma  A `PrismaClient` (or any object that implements the
   *                `PrismaFeatureToggleClient` structural shape). In
   *                production code the consumer passes `new PrismaClient()`.
   * @param options Cache options.
   */
  public constructor(prisma: PrismaFeatureToggleClient, options: FeatureToggleStoreOptions = {}) {
    this.prisma = prisma;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.cacheDisabled = options.cacheDisabled ?? false;
    // Compile-time reference to keep the value import "used".
    void PrismaClient;
  }

  public async isEnabled(key: string): Promise<boolean> {
    // Check cache first.
    if (!this.cacheDisabled) {
      const cached = this.cache.get(key);
      if (cached !== undefined && cached.expires > Date.now()) {
        return cached.value;
      }
    }

    try {
      const row = await this.prisma.featureToggle.findUnique({
        where: { key },
        select: {
          key: true,
          enabled: true,
          changedAt: true,
          changedBy: true,
          description: true,
        },
      });

      const value = row?.enabled ?? false;

      if (!this.cacheDisabled) {
        this.cache.set(key, { value, expires: Date.now() + this.cacheTtlMs });
      }

      return value;
    } catch (err) {
      if (isTableMissingError(err)) {
        getLogger().warn({ err, key }, "feature_toggles table missing; defaulting to false");
        return false;
      }
      getLogger().error({ err, key }, "feature toggle read failed");
      return false;
    }
  }

  public async get(key: string): Promise<FeatureToggle | null> {
    try {
      const row = await this.prisma.featureToggle.findUnique({
        where: { key },
        select: {
          key: true,
          enabled: true,
          changedAt: true,
          changedBy: true,
          description: true,
        },
      });
      return row !== null ? toFeatureToggle(row) : null;
    } catch (err) {
      if (isTableMissingError(err)) {
        getLogger().warn({ err, key }, "feature_toggles table missing; get returning null");
        return null;
      }
      getLogger().error({ err, key }, "feature toggle get failed");
      return null;
    }
  }

  public async list(): Promise<ReadonlyArray<FeatureToggle>> {
    try {
      const rows = await this.prisma.featureToggle.findMany({
        select: {
          key: true,
          enabled: true,
          changedAt: true,
          changedBy: true,
          description: true,
        },
        orderBy: { key: "asc" },
      });
      return rows.map(toFeatureToggle);
    } catch (err) {
      if (isTableMissingError(err)) {
        getLogger().warn({ err }, "feature_toggles table missing; list returning []");
        return [];
      }
      getLogger().error({ err }, "feature toggle list failed");
      return [];
    }
  }

  public async set(
    input: SetToggleInput,
  ): Promise<{ previous: FeatureToggle | null; current: FeatureToggle }> {
    // Read previous state for the return value.
    const previous = await this.get(input.key);

    const row = await this.prisma.featureToggle.upsert({
      where: { key: input.key },
      update: {
        enabled: input.enabled,
        changedBy: input.changedBy,
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
      create: {
        key: input.key,
        enabled: input.enabled,
        changedBy: input.changedBy,
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
      select: {
        key: true,
        enabled: true,
        changedAt: true,
        changedBy: true,
        description: true,
      },
    });

    const current = toFeatureToggle(row);

    // Invalidate cache.
    this.cache.delete(input.key);

    return { previous, current };
  }

  public async delete(key: string): Promise<void> {
    try {
      await this.prisma.featureToggle.delete({ where: { key } });
    } catch (err) {
      // P2025 = record not found — treat as no-op.
      const code = (err as { code?: string }).code;
      if (code !== "P2025") {
        throw err;
      }
    } finally {
      this.cache.delete(key);
    }
  }
}
