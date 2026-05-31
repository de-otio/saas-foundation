/**
 * Synth-time validation helpers for `MagicLinkIdentityProps`.
 *
 * Each helper throws `MagicLinkIdentityPropsError` with a precise message
 * naming the offending attribute / prop. The helpers are pure (no CDK
 * dependency) so the same logic is used in:
 *
 *   1. The construct constructor (eager errors before any L1 resource).
 *   2. The `FederationCustomAttributesAspect` (defence against the L1
 *      escape-hatch reaching past the construct surface).
 *
 * Federation-specific checks (mutable: false, worst-case token-size
 * estimate) live in the aspect — the aspect sees the final L1 shape
 * regardless of how attributes were added.
 *
 * See `doc/vestibulum-cdk/02-magic-link-identity.md § Custom attributes`
 * and the initial-review S-C2 / S-C3 entries.
 */

import { MagicLinkIdentityPropsError } from "./errors.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Declarative description of a single Cognito custom attribute.
 *
 * The bare name (without the `custom:` prefix Cognito adds automatically)
 * is what consumers reference in claim-resolver callbacks. For example,
 * `{ name: 'tenantId', dataType: 'String' }` becomes the `custom:tenantId`
 * claim on issued tokens.
 */
export interface CustomAttributeDeclaration {
  /**
   * Bare attribute name, without the `custom:` prefix.
   *
   * Must match `[a-zA-Z0-9_]+` and be **1–20 characters** (S-C2 — the
   * Cognito-documented length range, lower bound corrected from "≤20").
   * Cognito adds the prefix automatically; consumers reference the
   * attribute as `custom:{name}`.
   */
  readonly name: string;

  /**
   * Cognito attribute data type.
   *
   * `String` is the only type that honours `minLength` / `maxLength`.
   * `required` is ignored for non-String types (Cognito limitation).
   */
  readonly dataType: "String" | "Number" | "Boolean" | "DateTime";

  /**
   * Whether the attribute is mutable after first set.
   *
   * **Federation note:** `mutable: false` on a `federationEnabled: true`
   * pool is rejected by `FederationCustomAttributesAspect` because
   * Cognito's `AdminLinkProviderForUser` refuses any user with an
   * immutable custom attribute. The empirical claim is documented as
   * such — the aspect's severity is configurable (default `error`;
   * downgrade to `warning` per `severityForImmutableOnFederation` if the
   * claim is contradicted in your environment). See N3 in
   * `doc/review/2026-05-24-foundation-cdk-and-aws-verification.md`.
   *
   * @default true
   */
  readonly mutable?: boolean;

  /**
   * Whether the attribute is required at user-creation time.
   *
   * Ignored for non-String data types. `required: true` + `mutable: false`
   * is rejected at synth time — a federated user whose IdP doesn't
   * supply the attribute would never be creatable.
   *
   * @default false
   */
  readonly required?: boolean;

  /**
   * Minimum string length. Only meaningful for `dataType: 'String'`.
   *
   * @default - no minimum.
   */
  readonly minLength?: number;

