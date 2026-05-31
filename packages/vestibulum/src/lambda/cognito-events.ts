/**
 * Internal helpers for normalising Cognito Lambda trigger events.
 *
 * Not part of the public API; consumed by
 * {@link createPreTokenGenerationHandler} and
 * {@link createPostConfirmationHandler}.
 *
 * The Cognito pre-token-generation trigger has three event versions
 * (V1 / V2 / V3) with subtly different request and response shapes.
 * V3 is structurally identical to V2 at the request level — the
 * differences are at the response shape for advanced scope handling
 * — and the runtime currently treats V3 as V2. (V3 dedicated support
 * is tracked as future work.) The post-confirmation trigger has a
 * single event shape.
 *
 * See doc/federation/02-runtime-api.md § Lambda templates.
 */

import type { Identity } from "../types/identity.js";

/**
 * Discriminator for the two event-shape families the
 * pre-token-generation handler accepts.
 *
 * `'v2'` covers both V2 and V3 Cognito events; the request-shape
 * differences relative to V1 are what matters for normalisation, and
 * V3 inherits V2's request shape.
 */
export type PreTokenEventVersion = "v1" | "v2";

/**
 * Minimal shape of the Cognito V1 pre-token-generation event the
 * runtime depends on. Modelled to match
 * `@types/aws-lambda`'s `PreTokenGenerationTriggerEvent` without
 * adding a hard dependency on that package — consumers' own Lambda
 * code is free to import either type for their handler signature.
 */
export interface PreTokenGenerationV1Event {
  version: string;
  region: string;
  userPoolId: string;
  triggerSource: string;
  userName: string;
  callerContext: {
    awsSdkVersion: string;
    clientId: string;
  };
  request: {
    userAttributes: Record<string, string>;
    groupConfiguration: {
      groupsToOverride?: string[];
      iamRolesToOverride?: string[];
      preferredRole?: string;
    };
    clientMetadata?: Record<string, string>;
  };
  response: {
    claimsOverrideDetails?: {
      claimsToAddOrOverride?: Record<string, string>;
      claimsToSuppress?: string[];
      groupOverrideDetails?: {
        groupsToOverride?: string[];
        iamRolesToOverride?: string[];
        preferredRole?: string;
      };
    };
  };
}

/**
 * Minimal shape of the Cognito V2 (and structurally-compatible V3)
 * pre-token-generation event.
 */
export interface PreTokenGenerationV2Event {
  version: string;
  region: string;
  userPoolId: string;
  triggerSource: string;
  userName: string;
  callerContext: {
    awsSdkVersion: string;
    clientId: string;
  };
  request: {
    userAttributes: Record<string, string>;
    groupConfiguration: {
      groupsToOverride?: string[];
      iamRolesToOverride?: string[];
      preferredRole?: string;
    };
    scopes?: string[];
    clientMetadata?: Record<string, string>;
  };
  response: {
    claimsAndScopeOverrideDetails?: {
      idTokenGeneration?: {
        claimsToAddOrOverride?: Record<string, string>;
        claimsToSuppress?: string[];
      };
      accessTokenGeneration?: {
        claimsToAddOrOverride?: Record<string, string>;
        claimsToSuppress?: string[];
        scopesToAdd?: string[];
        scopesToSuppress?: string[];
      };
      groupOverrideDetails?: {
        groupsToOverride?: string[];
        iamRolesToOverride?: string[];
        preferredRole?: string;
      };
    };
  };
}

/** Union of accepted pre-token-generation event versions. */
export type PreTokenGenerationEvent = PreTokenGenerationV1Event | PreTokenGenerationV2Event;

/**
 * Minimal shape of the Cognito post-confirmation event.
 *
 * Cognito documents two `triggerSource` values for this trigger
 * (`PostConfirmation_ConfirmSignUp`,
 * `PostConfirmation_ConfirmForgotPassword`); the field is left as
 * `string` here so future trigger sources (SCIM, etc.) can flow
 * through the same callback.
 */
export interface PostConfirmationEvent {
  version: string;
  region: string;
  userPoolId: string;
  triggerSource: string;
  userName: string;
  callerContext: {
    awsSdkVersion: string;
    clientId: string;
  };
  request: {
    userAttributes: Record<string, string>;
    clientMetadata?: Record<string, string>;
  };
  response: Record<string, never>;
}

/**
 * Branch the pre-token-generation event into V1 vs V2 based on the
 * presence of the V2-only `response.claimsAndScopeOverrideDetails`
 * field (or, redundantly, the V2-only `request.scopes` field). The
 * event's `version` field is unreliable for branching — older Cognito
 * deployments have shipped V1 events with `version: '2'` and V2 events
 * with `version: '1'` due to schema-version-vs-feature-version
 * confusion in the trigger payload.
 *
 * Falls back to V1 when neither V2 marker is present.
 */
export function detectPreTokenEventVersion(event: PreTokenGenerationEvent): PreTokenEventVersion {
  if ("claimsAndScopeOverrideDetails" in event.response) {
    return "v2";
  }
  if ("scopes" in event.request) {
    return "v2";
  }
  return "v1";
}

/**
 * Parse the `identities` user-attribute that Cognito populates for
 * federated users.
 *
 * The attribute is a JSON-stringified array of objects with shape:
 *
 * ```json
 * [
 *   {
 *     "userId": "...",
 *     "providerName": "tenant-acme",
 *     "providerType": "OIDC",
 *     "issuer": null,
 *     "primary": "true",
 *     "dateCreated": "1700000000000"
 *   }
 * ]
 * ```
 *
 * Returns `{ kind: 'cognito' }` if the attribute is absent, empty,
 * unparseable, or describes no entries. Returns
 * `{ kind: 'federated', ... }` carrying the first entry's
 * `providerName` and `providerType` otherwise.
 *
 * Unknown `providerType` values are coerced to `'OIDC'`: Cognito's
 * documented values are `OIDC`, `SAML`, `Facebook`, `Google`,
 * `LoginWithAmazon`, `SignInWithApple`. The runtime federation
 * surface only covers OIDC and SAML; treating social IdPs as OIDC
 * (which they structurally are at the Cognito level) keeps the
 * discriminator narrow without losing data.
 */
export function parseIdentityFromUserAttributes(userAttributes: Record<string, string>): Identity {
  const raw = userAttributes["identities"];
  if (raw === undefined || raw === null || raw === "") {
    return { kind: "cognito" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "cognito" };
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { kind: "cognito" };
  }

  const first = parsed[0] as { providerName?: unknown; providerType?: unknown } | undefined;
  if (!first || typeof first !== "object") {
    return { kind: "cognito" };
  }

  const providerName =
    typeof first.providerName === "string" && first.providerName !== ""
      ? first.providerName
      : undefined;
  if (providerName === undefined) {
    return { kind: "cognito" };
  }

  const rawProviderType = typeof first.providerType === "string" ? first.providerType : "";
  const providerType: "OIDC" | "SAML" = rawProviderType === "SAML" ? "SAML" : "OIDC";

  return { kind: "federated", providerName, providerType };
}

/**
 * Parse the `custom:idpGroups` user attribute into an array of group
 * names. Comma- and semicolon-separated; whitespace trimmed; empty
 * segments dropped. Returns an empty array when the attribute is
 * absent.
 */
export function parseFederatedGroups(userAttributes: Record<string, string>): string[] {
  const raw = userAttributes["custom:idpGroups"];
  if (raw === undefined || raw === "") return [];
  return raw
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
