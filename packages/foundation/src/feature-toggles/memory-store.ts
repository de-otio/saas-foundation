/**
 * `MemoryFeatureToggleStore` — in-memory feature-toggle store for tests.
 *
 * IMPORTANT: This implementation is NOT production-safe.
 *
 *   - State is per-process; cross-process callers see independent stores.
 *   - On process restart all state is lost.
 *
 * Exported, marked `@beta-test-only`. Use `PrismaFeatureToggleStore`
 * (sub-path `@de-otio/saas-foundation/feature-toggles/prisma`) in
 * production.
 *
 * @beta-test-only
 */

import type { FeatureToggle, FeatureToggleStore, SetToggleInput } from "./store.js";

/**
 * In-memory feature-toggle store for tests.
 *
 * Optionally seeded with an initial set of enabled keys.
 *
 * @beta-test-only — not cross-process safe; use `PrismaFeatureToggleStore`
 * in production.
 */
export class MemoryFeatureToggleStore implements FeatureToggleStore {
  private readonly toggles = new Map<string, FeatureToggle>();

  /**
   * @param initial  Map of `key → enabled` for quick test setup.
   *                 All entries are stamped with `changedAt = new Date(0)`
   *                 and `changedBy = 'seed'` as a fixed epoch anchor.
   */
  public constructor(initial?: Record<string, boolean>) {
    if (initial !== undefined) {
      for (const [key, enabled] of Object.entries(initial)) {
        this.toggles.set(key, {
          key,
          enabled,
          changedAt: new Date(0),
          changedBy: "seed",
        });
      }
    }
  }

  public isEnabled(key: string): Promise<boolean> {
    return Promise.resolve(this.toggles.get(key)?.enabled ?? false);
  }

  public get(key: string): Promise<FeatureToggle | null> {
    return Promise.resolve(this.toggles.get(key) ?? null);
  }

  public list(): Promise<ReadonlyArray<FeatureToggle>> {
    return Promise.resolve(
      Array.from(this.toggles.values()).sort((a, b) => a.key.localeCompare(b.key)),
    );
  }

  public set(
    input: SetToggleInput,
  ): Promise<{ previous: FeatureToggle | null; current: FeatureToggle }> {
    const previous = this.toggles.get(input.key) ?? null;
    const resolvedDescription = input.description ?? previous?.description;
    const current: FeatureToggle = {
      key: input.key,
      enabled: input.enabled,
      changedAt: new Date(),
      changedBy: input.changedBy,
      ...(resolvedDescription !== undefined ? { description: resolvedDescription } : {}),
    };
    this.toggles.set(input.key, current);
    return Promise.resolve({ previous, current });
  }

  public delete(key: string): Promise<void> {
    this.toggles.delete(key);
    return Promise.resolve();
  }
}