  /**
   * Maximum string length. Only meaningful for `dataType: 'String'`.
   *
   * Used by `FederationCustomAttributesAspect` for the worst-case
   * ID-token-size estimate; consumers planning to issue large claim
   * values should declare `maxLength` realistically.
   *
   * @default - no maximum (Cognito enforces a 2048-char hard cap).
   */
  readonly maxLength?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum total custom attributes per Cognito user pool (hard quota).
 */
export const MAX_CUSTOM_ATTRIBUTES_PER_POOL = 50;

/**
 * Maximum length of a custom-attribute name (excluding the `custom:`
 * prefix Cognito adds). Per S-C2: 1–20 chars inclusive.
 */
export const MAX_CUSTOM_ATTRIBUTE_NAME_LENGTH = 20;

/** Minimum length of a custom-attribute name (S-C2). */
export const MIN_CUSTOM_ATTRIBUTE_NAME_LENGTH = 1;

/**
 * Regex Cognito uses for custom-attribute names.
 */
export const CUSTOM_ATTRIBUTE_NAME_REGEX = /^[a-zA-Z0-9_]+$/;

/**
 * Worst-case ID-token-size baseline for the standard claims (iss/sub/aud/
 * timing/Cognito-managed claims).
 *
 * S-C3 raised the baseline from 1.5 KB to 2.5 KB because real federated
 * tokens routinely carry 2–3 KB before the consumer's custom claims.
 */
export const BASE_CLAIMS_OVERHEAD_BYTES = 2_560; // 2.5 KiB

/**
 * Warning threshold — emit a synth warning when the worst-case estimate
 * crosses this size. Lowered from 6 KB to 5 KB in S-C3.
 */
export const TOKEN_SIZE_WARNING_THRESHOLD_BYTES = 5 * 1024;

/**
 * Hard error threshold — synth-error when the worst-case estimate crosses
 * this size. Tokens above ~8 KiB hit real proxy / cookie limits; 6 KB
 * worst-case leaves margin.
 */
export const TOKEN_SIZE_ERROR_THRESHOLD_BYTES = 6 * 1024;

/**
 * Threshold above which the aspect emits a "too many attributes" warning.
 */
export const TOO_MANY_ATTRIBUTES_WARNING_THRESHOLD = 10;

/**
 * Default Cognito attribute size when the consumer hasn't declared
 * `maxLength`. Used in the worst-case token-size estimate.
 */
export const DEFAULT_ATTRIBUTE_SIZE_BYTES = 256;

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/**
 * Validate an array of `CustomAttributeDeclaration` against Cognito's
 * pool-level rules. Throws on the first violation.
 *
 * Federation-specific checks (mutable: false on federation pool, token-size
 * warnings/errors) are NOT run here — see the aspect for those.
 */
export function validateCustomAttributeDeclarations(
  declarations: readonly CustomAttributeDeclaration[],
): void {
  if (declarations.length > MAX_CUSTOM_ATTRIBUTES_PER_POOL) {
    throw new MagicLinkIdentityPropsError(
      `[vestibulum-cdk:MagicLinkIdentity] Cognito permits at most ` +
        `${MAX_CUSTOM_ATTRIBUTES_PER_POOL} custom attributes per user pool; ` +
        `got ${declarations.length}. Cognito does not permit removing ` +
        `custom attributes after pool creation — reduce the list before ` +
        `deploying.`,
    );
  }

  const seenNames = new Set<string>();
  for (const decl of declarations) {
    if (!CUSTOM_ATTRIBUTE_NAME_REGEX.test(decl.name)) {
      throw new MagicLinkIdentityPropsError(
        `[vestibulum-cdk:MagicLinkIdentity] custom attribute name ` +
          `'${decl.name}' does not match Cognito's required regex ` +
          `/[a-zA-Z0-9_]+/. Names must contain only ASCII alphanumerics ` +
          `and underscores; the 'custom:' prefix is added by Cognito.`,
      );
    }
    if (
      decl.name.length < MIN_CUSTOM_ATTRIBUTE_NAME_LENGTH ||
      decl.name.length > MAX_CUSTOM_ATTRIBUTE_NAME_LENGTH
    ) {
      throw new MagicLinkIdentityPropsError(
        `[vestibulum-cdk:MagicLinkIdentity] custom attribute name ` +
          `'${decl.name}' is ${decl.name.length} chars; Cognito requires ` +
          `1–${MAX_CUSTOM_ATTRIBUTE_NAME_LENGTH} chars (excluding the ` +
          `'custom:' prefix).`,
      );
    }
    if (seenNames.has(decl.name)) {
      throw new MagicLinkIdentityPropsError(
        `[vestibulum-cdk:MagicLinkIdentity] duplicate custom attribute ` +
          `name '${decl.name}'. Each name must be unique within the pool.`,
      );
    }
    seenNames.add(decl.name);

    if (decl.required === true && decl.mutable === false) {
      throw new MagicLinkIdentityPropsError(
        `[vestibulum-cdk:MagicLinkIdentity] custom attribute ` +
          `'${decl.name}' is both required and immutable (mutable: false). ` +
          `A federated user whose upstream IdP does not supply this ` +
          `attribute can never be created — Cognito rejects the user. ` +
          `Pick one: required, or immutable, not both.`,
      );
    }

    if (
      decl.dataType !== "String" &&
      (decl.minLength !== undefined || decl.maxLength !== undefined)
    ) {
      throw new MagicLinkIdentityPropsError(
        `[vestibulum-cdk:MagicLinkIdentity] custom attribute ` +
          `'${decl.name}' is ${decl.dataType}; minLength/maxLength are ` +
          `only meaningful for String attributes.`,
      );
    }

    if (
      decl.minLength !== undefined &&
      decl.maxLength !== undefined &&
      decl.minLength > decl.maxLength
    ) {
      throw new MagicLinkIdentityPropsError(
        `[vestibulum-cdk:MagicLinkIdentity] custom attribute ` +
          `'${decl.name}' has minLength (${decl.minLength}) greater than ` +
          `maxLength (${decl.maxLength}).`,
      );
    }
  }
}

/**
 * Worst-case ID-token-size estimate for a set of declarations.
 *
 * Sums the per-attribute `maxLength` (defaulting to
 * `DEFAULT_ATTRIBUTE_SIZE_BYTES`) plus the JSON key-overhead per claim,
 * and adds the base claims overhead.
 *
 * Used both at construct-construction time (to error eagerly when the
 * estimate exceeds `TOKEN_SIZE_ERROR_THRESHOLD_BYTES`) and inside the
 * federation aspect (which sees the final L1 shape).
 */
export function estimateTokenSizeBytes(
  declarations: readonly CustomAttributeDeclaration[],
): number {
  let total = BASE_CLAIMS_OVERHEAD_BYTES;
  for (const decl of declarations) {
    const len = decl.maxLength ?? DEFAULT_ATTRIBUTE_SIZE_BYTES;
    // JSON overhead for one claim: `"custom:name":"...."` plus the
    // separating comma. Worst case ≈ 12 + name.length bytes.
    const keyOverhead = `"custom:${decl.name}":"",`.length;
    total += len + keyOverhead;
  }
  return total;
}

/**
 * Validate the worst-case token-size estimate. Throws if it exceeds the
 * **hard error** threshold; otherwise returns an object indicating whether
 * a warning should be raised (the caller — typically the construct
 * constructor — owns the CDK `Annotations` API and emits the warning).
 *
 * Pure so the helper is testable without CDK; the caller wires the
 * warning into the CDK Annotations.
 */
export function validateTokenSize(declarations: readonly CustomAttributeDeclaration[]): {
  warning: string | undefined;
  estimateBytes: number;
} {
  const bytes = estimateTokenSizeBytes(declarations);
  if (bytes > TOKEN_SIZE_ERROR_THRESHOLD_BYTES) {
    throw new MagicLinkIdentityPropsError(
      `[vestibulum-cdk:MagicLinkIdentity] worst-case ID-token size ` +
        `estimate is ${bytes} bytes; error threshold is ` +
        `${TOKEN_SIZE_ERROR_THRESHOLD_BYTES} bytes (~6 KiB). Tokens above ` +
        `~8 KiB hit practical limits in cookie storage and HTTP header ` +
        `size. Reduce maxLength on the largest attributes, or move bulky ` +
        `claims into a server-side lookup keyed by 'sub'.`,
    );
  }
  if (bytes > TOKEN_SIZE_WARNING_THRESHOLD_BYTES) {
    return {
      estimateBytes: bytes,
      warning:
        `[vestibulum-cdk:MagicLinkIdentity] worst-case ID-token size ` +
        `estimate is ${bytes} bytes (warning threshold: ` +
        `${TOKEN_SIZE_WARNING_THRESHOLD_BYTES}). Tokens above ~8 KiB ` +
        `risk proxy / cookie / header limits. Consider reducing ` +
        `maxLength or moving claims server-side.`,
    };
  }
  return { estimateBytes: bytes, warning: undefined };
}

/**
 * Validate the SES sender address. The construct also performs a
 * synth-time domain-vs-hosted-zone check; this helper just confirms
 * the address parses.
 */
export function validateSesIdentitySender(email: string): string {
  const at = email.indexOf("@");
  if (at < 0) {
    throw new MagicLinkIdentityPropsError(
      `[vestibulum-cdk:MagicLinkIdentity] sesIdentitySender must be a ` +
        `fully-qualified email address; got '${email}'.`,
    );
  }
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length === 0 || domain.length === 0) {
    throw new MagicLinkIdentityPropsError(
      `[vestibulum-cdk:MagicLinkIdentity] sesIdentitySender must have ` +
        `non-empty local-part and domain; got '${email}'.`,
    );
  }
  return domain;
}

