/**
 * Callback type definitions for the Cognito Lambda templates.
 *
 * These two interfaces — {@link ClaimResolver} and {@link Provisioner}
 * — plus their respective input / output types are the public contract
 * between Vestibulum's pre-token-generation / post-confirmation
 * handlers and consumer code.
 *
 * NOTE: The frozen-set versions of ClaimResolverInput and related
 * types live in src/types/frozen/callbacks.ts. These local definitions
 * serve as the runtime-internal shapes; the frozen-set shapes are
 * the canonical consumer-facing contract.
 *
 * B-K / H-3: `clientMetadata` is renamed to `untrustedClientMetadata`
 * in the frozen-set definition. The internal handler code uses the
 * frozen-set type; this file's types are the legacy runtime shapes used
 * by the cognito-events normalisation code. Where a handler constructs
 * a ClaimResolverInput to pass to the consumer callback it MUST use
 * `untrustedClientMetadata` from the frozen set.
 */

import type { Identity } from "../types/identity.js";

/**
 * Callback signature for the pre-token-generation Lambda template.
 */
export type ClaimResolver = (input: ClaimResolverInput) => Promise<ClaimResolverOutput>;

/**
 * Normalised input passed to the {@link ClaimResolver}.
 *
 * @deprecated Use `ClaimResolverInput` from `types/frozen/callbacks.ts`
 * for the consumer-facing contract (it has `untrustedClientMetadata`).
 * This type is internal to the handler implementation.
 */
export interface ClaimResolverInput {
  userSub: string;
  userAttributes: Record<string, string>;
  clientId: string;
  triggerSource: string;
  identity: Identity;
  federatedGroups: string[];
  isRefresh: boolean;
  /**
   * Caller-supplied metadata from `AdminRespondToAuthChallenge` /
   * `RespondToAuthChallenge`.
   *
   * **WARNING: caller-controlled untrusted input.** Cognito passes
   * `clientMetadata` through verbatim from the API caller; it is
   * not authenticated, not validated by Cognito, and not bound to
   * the user's session beyond the single API call. Treat every key
   * and value as adversarial. Do not derive authorisation
   * decisions from it without server-side cross-checks.
   *
   * H-3: this field is named `untrustedClientMetadata` in the
   * frozen-set definition to make the trust boundary visible at the
   * type level. Callers MUST NOT use this for authorization decisions.
   */
  untrustedClientMetadata: Record<string, string>;
}

/**
 * Claim / scope / group overrides returned by the {@link ClaimResolver}.
 */
export interface ClaimResolverOutput {
  claimsToAddOrOverride?: Record<string, string | number | boolean | string[]>;
  claimsToSuppress?: string[];
  groupsToOverride?: string[];
  iamRolesToOverride?: string[];
  preferredRole?: string;
  scopesToAdd?: string[];
  scopesToSuppress?: string[];
}

/**
 * Callback signature for the post-confirmation Lambda template.
 */
export type Provisioner = (input: ProvisionerInput) => Promise<void>;

/**
 * Normalised input passed to the {@link Provisioner}.
 */
export interface ProvisionerInput {
  userSub: string;
  userAttributes: Record<string, string>;
  clientId: string;
  triggerSource:
    | "PostConfirmation_ConfirmSignUp"
    | "PostConfirmation_ConfirmForgotPassword"
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- open-union pattern
    | (string & {});
  identity: Identity;
  /**
   * Caller-supplied metadata.
   *
   * **WARNING: caller-controlled untrusted input.** MUST NOT be used
   * for authorization decisions. H-3.
   */
  untrustedClientMetadata: Record<string, string>;
}
