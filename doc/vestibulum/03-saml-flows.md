# SAML

This file specifies how `@de-otio/vestibulum` supports SAML 2.0
federation against Cognito. SAML differs from OIDC in enough
places that isolating the protocol-specific concerns here keeps
both [`./01-package-api.md`](./01-package-api.md) and
[`./02-oidc-flows.md`](./02-oidc-flows.md) cleaner.

SAML support is in scope for vestibulum v0.x; it is not deferred
behind a future milestone, even though OIDC is the
higher-priority path for the first consumer (see § Status
below).

## What SAML is, for vestibulum's purposes

A SAML 2.0 IdP in the Cognito context is a record with these
inputs:

- **Metadata** describing the IdP: entity ID, the SSO endpoint,
  the X.509 signing certificate(s), and which name-ID format
  the IdP supports. Provided as a URL Cognito refetches
  periodically, or as a literal XML blob pasted by the admin.
- **Attribute mapping** between SAML assertion attributes
  (free-form URIs like
  `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress`)
  and Cognito user attributes.
- **IdP identifiers** (the same email-domain routing field as
  OIDC).
- **Sign-request and encrypt-assertion flags** controlling
  whether Cognito signs the AuthnRequest it sends to the IdP
  and whether Cognito-side assertion decryption is configured.

There is **no client secret** equivalent in SAML. Trust between
SP (Cognito) and IdP rests on the IdP's signing certificate
(proving the assertion comes from the IdP) and, optionally, a
Cognito-side signing key (proving requests come from Cognito).
No Secrets Manager involvement.

## Metadata parsing

```typescript
async function parseSamlMetadata(
  source: { kind: "url"; url: string } | { kind: "xml"; xml: string },
  options?: {
    timeoutMs?: number; // default 5000
    maxBytes?: number; // default 256 KB
    fetchImpl?: typeof fetch;
  },
): Promise<SamlMetadata>;

interface SamlMetadata {
  entityId: string;
  ssoEndpoint: { binding: "HTTP-Redirect" | "HTTP-POST"; location: string };
  signingCertificates: SamlCertificate[]; // PEM, possibly multiple during rotation
  encryptionCertificates: SamlCertificate[];
  nameIdFormats: string[];
  validUntil?: Date; // <md:EntityDescriptor validUntil>
  cacheDuration?: Duration; // <md:EntityDescriptor cacheDuration>
  supportedAttributes?: SamlAttributeDescriptor[]; // if AttributeAuthorityDescriptor present
  /**
   * Outcome of XML signature verification on the
   * metadata blob itself. Discriminated so the
   * manager layer can react meaningfully (unsigned
   * → require explicit opt-in; invalid → reject
   * with diagnostic) rather than collapse both
   * states into "not verified". `kind: 'invalid'`
   * carries the structured reason for log/UI
   * surfaces. `reason` is an open string union so
   * future xml-crypto / @xmldom failure modes (or
   * new CVE-mitigation rejections) can be added
   * without an API bump.
   */
  signature:
    | { kind: "verified" }
    | { kind: "unsigned" }
    | {
        kind: "invalid";
        reason:
          | "cert_expired"
          | "unsupported_alg"
          | "missing_reference"
          | "digest_mismatch"
          | "signature_mismatch"
          | (string & {});
      };
}

interface SamlCertificate {
  pem: string;
  notBefore: Date;
  notAfter: Date;
  subjectCommonName?: string;
  fingerprintSha256: string;
}
```

Validation enforced inside `parseSamlMetadata`:

- Total XML size capped at `maxBytes` (default 256 KB — SAML
  metadata is bigger than OIDC discovery but not multi-megabyte).
  Larger payloads are rejected outright.