/**
 * Validate the sender domain matches (or is a subdomain of) the hosted-zone
 * domain. Without this, DKIM/SPF/DMARC records cannot be published into
 * the zone and SES verification fails downstream.
 */
export function validateSenderMatchesHostedZone(senderDomain: string, zoneName: string): void {
  const matches = senderDomain === zoneName || senderDomain.endsWith(`.${zoneName}`);
  if (!matches) {
    throw new MagicLinkIdentityPropsError(
      `[vestibulum-cdk:MagicLinkIdentity] sesIdentitySender domain ` +
        `'${senderDomain}' must match or be a subdomain of the hosted ` +
        `zone '${zoneName}'. Without the match, DKIM / SPF / DMARC ` +
        `records cannot be published into the zone and SES verification ` +
        `will fail.`,
    );
  }
}

/**
 * Validate the signup-mode + federation interaction.
 *
 * Per B-I and `02-magic-link-identity.md § Signup mode`: a federation-enabled
 * pool **must** declare `signupMode` explicitly. The open-registration
 * default would let strangers self-register into a B2B pool that
 * federation is supposed to gate.
 */
export function validateSignupModeForFederation(input: {
  readonly federationEnabled: boolean;
  readonly signupMode: SignupMode | undefined;
}): void {
  if (input.federationEnabled && input.signupMode === undefined) {
    throw new MagicLinkIdentityPropsError(
      `[vestibulum-cdk:MagicLinkIdentity] federationEnabled: true requires ` +
        `an explicit signupMode ('open' or 'admin-invite-only'). The ` +
        `default 'open' would let strangers self-register into a ` +
        `federation-gated pool — see doc/vestibulum-cdk/02-magic-link-` +
        `identity.md § Signup mode.`,
    );
  }
}

/**
 * Sign-up policy enforced by `PreSignUpFn`.
 *
 * Owned by `MagicLinkIdentity` (per B-I): the policy is enforced inside
 * `PreSignUpFn`, which the Identity owns; the Identity should own the
 * policy that drives it.
 *
 * - `'open'`: anyone with an email matching `allowedEmailDomains` (or any
 *   email if the list is empty) can request a magic link and self-register.
 * - `'admin-invite-only'`: `PreSignUpFn` rejects every `SignUp` API call.
 *   The only path to create a user becomes `AdminCreateUser`. Existing
 *   users continue to receive magic links; federation
 *   (`PreSignUp_ExternalProvider`) keeps working.
 *
 * Required when `federationEnabled: true`.
 */
export type SignupMode = "open" | "admin-invite-only";
