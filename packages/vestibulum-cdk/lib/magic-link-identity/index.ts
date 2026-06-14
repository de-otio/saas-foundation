/**
 * `MagicLinkIdentity` construct barrel.
 *
 * See `doc/vestibulum-cdk/02-magic-link-identity.md`.
 */

export { MagicLinkIdentity } from "./magic-link-identity.js";
export type {
  MagicLinkIdentityProps,
  HostedUiDomainProps,
  CustomAttributeDeclaration,
  SignupMode,
  FeatureTier,
  AdvancedSecurityMode,
  ImmutableAttributeSeverity,
  IdentityConfigMetadata,
} from "./magic-link-identity.js";

export { MagicLinkIdentityPropsError } from "./errors.js";

export {
  validateCustomAttributeDeclarations,
  validateSesIdentitySender,
  validateSenderMatchesHostedZone,
  validateSignupModeForFederation,
  validateTokenSize,
  estimateTokenSizeBytes,
  MAX_CUSTOM_ATTRIBUTES_PER_POOL,
  MAX_CUSTOM_ATTRIBUTE_NAME_LENGTH,
  MIN_CUSTOM_ATTRIBUTE_NAME_LENGTH,
  CUSTOM_ATTRIBUTE_NAME_REGEX,
  BASE_CLAIMS_OVERHEAD_BYTES,
  TOKEN_SIZE_WARNING_THRESHOLD_BYTES,
  TOKEN_SIZE_ERROR_THRESHOLD_BYTES,
  TOO_MANY_ATTRIBUTES_WARNING_THRESHOLD,
  DEFAULT_ATTRIBUTE_SIZE_BYTES,
} from "./prop-validation.js";

// Cost-DoS guard (S7) — opt-in extension to the documented cost-DoS
// envelope. See `doc/vestibulum-cdk/04-magic-link-auth-site.md`.
export type {
  CostDosGuardProps,
  CostDosGuardResources,
} from "../_internal/cost-dos-guard.js";
