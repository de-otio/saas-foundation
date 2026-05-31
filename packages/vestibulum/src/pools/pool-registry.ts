/**
 * `PoolRegistry` — runtime catalog of the consumer's configured
 * Cognito user pools.
 *
 * v0.x scope: a minimal read-mostly registry that pool-aware
 * helpers (the multi-pool verifier, future pool-specific lambda
 * handlers) consume. The registry is constructed once at API
 * startup from the consumer's PoolConfig list and lives for the
 * process lifetime; runtime add/remove is intentionally NOT
 * supported (open question in doc/vestibulum/05-jwt-verification.md
 * § Open questions). The verifier ships its own internal map keyed
 * on canonical issuer URL; the registry here is the surface a
 * consumer can pass through to other helpers that need the same
 * data, without re-declaring the pool list.
 *
 * Why a separate module: each consumer otherwise declares pools
 * twice — once for the verifier, again for the SCIM endpoint (when
 * it lands), again for any pool-aware IdP-manager helper. The
 * registry collapses this to one declaration.
 */

import type { PoolConfig, PoolKind } from "./pool-config.js";

/**
 * Read-only registry of configured pools.
 *
 * Lookup is by `poolKey` (the consumer-assigned stable identifier
 * — not the Cognito user pool ID, see
 * doc/vestibulum/05-jwt-verification.md § The poolKey convention).
 * `get` returns `undefined` for unknown keys; callers should treat
 * that as a configuration error in their context.
 */
export interface PoolRegistry {
  /** Read one pool by its consumer-assigned stable key. */
  get(poolKey: string): PoolConfig | undefined;

  /** Iterate every configured pool. Order matches construction. */
  list(): ReadonlyArray<PoolConfig>;

  /**
   * Filter pools by their {@link PoolKind} annotation. Pools
   * without a `kind` are not returned (the consumer has not
   * declared which side they belong to).
   */
  byKind(kind: PoolKind): ReadonlyArray<PoolConfig>;
}

/**
 * Build a `PoolRegistry` from a `PoolConfig` array. Throws if two
 * pools share the same `poolKey` — a programming error, not a
 * runtime condition.
 *
 * The registry is intentionally immutable: pool changes require
 * a process restart. This matches the verifier's static-by-design
 * shape (doc/vestibulum/05-jwt-verification.md § Open questions —
 * "Should the verifier expose a way to add pools at runtime?").
 */
export function createPoolRegistry(pools: ReadonlyArray<PoolConfig>): PoolRegistry {
  if (pools.length === 0) {
    throw new Error("createPoolRegistry: at least one PoolConfig is required");
  }
  const byKey = new Map<string, PoolConfig>();
  for (const pool of pools) {
    if (byKey.has(pool.poolKey)) {
      throw new Error(`createPoolRegistry: duplicate poolKey "${pool.poolKey}"`);
    }
    byKey.set(pool.poolKey, pool);
  }
  // Defensive copy so the caller cannot mutate the registry's view.
  const frozen: ReadonlyArray<PoolConfig> = Object.freeze([...pools]);

  return {
    get(poolKey: string): PoolConfig | undefined {
      return byKey.get(poolKey);
    },
    list(): ReadonlyArray<PoolConfig> {
      return frozen;
    },
    byKind(kind: PoolKind): ReadonlyArray<PoolConfig> {
      return frozen.filter((p) => p.kind === kind);
    },
  };
}
