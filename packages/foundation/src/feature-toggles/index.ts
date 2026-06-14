/**
 * `@de-otio/saas-foundation/feature-toggles` barrel.
 *
 * DB-backed boolean toggle storage. Foundation owns the _storage_
 * layer; consumers own the _toggle vocabulary_.
 *
 * Public API:
 *   - `FeatureToggle`           — the toggle record shape
 *   - `FeatureToggleStore`      — the read/write interface
 *   - `SetToggleInput`          — input to `FeatureToggleStore.set`
 *   - `FeatureToggleStoreOptions` — cache configuration
 *   - `MemoryFeatureToggleStore` — in-memory store for tests
 *   - Named errors
 *
 * NOT re-exported here:
 *   - `PrismaFeatureToggleStore` — lives behind the sub-path
 *     `@de-otio/saas-foundation/feature-toggles/prisma`. The
 *     sub-path quarantine is critical for the optional-peer-dep
 *     pattern; see `doc/foundation/01-package-api.md § Prisma sub-paths`.
 *
 * @see doc/foundation/10-feature-toggles.md
 */

export type {
  FeatureToggle,
  FeatureToggleStore,
  SetToggleInput,
  FeatureToggleStoreOptions,
} from "./store.js";

/**
 * @beta-test-only — in-memory store for tests; not cross-process safe.
 */
export { MemoryFeatureToggleStore } from "./memory-store.js";

export { FeatureToggleConfigError, FeatureToggleNotFoundError } from "./errors.js";

export { SetToggleInputSchema, FeatureToggleStoreOptionsSchema } from "./schemas.js";
