/**
 * Error type hierarchy for vestibulum-runtime.
 *
 * Every error thrown across the public boundary extends
 * {@link VestibulumRuntimeError}. Subclasses carry a typed
 * `reason` discriminant so consumers can branch on the kind
 * of failure without parsing messages.
 */

/**
 * Base class for all runtime errors. Carries a stable
 * machine-readable `code` for log/observability use.
 *
 * Do not throw this class directly; throw a subclass.
 */
export class VestibulumRuntimeError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    // Preserve the prototype chain across the bundler boundary
    // so `instanceof VestibulumRuntimeError` works in tests.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Reasons returned by {@link OidcProbeError}.
 */
export type OidcProbeReason =
  | "unreachable"
  | "timeout"
  | "invalid_json"
  | "issuer_mismatch"
  | "unsupported_alg"
  | "too_large"
  | "not_https"
  | "ssrf_blocked_destination"
  | "unsupported_auth_method"
  | "redirect_blocked"
  | "url_too_long"
  | "url_has_credentials";

export class OidcProbeError extends VestibulumRuntimeError {
  public readonly reason: OidcProbeReason;

  constructor(reason: OidcProbeReason, message: string) {
    super(`oidc_probe.${reason}`, message);
    this.reason = reason;
  }
}

/**
 * Reasons returned by {@link SamlMetadataError}.
 */
export type SamlMetadataReason =
  | "invalid_xml"
  | "unsigned"
  | "expired"
  | "unsupported_binding"
  | "no_signing_cert"
  | "too_large"
  | "ssrf_blocked_destination"
  | "redirect_blocked"
  | "unreachable";

export class SamlMetadataError extends VestibulumRuntimeError {
  public readonly reason: SamlMetadataReason;

  constructor(reason: SamlMetadataReason, message: string) {
    super(`saml_metadata.${reason}`, message);
    this.reason = reason;
  }
}

/**
 * Reasons returned by {@link IdpManagerError}.
 */
export type IdpManagerReason =
  | "name_too_long"
  | "name_collision"
  | "cognito_quota"
  | "concurrent_modification"
  | "not_found"
  | "idp_identifier_invalid";

export class IdpManagerError extends VestibulumRuntimeError {
  public readonly reason: IdpManagerReason;

  constructor(reason: IdpManagerReason, message: string) {
    super(`idp_manager.${reason}`, message);
    this.reason = reason;
  }
}

/**
 * Thrown by {@link createPreTokenGenerationHandler} when a
 * consumer callback returns a claim name in the reserved set.
 */
export class ReservedClaimError extends VestibulumRuntimeError {
  public readonly claimName: string;

  constructor(claimName: string) {
    super(
      "reserved_claim",
      `Claim "${claimName}" is reserved by Cognito and cannot be ` +
        `overridden by the consumer callback. See doc/vestibulum/01-package-api.md ` +
        `§ Claim resolver callback for the full list, or import ` +
        `RESERVED_CLAIMS from the package index.`,
    );
    this.claimName = claimName;
  }
}

/**
 * Reasons returned by {@link MultiPoolVerifierError}.
 *
 * S-V1: includes `'wrong_pool'` for requirePool mismatches that
 * differ from unknown-issuer-level rejections.
 */
export type MultiPoolVerifierReason =
  | "unknown_issuer"
  | "expired"
  | "invalid_signature"
  | "wrong_client_id"
  | "wrong_token_use"
  | "malformed_token"
  | "wrong_pool";

export class MultiPoolVerifierError extends VestibulumRuntimeError {
  public readonly reason: MultiPoolVerifierReason;

  constructor(reason: MultiPoolVerifierReason, message: string) {
    super(`multi_pool_verifier.${reason}`, message);
    this.reason = reason;
  }
}
