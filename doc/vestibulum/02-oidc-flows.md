# OIDC

This file specifies how `@de-otio/vestibulum` supports OIDC
federation against Cognito. It covers the discovery protocol,
the provider-specific quirks worth bundling, the client-secret
lifecycle, and the Cognito-side configuration shape produced by
`OidcIdpManager`.

The CDK-side prerequisites (custom attributes, Hosted UI domain,
federation-enabled flag) are in `@de-otio/vestibulum-cdk` — see
[`../vestibulum-cdk/`](../vestibulum-cdk/) once that doc set
lands. The public API for OIDC management is in
[`./01-package-api.md § IdP managers`](./01-package-api.md#idp-managers).

## Discovery

OIDC providers expose a discovery document at
`{issuer}/.well-known/openid-configuration`. Vestibulum's
`probeOidcIssuer(...)` is the only authorised path for consumers
to validate this — direct `fetch` calls bypass the security
checks documented in
[`./01-package-api.md § Issuer probe`](./01-package-api.md#issuer-probe).

The probe is **never** called inside the auth hot path (it would
add a ~200–500 ms network hop per login). It runs at two
consumer-side moments:

1. **At config save**, when an admin pastes their IdP details
   into the consumer's UI. The consumer's API calls
   `probeOidcIssuer` before persisting the
   `TenantIdentityProvider` row and before calling
   `OidcIdpManager.upsert(...)`.
2. **At periodic verification**, optionally, via a consumer-side
   cron that re-probes saved issuers and flags `signing_alg`
   changes or JWKS-URI drift. Vestibulum does not ship the cron
   itself; the primitive is sufficient.

## Per-provider profiles

Different OIDC providers have predictable quirks. Vestibulum
exports a small set of **profile objects** that pre-fill the
attribute mapping, scope list, and any provider-specific issuer
URL normalisation. Profiles are advisory defaults —
`OidcIdpManager.upsert(...)` accepts explicit overrides for
every field.

```typescript
import {
  oidcProfileGeneric,
  oidcProfileEntra,
  oidcProfileOkta,
  oidcProfileAuth0,
  oidcProfileGoogleWorkspace,
} from "@de-otio/vestibulum";
```

### Generic OIDC (`oidcProfileGeneric`)

```typescript
{
  scopes: ['openid', 'email', 'profile'],
  attributeMapping: {
    // Cognito attribute → OIDC claim. The
    // `custom:idpGroups` attribute name is a
    // convention adopted across all profiles in
    // this package; consumers may rename it via
    // their pool's custom-attribute config — the
    // attribute name is consumer-controlled, not
    // a Cognito or vestibulum literal.
    email: 'email',
    email_verified: 'email_verified',
    given_name: 'given_name',
    family_name: 'family_name',
    name: 'name',
    'custom:idpGroups': 'groups', // common but non-standard
  },
}
```

Use when the provider follows the OIDC core spec closely and
exposes a standard discovery document.

### Microsoft Entra ID (`oidcProfileEntra`)

```typescript
{
  scopes: ['openid', 'email', 'profile'],
  attributeMapping: {
    email: 'email',
    email_verified: 'email_verified',
    given_name: 'given_name',
    family_name: 'family_name',
    name: 'name',
    // Entra emits roles via the 'roles' claim by
    // default (configured in the app registration);
    // mapping it into the same custom attribute as
    // generic 'groups' keeps the claim resolver
    // simple consumer-side.
    'custom:idpGroups': 'roles',
  },
  issuerNormalisation: 'entra-tenant-id',
}
```

Entra-specific behaviour worth bundling:

- **Issuer URL pattern**:
  `https://login.microsoftonline.com/{tenant-id}/v2.0`. The
  `{tenant-id}` is the Entra tenant GUID (sometimes called
  "Directory ID"). Common admin mistakes: pasting the
  _application_ ID instead, omitting `/v2.0`, using `/common/`
  (multi-tenant endpoint, not usable with Cognito's per-tenant
  IdP records).
- **App roles vs groups**: Entra has both. The default mapping
  uses `roles` (app roles, admin-controlled in Entra's app
  registration) rather than `groups` (which emits group GUIDs
  by default, requires "groups emitted as names" config, and
  has a 200-group emit-as-claim limit). Consumers who need
  Entra groups can override the mapping.
- **Token signing**: Entra emits RS256 — accepted by Cognito's
  JWKS-backed verification without extra config.
- **Issuer verification quirk**: The `iss` claim in tokens from
  Entra is sometimes the v2.0 URL and sometimes the v1.0 URL
  depending on the app registration's "access token version"
  setting. The `OidcIdpManager.upsert(...)` output surfaces a
  warning if the probe's `issuer` field doesn't match the URL
  passed in — the consumer's admin UI can flag this for the
  admin to correct.

### Okta (`oidcProfileOkta`)

```typescript
{
  scopes: ['openid', 'email', 'profile', 'groups'],
  attributeMapping: {
    email: 'email',
    email_verified: 'email_verified',
    given_name: 'given_name',
    family_name: 'family_name',
    name: 'name',
    'custom:idpGroups': 'groups',
  },
}
```

Okta-specific notes:

- Issuer URL pattern:
  `https://{okta-org}.okta.com/oauth2/default` for the default
  authorization server, or
  `https://{okta-org}.okta.com/oauth2/{auth-server-id}` for
  custom auth servers.
- The `groups` claim requires an Okta-side claim config:
  Security → API → Authorization Servers → (chosen server) →
  Claims → Add Claim with `groups` filtered to a regex or
  group set.
- Okta supports PKCE and code flow as expected.

### Auth0 (`oidcProfileAuth0`)

```typescript
{
  scopes: ['openid', 'email', 'profile'],
  attributeMapping: {
    email: 'email',
    email_verified: 'email_verified',
    given_name: 'given_name',
    family_name: 'family_name',
    name: 'name',
    'custom:idpGroups': 'https://your-namespace/groups',
  },
}
```

Auth0-specific notes:

- Auth0 strips non-namespaced custom claims from ID tokens
  unless they're listed as `non_persistent_attrs` or routed
  through an Action/Rule. The default mapping uses a
  namespaced claim URL; consumers should adjust the namespace
  to match their Auth0 tenant.
- Auth0 issuer: `https://{tenant}.auth0.com/` or custom domain.
  Trailing slash matters; the probe normalises but consumers
  paste both forms.

### Google Workspace (`oidcProfileGoogleWorkspace`)

```typescript
{
  scopes: ['openid', 'email', 'profile'],
  attributeMapping: {
    email: 'email',
    email_verified: 'email_verified',
    given_name: 'given_name',
    family_name: 'family_name',
    name: 'name',
    'custom:hostedDomain': 'hd',
  },
}
```

Google-specific notes:

- Issuer: `https://accounts.google.com`. Single global issuer;
  tenancy is implicit via the `hd` (hosted domain) claim,
  mapped here so consumers can verify the user belongs to the
  expected Workspace org.
- Google does **not** emit a `groups` claim out of the box.
  Workspace group claims require additional Admin SDK calls
  server-side and are not within vestibulum's scope; the
  consumer can do the lookup in their `ClaimResolver` callback
  if needed.

### Adding a new profile

Profiles are plain objects, not subclasses. A consumer can
construct their own and pass it as `oidcProfile` to the
admin-side helper:

```typescript
const myProfile = {
  scopes: [...oidcProfileGeneric.scopes, "openid:foobar"],
  attributeMapping: {
    ...oidcProfileGeneric.attributeMapping,
    "custom:vendor_id": "vendor_account_id",
  },
};
```

Vestibulum ships the five profiles above because they cover the
recurring consumer needs. Adding more is a PR with two changes
(one new exported constant, one mention in this file).

## Client-secret handling

OIDC requires a client secret on the IdP side (Entra's "client
secret", Okta's "client secret", etc.). The secret is sensitive
and must:

1. Live in AWS Secrets Manager, not env vars or the application
   database.
2. Never be logged, hashed, surfaced in error messages, or
   stored on disk in the pre-token-generation Lambda or
   anywhere else.
3. Be retrievable only by the IdP-management code path, not by
   general consumer code (HTTP route handlers, tenant CRUD,
   etc.).

**Cognito stores the literal client secret**, not a Secrets
Manager ARN
([CreateIdentityProvider API ref](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateIdentityProvider.html)).
There is no AWS-provided ARN-dereference mechanism for OIDC IdP
secrets; the literal value goes into
`ProviderDetails.client_secret` and Cognito holds it internally.
Vestibulum's role is to keep the plaintext out of every other
surface (application logs, consumer databases, CDK synth
outputs) and to centralise the read path.

### How `IdpSecretsClient` and `OidcIdpManager` cooperate

1. **At config save**: the consumer calls
   `idpSecretsClient.store(tenantId, secretValue)` to persist
   the secret. Returns a `SecretRef`; the plaintext is
   forgotten on the consumer side.
2. **At IdP upsert**: the consumer calls
   `OidcIdpManager.upsert({clientSecret, ...})`. The manager
   reads the plaintext from Secrets Manager via the
   package-internal Secrets Manager client (the consumer-facing
   `IdpSecretsClient` exposes no `get`), passes it to
   `CreateIdentityProvider` / `UpdateIdentityProvider`, and
   drops the reference. The plaintext lives only on that call
   stack.
3. **At rotation**: see § Rotation below.

The Lambda or container running the upsert path needs
`secretsmanager:GetSecretValue` on the relevant prefix and
`cognito-idp:CreateIdentityProvider` /
`cognito-idp:UpdateIdentityProvider` on the user pool. No other
code path needs `GetSecretValue`.

### ARN convention

```
arn:aws:secretsmanager:{region}:{account-id}:secret:{secretPrefix}{kind}/{tenantId}-{6-char-random}
```

The 6-char suffix is the Secrets Manager auto-generated suffix;
the prefix is consumer-supplied
(`/vestibulum/idp/<app-name>/`); `kind` defaults to
`oidc-client-secret` and namespaces additional secret kinds
(e.g. `scim-bearer-token`) under the same prefix. Per-tenant
secrets are listable by prefix for ops; restrict the read grant
to the upsert role only.

### Rotation

Cognito does **not** auto-refresh the OIDC client secret.
Storing a new version in Secrets Manager has no effect on
Cognito until `UpdateIdentityProvider` is called with the new
plaintext. `IdpSecretsClient.store(...)` persists the new
version; `OidcIdpManager.upsert(...)` pushes it to Cognito.

Sequence:

1. The consumer obtains the new secret from the IdP admin UI
   (out-of-band).
2. `idpSecretsClient.store(tenantId, newSecret)` creates a new
   Secrets Manager version under the same ARN. The prior
   version remains for audit per the AWS retention policy.
3. `OidcIdpManager.upsert(...)` with the unchanged
   `clientSecret` `SecretRef` reads the latest version and
   pushes it to Cognito. From this moment, Cognito uses the
   new secret for token exchanges.

Cutover is atomic at the `UpdateIdentityProvider` call, not
gradual. In-flight authorization-code exchanges started before
the update with the old secret will fail unless the upstream
IdP itself honours both secrets during an overlap window
(Entra, Okta, Auth0 do; bespoke IdPs may not). Coordinate the
rotation window with the IdP's overlap policy; for IdPs without
overlap, schedule during low-traffic periods.

Vestibulum does not automate rotation scheduling. A consumer
wanting automatic rotation configures Secrets Manager's native
rotation Lambda (consumer-supplied) and triggers
`OidcIdpManager.upsert` from the post-rotation hook.
`@de-otio/vestibulum-cdk` may ship a CDK construct for this in
a future release.

### Token-endpoint authentication method

Cognito uses `client_secret_post` to authenticate to the
upstream IdP's token endpoint; it does **not** support
`client_secret_basic` or other methods
([Using OIDC IdPs with a user pool](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-oidc-idp.html)).
`probeOidcIssuer` checks the issuer's
`token_endpoint_auth_methods_supported` claim and raises
`OidcProbeError(reason: 'unsupported_auth_method')` if
`client_secret_post` is missing. Surfacing this at config-save
time avoids the much-harder-to-diagnose "federation works
through Cognito's UI but the token exchange silently fails"
mode at first sign-in.

## Cognito IdP configuration shape

`OidcIdpManager.upsert(...)` produces a Cognito
`CreateIdentityProviderCommand` / `UpdateIdentityProviderCommand`
payload of the following shape (elided for the
ProviderType=OIDC case):

```json
{
  "UserPoolId": "{pool-id}",
  "ProviderName": "tenant-{normalised-id}",
  "ProviderType": "OIDC",
  "ProviderDetails": {
    "client_id": "{from input}",
    "client_secret": "{plaintext secret read from Secrets Manager}",
    "attributes_request_method": "GET",
    "oidc_issuer": "{from input}",
    "authorize_scopes": "openid email profile",
    "authorize_url": "{from probe}",
    "token_url": "{from probe}",
    "attributes_url": "{from probe userinfo}",
    "jwks_uri": "{from probe}"
  },
  "AttributeMapping": {
    "email": "email",
    "email_verified": "email_verified",
    "given_name": "given_name",
    "family_name": "family_name",
    "name": "name",
    "custom:idpGroups": "roles"
  },
  "IdpIdentifiers": ["acme.example", "acme-corp.example"]
}
```

Notes:

- `ProviderName` is derived from the consumer's `TenantId` via
  `idp-name.ts` (see
  [`./01-package-api.md § Package layout`](./01-package-api.md#package-layout)).
  The 32-char Cognito limit is enforced by truncating to
  `tenant-` (7 chars) plus 25 chars of normalised tenantId.
  The full mapping from `tenantId` to `cognitoIdpName` is
  deterministic and stored in the consumer's database.
- `client_secret` is the literal secret string, read from
  Secrets Manager by the manager at upsert time. Cognito does
  not dereference Secrets Manager ARNs. See above for the read
  path and IAM requirements.
- `IdpIdentifiers` enables Cognito's `idp_identifier` query
  param routing for SP-initiated flow. An email-domain-based
  discovery surface in the consumer's app can resolve a typed-in
  email to the right tenant by passing
  `idp_identifier=acme.example` to `/oauth2/authorize` instead
  of `identity_provider=tenant-xxx`.

## Out of scope for OIDC

- **Dynamic Client Registration** (RFC 7591). No consumer
  needs it; Cognito doesn't support it for IdPs anyway.
- **OIDC Federation 1.0** (entity statements). Out of scope;
  Cognito IdPs are flat per-tenant records.
- **Token introspection at the edge.** The edge verifier checks
  RS256 signatures against Cognito's JWKS, not the upstream
  IdP's JWKS; Cognito re-signs after federation. Introspection
  would route through Cognito which doesn't expose the upstream
  IdP's tokens.
- **Refresh-token revocation at the upstream IdP.** When a
  Cognito session is signed out, it invalidates Cognito's
  refresh token; the upstream IdP's session is not touched.
  This is by design — single sign-out is a consumer-policy
  decision and the consumer can build it on top of
  `cognito-idp:GlobalSignOut` + an IdP-specific signout call
  in their callback. Not vestibulum's job.

## Status

OIDC support is the higher-priority path because the first
internal consumer (trellis) already has working OIDC federation
to absorb. The runtime API in
[`./01-package-api.md`](./01-package-api.md) is shaped to absorb
that functionality without extension; the Entra profile in
particular maps 1:1 to that consumer's current defaults.

See [`../08-trellis-migration.md`](../08-trellis-migration.md)
for the trellis-side hand-off.
