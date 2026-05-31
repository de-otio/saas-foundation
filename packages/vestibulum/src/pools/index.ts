/**
 * Forward-compat pool topology vocabulary for vestibulum.
 *
 * In v0.x this module exports:
 * - The canonical {@link PoolConfig} shape (mirrors the verifier-local
 *   type in `verify/multi-pool-verifier.ts`).
 * - The {@link PoolKind} closed union (`'B2C' | 'B2B'`).
 * - A minimal {@link PoolRegistry} for consumers that pass pool data
 *   to more than one helper.
 *
 * Later versions will widen this surface — see
 * doc/vestibulum/06-pool-topology.md and
 * doc/vestibulum/07-scim-forward-compat.md. v0.x ships the minimum
 * the JWT verifier and IdP managers need, with documented stubs
 * for the rest.
 */

export type { PoolConfig, PoolKind } from "./pool-config.js";
export { createPoolRegistry } from "./pool-registry.js";
export type { PoolRegistry } from "./pool-registry.js";
