/**
 * OIDC provider profiles.
 *
 * Plain frozen objects that pre-fill attribute mapping, scope
 * lists, and any provider-specific quirks for the IdP types
 * Vestibulum's consumers most commonly federate against.
 *
 * Profiles are advisory defaults — `OidcIdpManager.upsert(...)`
 * accepts explicit overrides for every field. To extend with a
 * provider not listed here, construct your own object of the
 * same shape and pass it to your admin-side helper.
 *
 * See doc/federation/03-oidc.md § Per-provider profiles.
 */

/**
 * Shape of an OIDC profile.
 *
 * `attributeMapping`: Cognito user-pool attribute name (key)
 *   → OIDC ID-token claim name (value).
 * `scopes`: OAuth scopes to request from the issuer.
 * `issuerNormalisation`: optional hint for provider-specific
 *   issuer-URL canonicalisation. Implementation-defined per
 *   value; today only `'entra-tenant-id'` is recognised.
 */
export interface OidcProfile {
  readonly scopes: readonly string[];
  readonly attributeMapping: Readonly<Record<string, string>>;
  readonly issuerNormalisation?: "entra-tenant-id";
}

/**
 * Generic OIDC defaults. Use when the provider follows the
 * OIDC core spec closely and exposes a standard discovery
 * document.
 */
export const oidcProfileGeneric: OidcProfile = Object.freeze({
  scopes: Object.freeze(["openid", "email", "profile"]),
  attributeMapping: Object.freeze({
    email: "email",
    email_verified: "email_verified",
    given_name: "given_name",
    family_name: "family_name",
    name: "name",
    "custom:idpGroups": "groups",
  }),
});

/**
 * Microsoft Entra ID. The default mapping uses `roles` (app
 * roles, admin-controlled in Entra's app registration) rather
 * than `groups` (which has a 200-group emit-as-claim cap).
 *
 * Common admin mistakes the manager surfaces via
 * `OidcProbeError` or upsert warnings:
 * - Pasting application ID instead of Entra tenant GUID.
 * - Omitting `/v2.0` from the issuer URL.
 * - Using `/common/` (multi-tenant endpoint, not usable with
 *   Cognito's per-tenant IdP records).
 */
export const oidcProfileEntra: OidcProfile = Object.freeze({
  scopes: Object.freeze(["openid", "email", "profile"]),
  attributeMapping: Object.freeze({
    email: "email",
    email_verified: "email_verified",
    given_name: "given_name",
    family_name: "family_name",
    name: "name",
    "custom:idpGroups": "roles",
  }),
  issuerNormalisation: "entra-tenant-id",
});

/**
 * Okta. The `groups` claim requires Okta-side claim config:
 * Security → API → Authorization Servers → (chosen server) →
 * Claims → Add Claim with `groups` filtered to a regex or
 * group set.
 */
export const oidcProfileOkta: OidcProfile = Object.freeze({
  scopes: Object.freeze(["openid", "email", "profile", "groups"]),
  attributeMapping: Object.freeze({
    email: "email",
    email_verified: "email_verified",
    given_name: "given_name",
    family_name: "family_name",
    name: "name",
    "custom:idpGroups": "groups",
  }),
});

/**
 * Auth0. Auth0 strips non-namespaced custom claims from ID
 * tokens unless they're listed as `non_persistent_attrs` or
 * routed through an Action/Rule. The default mapping uses a
 * namespaced claim URL; consumers should replace
 * `https://your-namespace/` with their Auth0 tenant's chosen
 * namespace.
 */
export const oidcProfileAuth0: OidcProfile = Object.freeze({
  scopes: Object.freeze(["openid", "email", "profile"]),
  attributeMapping: Object.freeze({
    email: "email",
    email_verified: "email_verified",
    given_name: "given_name",
    family_name: "family_name",
    name: "name",
    "custom:idpGroups": "https://your-namespace/groups",
  }),
});

/**
 * Google Workspace. Tenancy is implicit via the `hd` (hosted
 * domain) claim, mapped to `custom:hostedDomain` so consumers
 * can verify the user belongs to the expected Workspace org.
 *
 * Google does not emit a `groups` claim out of the box;
 * Workspace group claims require Admin-SDK calls server-side
 * (consumer-side concern; not in Vestibulum's scope).
 */
export const oidcProfileGoogleWorkspace: OidcProfile = Object.freeze({
  scopes: Object.freeze(["openid", "email", "profile"]),
  attributeMapping: Object.freeze({
    email: "email",
    email_verified: "email_verified",
    given_name: "given_name",
    family_name: "family_name",
    name: "name",
    "custom:hostedDomain": "hd",
  }),
});

/**
 * The bundled OIDC profiles, keyed by short name.
 */
export const OIDC_PROFILES: Readonly<Record<string, OidcProfile>> = Object.freeze({
  generic: oidcProfileGeneric,
  entra: oidcProfileEntra,
  okta: oidcProfileOkta,
  auth0: oidcProfileAuth0,
  google: oidcProfileGoogleWorkspace,
});
