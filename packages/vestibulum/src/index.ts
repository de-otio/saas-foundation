/**
 * `@de-otio/vestibulum` top-level barrel.
 *
 * Per doc/03-package-relationships.md § Frozen-set re-exports,
 * vestibulum re-exports the foundation-owned frozen types so
 * consumers of vestibulum get a single import surface and don't
 * have to know which package the type was minted in.
 *
 * Re-export, never re-define — duplicate type definitions in two
 * packages create two distinct identities and the type checker
 * loses its ability to catch shape mismatches.
 */

// Re-export foundation's frozen types so vestibulum consumers get a flat surface
export type {
  TenantId,
  TenantIdConstraints,
  AuditEvent,
  AuditActor,
  AuditAction,
  AuditResource,
  AuditSeverity,
  AuditOutcome,
  JsonValue,
  JsonObject,
  JsonArray,
  JsonPrimitive,
  RequestContext,
  Principal,
  SecretRef,
} from "@de-otio/saas-foundation";

// Re-export the foundation frozen-type runtime helpers (constructors, predicates)
export {
  TENANT_ID_CONSTRAINTS,
  TenantIdValidationError,
  tenantId,
  isTenantId,
  SecretRefValidationError,
  secretRef,
  isSecretRef,
} from "@de-otio/saas-foundation";

// Re-export foundation Zod schemas
export {
  TenantIdSchema,
  SecretRefSchema,
  AuditEventSchema,
  AuditActorSchema,
  AuditActionSchema,
  AuditResourceSchema,
  AuditSeveritySchema,
  AuditOutcomeSchema,
  JsonValueSchema,
  PrincipalSchema,
  RequestContextSchema,
} from "@de-otio/saas-foundation";

// Vestibulum-owned frozen types
export type {
  ClaimResolverInput,
  ClaimResolverOutput,
  ProvisionerInput,
  CallbackIdentity,
  KnownClaimTriggerSource,
  KnownProvisionerSource,
} from "./types/frozen/callbacks.js";

export { RESERVED_CLAIMS } from "./types/frozen/callbacks.js";

// ---- Runtime errors --------------------------------------------------------
export {
  VestibulumRuntimeError,
  OidcProbeError,
  SamlMetadataError,
  IdpManagerError,
  ReservedClaimError,
  MultiPoolVerifierError,
  IssuerVerifierError,
} from "./errors.js";
export type { MultiPoolVerifierReason, IssuerVerifierReason } from "./errors.js";

// ---- Multi-pool JWT verifier -----------------------------------------------
export {
  createMultiPoolVerifier,
  requirePool,
  canonicalIssuer,
} from "./verify/multi-pool-verifier.js";
export type { PoolConfig, VerifiedToken, MultiPoolVerifier } from "./verify/multi-pool-verifier.js";

// ---- Generic single-issuer OIDC verifier -----------------------------------
export { createIssuerVerifier } from "./verify/issuer-verifier.js";
export type {
  IssuerVerifierConfig,
  IssuerVerifiedToken,
  IssuerVerifier,
} from "./verify/issuer-verifier.js";
export { PERMITTED_ALGS } from "./verify/permitted-algs.js";

// ---- IdP managers ----------------------------------------------------------
export { OidcIdpManager } from "./idp/oidc-manager.js";
export type { OidcIdpRecord, OidcIdpInput } from "./idp/oidc-manager.js";
export { SamlIdpManager } from "./idp/saml-manager.js";
export type { SamlIdpRecord, SamlIdpInput } from "./idp/saml-manager.js";

// ---- Secrets client --------------------------------------------------------
export { IdpSecretsClient } from "./secrets/secrets-client.js";
export type { IdpSecretsClientProps, StoredSecret } from "./secrets/secrets-client.js";

// ---- Discovery -------------------------------------------------------------
export { probeOidcIssuer } from "./discovery/oidc-probe.js";
export { isPrivateAddress, isPrivateIPv4, isPrivateIPv6 } from "./discovery/private-ip.js";
export { parseSamlMetadata } from "./discovery/saml-metadata.js";
export type {
  SamlMetadata,
  SamlSignatureStatus,
  SamlCertificate,
  SamlAttributeDescriptor,
  SamlMetadataSource,
  ParseSamlMetadataOptions,
} from "./discovery/saml-metadata.js";