- XML well-formedness and an XML signature on the metadata
  itself if `<ds:Signature>` is present. The result's
  `signature` field discriminates three outcomes: `verified`
  (signature checked and good), `unsigned` (no
  `<ds:Signature>` element at all), and `invalid` (a
  signature was present but failed verification, with a
  structured `reason` for diagnostics — expired signing cert,
  unsupported algorithm, missing element reference, digest /
  signature mismatch). The **manager layer**
  (`SamlIdpManager.upsert`) refuses anything but `verified` by
  default; `unsigned` requires explicit
  `acceptUnsignedMetadata: true` to proceed (see
  [§ Trust on paste](#trust-on-paste-default-reject-unsigned)
  below), and `invalid` is **never** accepted (an attempted-but-
  failed signature is a stronger negative signal than no
  signature at all).
- HTTPS-only metadata URLs.
- **SSRF guard** on `kind: 'url'`. Same private/link-local/IMDS
  refusal, DNS-rebinding-pinned dispatcher, `redirect: 'manual'`,
  URL-credential refusal, URL-length cap, and streaming body
  cap as
  [`./01-package-api.md § Issuer probe`](./01-package-api.md#issuer-probe).
  An admin-pasted metadata URL is just as much an SSRF vector
  as an admin-pasted OIDC issuer; the same hardening applies.
  Implementation shares the dispatcher-pinning helper between
  the two probes.
- At least one HTTP-Redirect or HTTP-POST SSO binding present.
- At least one signing certificate that is not past `notAfter`
  at probe time. Expired-only certs raise
  `SamlMetadataError(reason: 'expired')`.
- XML External Entity (XXE) protections enabled on the parser.
  Hostile metadata is a credible attack vector; the parser
  refuses DTD resolution and external entity expansion.

**Library version pins.** Implementation uses `@xmldom/xmldom`
≥ 0.8.10 (fixes the `prototype-pollution-via-Mutation` class of
CVEs present in earlier versions) and `xml-crypto` ≥ 6.0.0
(fixes the XML signature-wrapping class of CVEs that affected
the 1.x and 2.x lines). The public API does not depend on the
choice of library, but the dependency versions are
non-negotiable: older releases have CVEs that defeat the
signature verification this function relies on. CI must fail on
any downgrade of either dependency.

### Trust on paste (default-reject unsigned)

For `kind: 'xml'` metadata (the admin pastes a blob), there is
no out-of-band trust anchor — the entire chain of trust is what
the admin pasted. Phishing an admin into pasting hostile
metadata is a realistic attack: `SamlIdpManager.upsert` defaults
to rejecting metadata whose `signature` field is anything other
than `{ kind: 'verified' }`.

```typescript
await samlManager.upsert({
  tenantId,
  metadata: { kind: "xml", xml: pastedBlob },
  // Default behaviour: throws if parseSamlMetadata
  // returns `signature.kind === 'unsigned'` or
  // `'invalid'`. To accept an *unsigned* blob
  // anyway, the admin UI must surface a clear
  // warning and pass:
  acceptUnsignedMetadata: true,
  // `invalid` is never accepted by upsert; the
  // diagnostic reason is surfaced to the consumer
  // for UI display.
});
```

For `kind: 'url'`, metadata is typically signed by major IdPs
(Entra, Okta, ADFS) but occasionally not (Shibboleth, some
bespoke deployments). Same default-reject behaviour applies;
the override is the same flag, and `invalid` is similarly
unconditional.

## Cognito IdP configuration shape

`SamlIdpManager.upsert(...)` produces a Cognito
`CreateIdentityProviderCommand` / `UpdateIdentityProviderCommand`
payload of the following shape (elided for ProviderType=SAML):

```json
{
  "UserPoolId": "{pool-id}",
  "ProviderName": "tenant-{normalised-id}",
  "ProviderType": "SAML",
  "ProviderDetails": {
    "MetadataURL": "{from input, if kind:url}",
    "MetadataFile": "{from input, if kind:xml}",
    "IDPSignout": "false",
    "EncryptedResponses": "true",
    "RequestSigningAlgorithm": "rsa-sha256",
    "SLORedirectBindingURI": "{from metadata, if SingleLogoutService present}",
    "SSORedirectBindingURI": "{from metadata}"
  },
  "AttributeMapping": {
    "email": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    "given_name": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
    "family_name": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
    "name": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
    "custom:idpGroups": "http://schemas.microsoft.com/ws/2008/06/identity/claims/role"
  },
  "IdpIdentifiers": ["acme.example", "acme-corp.example"]
}
```

Notes:

- Cognito accepts either `MetadataURL` or `MetadataFile`, never
  both. The manager picks the right field based on
  `input.metadata.kind`.
- `IDPSignout` defaults to `false`. Single-Logout via SAML is
  brittle in practice and most consumers don't need it;
  consumers wanting SLO can override.
- `EncryptedResponses` defaults to `true` if the IdP metadata
  advertises an encryption certificate, otherwise `false`.
- The default `AttributeMapping` uses the `schemas.xmlsoap.org`
  URIs that ADFS, Entra and most enterprise IdPs emit. SAML
  attribute names are IdP-specific by convention; per-provider
  profiles (below) refine the defaults.

## Per-provider profiles

The same pattern as OIDC: small advisory objects that pre-fill
attribute mapping and known quirks.

```typescript
import {
  samlProfileGeneric,
  samlProfileEntra,
  samlProfileAdfs,
  samlProfileOktaSaml,
  samlProfileShibboleth,
} from "@de-otio/vestibulum";
```

### Entra SAML (`samlProfileEntra`)

```typescript
{
  attributeMapping: {
    email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
    given_name: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
    family_name: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
    name: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
    'custom:idpGroups': 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role',
  },
}
```

Entra SAML notes:

- Federation metadata URL pattern:
  `https://login.microsoftonline.com/{tenant-id}/federationmetadata/2007-06/federationmetadata.xml`.
- Entra SAML emits app roles as the
  `http://schemas.microsoft.com/ws/2008/06/identity/claims/role`
  attribute by default — same source claim as the OIDC `roles`
  claim, different transport.
- Entra SAML signs assertions but **not** requests by default;
  the manager's `signRequest: true` causes Cognito to sign its
  AuthnRequest, which Entra accepts without configuration on
  its side.

### ADFS (`samlProfileAdfs`)

```typescript
{
  attributeMapping: {
    email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
    given_name: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
    family_name: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
    name: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
    'custom:idpGroups': 'http://schemas.xmlsoap.org/claims/Group',
  },
}
```

ADFS notes:

- Federation metadata URL pattern:
  `https://adfs.{domain}/FederationMetadata/2007-06/FederationMetadata.xml`.
- Groups claim is admin-configured in ADFS's claim rules; the
  URI above is the default emitted by the "Send LDAP Attributes
  as Claims" rule template.

### Okta SAML (`samlProfileOktaSaml`)

```typescript
{
  attributeMapping: {
    email: 'user.email',
    given_name: 'user.firstName',
    family_name: 'user.lastName',
    name: 'user.displayName',
    'custom:idpGroups': 'user.groups',
  },
}
```

Okta SAML notes:

- Attribute statements are admin-configurable per Okta SAML
  application. The above are Okta's own attribute "names"
  rather than schemas.xmlsoap.org URIs — Okta admins choose
  the name when they create the SAML app, and the default
  convention is `user.{attribute}`.
- Metadata URL:
  `https://{okta-org}.okta.com/app/{app-id}/sso/saml/metadata`.

### Shibboleth (`samlProfileShibboleth`)

```typescript
{
  attributeMapping: {
    email: 'urn:oid:0.9.2342.19200300.100.1.3',           // mail
    given_name: 'urn:oid:2.5.4.42',                        // givenName
    family_name: 'urn:oid:2.5.4.4',                        // sn
    name: 'urn:oid:2.16.840.1.113730.3.1.241',             // displayName
    'custom:idpGroups': 'urn:oid:1.3.6.1.4.1.5923.1.5.1.1', // isMemberOf
  },
}
```

Shibboleth notes:

- Common in higher-education (eduPerson schema).
- Uses LDAP-style OIDs as attribute names rather than HTTP URIs.
  The default mapping covers eduPersonScopedAffiliation and the
  `isMemberOf` group attribute.

## Signing-cert rotation

SAML signing certificates expire (typically 1–3 year validity
from major IdPs). Rotation is a recurring operational headache
for consumers without tooling.

Vestibulum handles rotation as follows:

1. **Metadata-URL IdPs** (the common case): Cognito refetches
   the metadata URL periodically (every 6 hours by default).
   New certificates appear automatically. The runtime API does
   not need to act.
2. **Metadata-XML IdPs** (the pasted-XML case): No automatic
   refetch. The admin pastes new metadata, the consumer calls
   `SamlIdpManager.upsert(...)` with the new XML. This is also
   when `signingCertNotAfter` from `parseSamlMetadata` is most
   useful for advance-warning UIs.
3. **Surfaced in `SamlIdpRecord`**: every call to `get(...)`
   and `upsert(...)` returns the current `signingCertNotAfter`
   (earliest `notAfter` across all certs in metadata).
   Consumers should run a cron that calls `get(...)`
   periodically and alerts admins when `signingCertNotAfter` is
   within ~30 days.

Vestibulum does **not**:

- Automatically rotate signing certs (the IdP controls them,
  not Cognito).
- Send rotation emails (consumer policy).
- Hold a per-tenant "rotation due" timer internally —
  `signingCertNotAfter` is the canonical source.

## SAML-specific security considerations

These are protocol concerns Cognito already handles but
consumers should know about:

- **Assertion replay**: Cognito enforces `NotBefore` /
  `NotOnOrAfter` and tracks `AssertionID` against replay within
  the session. No additional code in vestibulum.
- **Audience restriction**: Cognito's audience is its own SP
  entity ID; the IdP must include it in `<AudienceRestriction>`.
  Mismatches are rejected at sign-in time with a generic error.
  `parseSamlMetadata` cannot pre-validate this because the
  audience restriction is per-assertion, not per-metadata.
- **XML signature wrapping**: a class of attacks where the
  signed payload is one element but a parallel unsigned element
  is consumed. Mitigated by Cognito's parser; not vestibulum's
  concern for the federation path. The metadata parser is the
  other place where XML signature wrapping could matter; the
  choice of `xml-crypto` (or equivalent vetted lib) enforces
  signed-element-only consumption.
- **Encrypted assertions**: encryption keys are AWS-managed;
  Cognito generates a service key and exposes the cert in the
  SP metadata. The runtime API does not need to handle them.
- **Logout**: SAML SLO is opt-in (`IDPSignout: 'false'` by
  default; see Cognito IdP configuration shape above).
  Consumers enabling SLO need to coordinate with the IdP admin
  to register Cognito's SLO endpoint; vestibulum surfaces the
  endpoint URL via the SP-metadata helper below.

## SP metadata generation

Cognito provides an SP-metadata endpoint per user pool:
`https://{auth-domain}/saml2/idpresponse` is the ACS URL; the
SP metadata itself is constructed by the admin from documented
URL patterns rather than fetched. Vestibulum exports a small
helper for consumers building SP-metadata generation into their
admin UI:

```typescript
function buildSpMetadata(props: {
  userPoolId: string;
  region: string;
  hostedUiDomain: string;
}): Promise<SpMetadata>;

interface SpMetadata {
  entityId: string;
  acsUrl: string;
  metadataXml: string;
  signingCert: {
    pem: string;
    notAfter: Date;
  };
}
```

The XML is generated from a template — Cognito does not expose
a "fetch my SP metadata" endpoint so this is the only practical
way for admins to configure their IdP with the right SP
details.

**Cognito's SP signing certificate rotates annually.** Cognito
assigns a new SAML 2.0 signing certificate yearly with 10-year
validity per cert
([GetSigningCertificate API ref](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_GetSigningCertificate.html)).
`buildSpMetadata` calls `GetSigningCertificate` and embeds the
current cert in the generated XML so the IdP-side metadata is
correct at paste time. IdPs that pin the SP cert as a trust
anchor for signed AuthnRequests will need re-pasted metadata at
each Cognito rotation; the generated XML's docstring surfaces
this and the `SpMetadata` return shape includes the current
cert's `notAfter` for consumers building a "rotation due" alert
into their admin UI.

## Out of scope for SAML

- **SAML 1.x.** Cognito doesn't support it; nothing for
  vestibulum to do.
- **Encrypted name IDs.** Niche; supported by Cognito but the
  runtime API does not surface the toggle. Consumers needing
  it can pass through via Cognito's raw `ProviderDetails`.
- **Subject confirmation method `holder-of-key`.** Not
  supported by Cognito.
- **Just-in-time attribute updates** on each sign-in (Cognito
  only updates Cognito user attributes on the first JIT-create;
  subsequent changes require manual sync). Consumer-policy
  decision whether to write a sync Lambda; vestibulum's
  pre-token-generation hook can re-read attributes from the
  consumer database but cannot update Cognito attributes
  inline.

## Status

SAML support is the **second-priority** path after OIDC. The
first internal consumer defers SAML to a later phase (OIDC E2E
validation comes first; SAML scaffolding exists but no E2E
validation yet). Vestibulum aligns: ship the SAML code paths
behind the same `SamlIdpManager` surface, but validate
end-to-end against Entra SAML (and ideally one non-Microsoft
IdP) before declaring the SAML half stable.

## Open questions

- Should `SamlIdpManager.upsert(...)` auto-call
  `parseSamlMetadata` to populate `signingCertNotAfter`, or
  require the consumer to pass the parsed metadata in?
  Currently the design is "auto-call for `kind: url`, expect
  parsed metadata for `kind: xml`" — tracked for the impl
  pass.
- Should `buildSpMetadata` cache the current signing cert
  (Cognito's `GetSigningCertificate` is rate-limited) or
  delegate caching to the consumer? Lean toward delegate;
  caching has tenant-specific TTL implications.
