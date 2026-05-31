/**
 * `FeatureToggleStore` — the read/write interface for boolean feature toggles.
 *
 * Foundation owns the _storage_ layer; consumers own the _toggle vocabulary_
 * (the enum of "what toggles exist and what they mean"). This interface
 * is what all implementations (`MemoryFeatureToggleStore`,
 * `PrismaFeatureToggleStore`) must satisfy.
 *
 * Key design choices:
 *   - `isEnabled` returns `false` for unknown keys (safe default).
 *     A flag that hasn't been deployed yet should not light up.
 *   - `set` performs an upsert (creates or updates) and returns the
 *     previous state, enabling single-call audit-event emission.
 *
 * @see doc/foundation/10-feature-toggles.md
 */

export interface FeatureToggle {
  readonly key: string;
  readonly enabled: boolean;
  readonly changedAt?: Date;
  readonly changedBy?: string;
  readonly description?: string;
}

export interface SetToggleInput {
  readonly key: string;
  readonly enabled: boolean;
  readonly changedBy: string;
  readonly description?: string;
}

export interface FeatureToggleStore {
  /**
   * Returns `false` if the toggle doesn't exist or on read error.
   * Never throws. Safe default: a missing toggle is treated as disabled.
   */
  isEnabled(key: string): Promise<boolean>;

  /**
   * Returns the full toggle record, or `null` if the key is not found.
   * Unlike `isEnabled`, this surfaces the distinction between
   * "not found" and "explicitly disabled".
   */
  get(key: string): Promise<FeatureToggle | null>;

  /** Returns all toggles in the store. */
  list(): Promise<ReadonlyArray<FeatureToggle>>;

  /**
   * Upsert a toggle. Returns `{ previous, current }` so the caller can
   * emit a meaningful audit event without a separate `get` call.
   */
  set(input: SetToggleInput): Promise<{ previous: FeatureToggle | null; current: FeatureToggle }>;

  /** Delete a toggle. No-ops if the key does not exist. */
  delete(key: string): Promise<void>;
}

export interface FeatureToggleStoreOptions {
  /** Cache TTL in milliseconds. Default 60_000 (1 minute). */
  readonly cacheTtlMs?: number;
  /** Disable the cache (for debugging). Default false. */
  readonly cacheDisabled?: boolean;
}
