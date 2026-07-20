/**
 * `@de-otio/saas-foundation/secrets` — module barrel.
 *
 * Re-exports `SecretRef` (type), `secretRef` (factory) and
 * `isSecretRef` (predicate) from the frozen-types directory for
 * ergonomic consumer imports — a consumer only needs to depend on
 * `/secrets` to get both the type and the resolver.
 *
 * The frozen-set CI fanout gate still watches the canonical location
 * (`src/types/frozen/secrets.ts`); this barrel is pure re-export.
 */

// Frozen type + value re-exports
export type { SecretRef } from "../types/frozen/secrets.js";
export { SecretRefValidationError, secretRef, isSecretRef } from "../types/frozen/secrets.js";

// Schemas
export { SecretRefSchema } from "./schemas.js";

// Cache
export { SecretCache, type SecretCacheOptions } from "./cache.js";

// Resolvers
export {
  resolveSecret,
  resolveParameter,
  type ResolveContext,
  type ResolveSecretOptions,
  type ResolveParameterOptions,
} from "./resolve.js";

// Client factories
export {
  createDefaultSecretsManagerClient,
  createDefaultSsmClient,
  type DefaultClientOptions,
} from "./clients.js";

// Test doubles
export {
  MemorySecretStore,
  type MemorySecretSeed,
  type MemoryParameterSeed,
} from "./memory-secret-store.js";

// Scaleway Secret Manager backend (WS-5) + env-driven provider selection
export {
  resolveScalewaySecret,
  scalewaySecretRef,
  resolveSecretsProvider,
  ScalewaySecretRefValidationError,
  _resetScalewayDefaultCacheForTests,
  type ScalewaySecretRef,
  type ScalewayResolveContext,
  type ResolveScalewaySecretOptions,
  type SecretsProvider,
} from "./scaleway.js";

// Errors
export {
  SecretsResolveError,
  SecretsNotFoundError,
  SecretsAccessDeniedError,
  SecretsTransientError,
  ParameterNotFoundError,
  ParameterAccessDeniedError,
} from "./errors.js";
