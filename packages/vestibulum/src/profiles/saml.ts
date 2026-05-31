/**
 * SAML provider profiles.
 *
 * Plain frozen objects pre-filling attribute mapping for the
 * SAML IdP types Vestibulum's consumers most commonly federate
 * against. SAML attribute names are IdP-specific by
 * convention; per-provider profiles refine the defaults.
 *
 * See doc/federation/04-saml.md § Per-provider profiles.
 */

export interface SamlProfile {
  readonly attributeMapping: Readonly<Record<string, string>>;
}

/**
 * Generic SAML defaults using the `schemas.xmlsoap.org` URIs
 * that ADFS, Entra, and most enterprise IdPs emit.
 */
export const samlProfileGeneric: SamlProfile = Object.freeze({
  attributeMapping: Object.freeze({
    email: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    given_name: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
    family_name: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
    name: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
    "custom:idpGroups": "http://schemas.microsoft.com/ws/2008/06/identity/claims/role",
  }),
});

/**
 * Microsoft Entra SAML. Emits app roles as the
 * `schemas.microsoft.com/.../role` attribute by default — same
 * source claim as the OIDC `roles` claim, different transport.
 *
 * Federation metadata URL pattern:
 * `https://login.microsoftonline.com/{tenant-id}/federationmetadata/2007-06/federationmetadata.xml`.
 *
 * Entra SAML signs assertions but not requests by default; the
 * SAML manager's `signRequest: true` causes Cognito to sign
 * its AuthnRequest, which Entra accepts.
 */
export const samlProfileEntra: SamlProfile = Object.freeze({
  attributeMapping: Object.freeze({
    email: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    given_name: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
    family_name: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
    name: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
    "custom:idpGroups": "http://schemas.microsoft.com/ws/2008/06/identity/claims/role",
  }),
});

/**
 * ADFS. The groups-claim URI is the default emitted by the
 * "Send LDAP Attributes as Claims" rule template.
 *
 * Federation metadata URL pattern:
 * `https://adfs.{domain}/FederationMetadata/2007-06/FederationMetadata.xml`.
 */
export const samlProfileAdfs: SamlProfile = Object.freeze({
  attributeMapping: Object.freeze({
    email: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    given_name: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
    family_name: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
    name: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
    "custom:idpGroups": "http://schemas.xmlsoap.org/claims/Group",
  }),
});

/**
 * Okta SAML. Attribute statements are admin-configurable per
 * Okta SAML application; the values below are Okta's default
 * naming convention (`user.{attribute}`).
 *
 * Metadata URL pattern:
 * `https://{okta-org}.okta.com/app/{app-id}/sso/saml/metadata`.
 */
export const samlProfileOktaSaml: SamlProfile = Object.freeze({
  attributeMapping: Object.freeze({
    email: "user.email",
    given_name: "user.firstName",
    family_name: "user.lastName",
    name: "user.displayName",
    "custom:idpGroups": "user.groups",
  }),
});

/**
 * Shibboleth. Common in higher-education (eduPerson schema).
 * Uses LDAP-style OIDs as attribute names. Default mapping
 * covers `mail`, `givenName`, `sn`, `displayName`, and
 * `isMemberOf`.
 */
export const samlProfileShibboleth: SamlProfile = Object.freeze({
  attributeMapping: Object.freeze({
    email: "urn:oid:0.9.2342.19200300.100.1.3",
    given_name: "urn:oid:2.5.4.42",
    family_name: "urn:oid:2.5.4.4",
    name: "urn:oid:2.16.840.1.113730.3.1.241",
    "custom:idpGroups": "urn:oid:1.3.6.1.4.1.5923.1.5.1.1",
  }),
});

/**
 * The bundled SAML profiles, keyed by short name.
 */
export const SAML_PROFILES: Readonly<Record<string, SamlProfile>> = Object.freeze({
  generic: samlProfileGeneric,
  entra: samlProfileEntra,
  adfs: samlProfileAdfs,
  oktaSaml: samlProfileOktaSaml,
  shibboleth: samlProfileShibboleth,
});
