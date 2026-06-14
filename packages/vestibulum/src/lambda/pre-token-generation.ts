/**
 * Factory for the Cognito pre-token-generation Lambda template.
 *
 * Consumers supply a {@link ClaimResolver} callback (and optionally
 * an `onError` hook) and receive a complete Lambda handler that:
 *
 *  1. Normalises V1 and V2 Cognito events into a single
 *     {@link ClaimResolverInput} shape.
 *  2. Invokes the consumer callback.
 *  3. Validates the returned claims against {@link RESERVED_CLAIMS};
 *     reserved entries raise {@link ReservedClaimError}.
 *  4. Applies the claims via the V1 `claimsOverrideDetails` /
 *     V2 `claimsAndScopeOverrideDetails` response shape.
 *  5. On any thrown error, invokes `onError` **first**, then
 *     rethrows so Cognito fails the token issuance. Silently
 *     issuing a token without the expected claims is worse than
 *     failing the login — see
 *     doc/federation/02-runtime-api.md § createPreTokenGenerationHandler.
 *
 * See doc/federation/02-runtime-api.md § createPreTokenGenerationHandler.
 */

import { ReservedClaimError } from "../errors.js";
import type { ClaimResolver, ClaimResolverInput, ClaimResolverOutput } from "../callbacks/types.js";
import { isReservedClaim } from "../types/reserved-claims.js";
import {
  detectPreTokenEventVersion,
  parseFederatedGroups,
  parseIdentityFromUserAttributes,
  type PreTokenGenerationEvent,
  type PreTokenGenerationV1Event,
  type PreTokenGenerationV2Event,
} from "./cognito-events.js";

/**
 * Cognito pre-token-generation handler. Returns the (mutated) event
 * — Cognito reads the response off the same object.
 */
export type PreTokenGenerationHandler = (
  event: PreTokenGenerationEvent,
) => Promise<PreTokenGenerationEvent>;

/**
 * Callbacks passed to {@link createPreTokenGenerationHandler}.
 */
export interface PreTokenGenerationCallbacks {
  /** Consumer-supplied claim resolver. */
  resolveClaims: ClaimResolver;

  /**
   * Optional error hook. Invoked with `(err, event)` before the
   * handler rethrows; intended for the consumer's observability
   * stack. Synchronous; if the hook itself throws, that error is
   * swallowed and the original error is rethrown — the hook must
   * never mask a token-generation failure.
   */
  onError?: (err: unknown, event: PreTokenGenerationEvent) => void;
}

/**
 * Build a pre-token-generation Lambda handler from a
 * {@link ClaimResolver} callback.
 */
export function createPreTokenGenerationHandler(
  callbacks: PreTokenGenerationCallbacks,
): PreTokenGenerationHandler {
  const { resolveClaims, onError } = callbacks;

  return async (event) => {
    try {
      const version = detectPreTokenEventVersion(event);

      // B-K/H-3: `untrustedClientMetadata` makes the trust boundary
      // visible at the type level. The raw `clientMetadata` from the
      // Cognito event is UNTRUSTED input — callers MUST NOT use it
      // for authorization decisions.
      const input: ClaimResolverInput = {
        userSub: event.userName,
        userAttributes: event.request.userAttributes,
        clientId: event.callerContext.clientId,
        triggerSource: event.triggerSource,
        identity: parseIdentityFromUserAttributes(event.request.userAttributes),
        federatedGroups: parseFederatedGroups(event.request.userAttributes),
        isRefresh: event.triggerSource === "TokenGeneration_RefreshTokens",
        untrustedClientMetadata: event.request.clientMetadata ?? {},
      };

      const output = await resolveClaims(input);

      // Validate against the reserved-claims allowlist BEFORE
      // mutating the event. A reserved claim is a programming bug
      // in the consumer; failing the request rather than silently
      // dropping it gives them a clear signal.
      if (output.claimsToAddOrOverride) {
        for (const claimName of Object.keys(output.claimsToAddOrOverride)) {
          if (isReservedClaim(claimName)) {
            throw new ReservedClaimError(claimName);
          }
        }
      }

      if (version === "v2") {
        applyV2Response(event as PreTokenGenerationV2Event, output);
      } else {
        applyV1Response(event as PreTokenGenerationV1Event, output);
      }

      return event;
    } catch (err) {
      if (onError) {
        try {
          onError(err, event);
        } catch {
          // Swallow onError throws. The original error matters more
          // than the observability hook's failure.
        }
      }
      throw err;
    }
  };
}

/**
 * Convert a {@link ClaimResolverOutput.claimsToAddOrOverride} value
 * into the `Record<string, string>` shape Cognito expects on the
 * wire. Arrays and booleans are stringified; numbers go through
 * `String()`.
 */