// ---- Pools -----------------------------------------------------------------
// `PoolConfig` has a single canonical definition in `pools/pool-config.ts`;
// it is exported above (re-exported through the verifier surface at
// `verify/multi-pool-verifier.js`). Here we export the remaining pool
// vocabulary — `PoolKind` and the `PoolRegistry` helper.
export type { PoolKind, PoolRegistry } from "./pools/index.js";
export { createPoolRegistry } from "./pools/index.js";

// ---- Profiles --------------------------------------------------------------
export {
  oidcProfileGeneric,
  oidcProfileEntra,
  oidcProfileOkta,
  oidcProfileAuth0,
  oidcProfileGoogleWorkspace,
  OIDC_PROFILES,
} from "./profiles/oidc.js";
export type { OidcProfile } from "./profiles/oidc.js";
export {
  samlProfileGeneric,
  samlProfileEntra,
  samlProfileAdfs,
  samlProfileOktaSaml,
  samlProfileShibboleth,
  SAML_PROFILES,
} from "./profiles/saml.js";
export type { SamlProfile } from "./profiles/saml.js";

// ---- SP metadata -----------------------------------------------------------
export { buildSpMetadata, wrapPem } from "./saml/sp-metadata.js";
export type { BuildSpMetadataProps, SpMetadata } from "./saml/sp-metadata.js";

// ---- Lambda trigger templates (B2: 10 factory exports) ---------------------

// Pre-token-generation handler factory
export { createPreTokenGenerationHandler } from "./lambda/pre-token-generation.js";
export type {
  PreTokenGenerationHandler,
  PreTokenGenerationCallbacks,
} from "./lambda/pre-token-generation.js";

// Post-confirmation handler factory
export { createPostConfirmationHandler } from "./lambda/post-confirmation.js";
export type {
  PostConfirmationHandler,
  PostConfirmationCallbacks,
} from "./lambda/post-confirmation.js";

// PreSignUp handler factory
export { createPreSignupHandler } from "./lambda/handlers/pre-signup/index.js";
export type { PreSignUpHandlerDeps } from "./lambda/handlers/pre-signup/index.js";

// DefineAuthChallenge handler factory
export { createDefineAuthChallengeHandler } from "./lambda/handlers/define-auth-challenge/index.js";

// CreateAuthChallenge handler factory
export { createCreateAuthChallengeHandler } from "./lambda/handlers/create-auth-challenge/index.js";
export type { CreateAuthChallengeHandlerDeps } from "./lambda/handlers/create-auth-challenge/index.js";

// VerifyAuthChallengeResponse handler factory
export { createVerifyAuthChallengeResponseHandler } from "./lambda/handlers/verify-auth-challenge/index.js";
export type { VerifyAuthChallengeHandlerDeps } from "./lambda/handlers/verify-auth-challenge/index.js";

// Bounce-handler factory
export { createBounceHandler } from "./lambda/handlers/bounce-handler/index.js";
export type { BounceHandlerDeps } from "./lambda/handlers/bounce-handler/index.js";

// Auth-verify handler factory
export { createAuthVerifyHandler } from "./lambda/handlers/auth-verify/index.js";
export type { AuthVerifyHandlerDeps } from "./lambda/handlers/auth-verify/index.js";

// Auth-login handler factory
export { createAuthLoginHandler } from "./lambda/handlers/auth-login/index.js";
export type { AuthLoginHandlerDeps } from "./lambda/handlers/auth-login/index.js";

// Auth-signout handler factory
export { createAuthSignoutHandler } from "./lambda/handlers/auth-signout/index.js";
export type { AuthSignoutHandlerDeps } from "./lambda/handlers/auth-signout/index.js";

// Lambda@Edge check-auth handler factory
export { createEdgeCheckAuthHandler } from "./lambda/edge/check-auth/index.js";
export type { VestibulumEdgeConfig } from "./lambda/edge/check-auth/index.js";

// ---- Runtime env constants -------------------------------------------------
export { RuntimeEnv } from "./lambda/shared/runtime-env.js";
export type { RuntimeEnvKey } from "./lambda/shared/runtime-env.js";

// v0.2 shared-distribution mode (additive, no breaking change to v0.1)
export * as sharedDistribution from "./lambda/shared-distribution/index.js";
