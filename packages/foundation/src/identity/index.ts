/**
 * Identity module barrel (`@de-otio/saas-foundation/identity`).
 *
 * The provider-neutral {@link IdentityProviderPort} plus the Keycloak adapter.
 * Consumers select the adapter per deployment (env-driven factory in the
 * consuming app — the WS-1 `KV_PROVIDER` pattern); the Cognito adapter lives
 * with the consumer's existing CUSTOM_AUTH glue.
 */

export type {
  IdentityProviderPort,
  IdentityUser,
  MagicLinkInitiation,
  MagicLinkOptions,
} from "./port-types.js";

export { IdentityProviderError, type IdentityProviderErrorReason } from "./errors.js";