function stringifyClaimValues(
  claims: Record<string, string | number | boolean | string[]>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(claims)) {
    if (Array.isArray(value)) {
      // Cognito accepts JSON-encoded arrays in claim values; the
      // resulting JWT carries the parsed array.
      out[key] = JSON.stringify(value);
    } else if (typeof value === "boolean" || typeof value === "number") {
      out[key] = String(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Apply the resolver output to a V1 event. V2-only fields
 * (`scopesToAdd`, `scopesToSuppress`) are silently no-op'd with a
 * `console.debug` audit line — emitting them as warnings would force
 * callbacks to know which event version they were invoked under.
 */
function applyV1Response(event: PreTokenGenerationV1Event, output: ClaimResolverOutput): void {
  const claimsOverrideDetails: NonNullable<
    PreTokenGenerationV1Event["response"]["claimsOverrideDetails"]
  > = {};

  if (output.claimsToAddOrOverride) {
    claimsOverrideDetails.claimsToAddOrOverride = stringifyClaimValues(
      output.claimsToAddOrOverride,
    );
  }
  if (output.claimsToSuppress) {
    claimsOverrideDetails.claimsToSuppress = output.claimsToSuppress;
  }

  const groupOverrideDetails: NonNullable<
    NonNullable<
      PreTokenGenerationV1Event["response"]["claimsOverrideDetails"]
    >["groupOverrideDetails"]
  > = {};
  let hasGroupOverride = false;
  if (output.groupsToOverride) {
    groupOverrideDetails.groupsToOverride = output.groupsToOverride;
    hasGroupOverride = true;
  }
  if (output.iamRolesToOverride) {
    groupOverrideDetails.iamRolesToOverride = output.iamRolesToOverride;
    hasGroupOverride = true;
  }
  if (output.preferredRole !== undefined) {
    groupOverrideDetails.preferredRole = output.preferredRole;
    hasGroupOverride = true;
  }
  if (hasGroupOverride) {
    claimsOverrideDetails.groupOverrideDetails = groupOverrideDetails;
  }

  if (output.scopesToAdd || output.scopesToSuppress) {
    // V1 events have no access-token surface; the scope fields are
    // a no-op here. Surface a debug line so misconfigurations are
    // diagnosable from CloudWatch without surfacing a hard error
    // (which would break consumers running V1 callbacks on V1
    // pools deliberately).
    // eslint-disable-next-line no-console
    console.debug(
      "vestibulum-runtime: scopesToAdd/scopesToSuppress ignored on V1 " +
        "pre-token-generation event (V2/V3 events only).",
    );
  }

  event.response = { claimsOverrideDetails };
}

/**
 * Apply the resolver output to a V2 event. Cognito's V2 shape
 * separates ID-token and access-token claim surfaces; the runtime
 * mirrors the resolver's
 * {@link ClaimResolverOutput.claimsToAddOrOverride} into both, so
 * a consumer setting `custom:tenant_id` sees it on every issued
 * token. Consumers who need ID-only or access-only behaviour can
 * call the underlying SDK shape directly (escape hatch outside the
 * template's scope; cf. design doc § Lambda templates).
 */
function applyV2Response(event: PreTokenGenerationV2Event, output: ClaimResolverOutput): void {
  const claimsAndScopeOverrideDetails: NonNullable<
    PreTokenGenerationV2Event["response"]["claimsAndScopeOverrideDetails"]
  > = {};

  const idTokenGeneration: NonNullable<
    NonNullable<
      PreTokenGenerationV2Event["response"]["claimsAndScopeOverrideDetails"]
    >["idTokenGeneration"]
  > = {};
  let hasId = false;
  if (output.claimsToAddOrOverride) {
    idTokenGeneration.claimsToAddOrOverride = stringifyClaimValues(output.claimsToAddOrOverride);
    hasId = true;
  }
  if (output.claimsToSuppress) {
    idTokenGeneration.claimsToSuppress = output.claimsToSuppress;
    hasId = true;
  }
  if (hasId) {
    claimsAndScopeOverrideDetails.idTokenGeneration = idTokenGeneration;
  }

  const accessTokenGeneration: NonNullable<
    NonNullable<
      PreTokenGenerationV2Event["response"]["claimsAndScopeOverrideDetails"]
    >["accessTokenGeneration"]
  > = {};
  let hasAccess = false;
  if (output.claimsToAddOrOverride) {
    accessTokenGeneration.claimsToAddOrOverride = stringifyClaimValues(
      output.claimsToAddOrOverride,
    );
    hasAccess = true;
  }
  if (output.claimsToSuppress) {
    accessTokenGeneration.claimsToSuppress = output.claimsToSuppress;
    hasAccess = true;
  }
  if (output.scopesToAdd) {
    accessTokenGeneration.scopesToAdd = output.scopesToAdd;
    hasAccess = true;
  }
  if (output.scopesToSuppress) {
    accessTokenGeneration.scopesToSuppress = output.scopesToSuppress;
    hasAccess = true;
  }
  if (hasAccess) {
    claimsAndScopeOverrideDetails.accessTokenGeneration = accessTokenGeneration;
  }

  const groupOverrideDetails: NonNullable<
    NonNullable<
      PreTokenGenerationV2Event["response"]["claimsAndScopeOverrideDetails"]
    >["groupOverrideDetails"]
  > = {};
  let hasGroupOverride = false;
  if (output.groupsToOverride) {
    groupOverrideDetails.groupsToOverride = output.groupsToOverride;
    hasGroupOverride = true;
  }
  if (output.iamRolesToOverride) {
    groupOverrideDetails.iamRolesToOverride = output.iamRolesToOverride;
    hasGroupOverride = true;
  }
  if (output.preferredRole !== undefined) {
    groupOverrideDetails.preferredRole = output.preferredRole;
    hasGroupOverride = true;
  }
  if (hasGroupOverride) {
    claimsAndScopeOverrideDetails.groupOverrideDetails = groupOverrideDetails;
  }

  event.response = { claimsAndScopeOverrideDetails };
}
