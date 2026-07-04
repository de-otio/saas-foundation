/**
 * `PoolConfig` — runtime description of one Cognito user pool
 * participating in the multi-pool topology described in
 * doc/vestibulum/06-pool-topology.md.
 *
 * This module is the single canonical home of pool-shape vocabulary.
 * The JWT verifier (`verify/multi-pool-verifier.ts`) imports and
 * re-exports this `PoolConfig` rather than declaring its own, so
 * the verifier surface and the `pools/` namespace share one shape.
 *
 * Why the indirection: at v0.x, no consumer wires a separate pool
 * registry. The verifier's existing surface is the only entry point
 * that needs pool data. As SCIM / pool-aware IdP-manager helpers /
 * pool-specific feature toggles land in later versions, the
 * `pools/` namespace will host the shared vocabulary so each
 * consumer only configures their pool topology once. See
 * doc/vestibulum/06-pool-topology.md § Option B (two pools).
 */

/**
 * Discriminator for the pool's federation role.
 *
 * - `'B2C'` — magic-link / native sign-up pool, typically on the
 *   Cognito Lite tier. No federation.
 * - `'B2B'` — federation-enabled pool, typically on Essentials,
 *   issues custom-attribute-bearing tokens for enterprise tenants.
 *
 * Closed union: adding a new kind requires an RFC. The verifier
 * uses `kind` only as an annotation today; future helpers will
 * branch on it (e.g. the SCIM endpoint refuses installation on a
 * `kind: 'B2C'` pool).
 */
export type PoolKind = "B2C" | "B2B";

/**
 * Configuration for one Cognito user pool.
 *
 * This is the one definition of the shape; the JWT verifier
 * (`verify/multi-pool-verifier.ts`) imports it directly. Consumer
 * code written against
 * `import type { PoolConfig } from '@de-otio/vestibulum'` resolves
 * to this type.
 */
export interface PoolConfig {
  /**
   * Stable identifier the consumer assigns (e.g. `'b2c'` or
   * `'b2b'`). Returned in the verified-token output so handlers
   * can branch on it. NOT the Cognito pool ID — see
   * doc/vestibulum/05-jwt-verification.md § The poolKey convention.
   */
  readonly poolKey: string;

  /** Cognito User Pool ID (e.g. `us-east-1_abcdef`). */
  readonly userPoolId: string;

  /**
   * The app client ID(s) that may legitimately issue tokens from
   * this pool. Matched against the JWT's `client_id` (access
   * tokens) or `aud` (ID tokens) claim.
   */
  readonly clientId: string | ReadonlyArray<string>;

  /** AWS region the user pool lives in. */
  readonly region: string;

  /**
   * Required `token_use` claim value. See
   * doc/vestibulum/05-jwt-verification.md § Pool-config shape.
   *
   * - `'access'` — only access tokens accepted (the API default).
   * - `'id'`     — only ID tokens accepted.
   * - `null`     — both accepted. **Discouraged**; weakens the
   *   `token_use` constraint to a no-op and defeats the defensive
   *   signal against token-confusion attacks. Recommend always
   *   pinning to `'access'` or `'id'` explicitly.
   */
  readonly tokenUse: "access" | "id" | null;

  /**
   * Optional federation-role annotation. Today the verifier ignores
   * this field; future helpers (SCIM endpoint, pool-aware IdP
   * manager methods) branch on it. Recommended values match
   * doc/vestibulum/06-pool-topology.md.
   */
  readonly kind?: PoolKind;
}
