# 07 — CDK changes for federation

The federation support in vestibulum-cdk is mostly a runtime concern
(admins paste IdP config; the app calls Cognito SDK to create the
IdP record; the typed claim-resolver pipeline lives in the
vestibulum runtime). But three things must be true at _pool creation
time_ for federation to work later:

1. **Custom attributes must be declared.** Cognito does not permit
   adding custom attributes to an existing pool. If the pool ships
   without `custom:idpGroups` (or whatever the consumer chose), no
   future runtime call can add it.
2. **Hosted UI domain must be configured.** Cognito federation goes
   through the OAuth code flow, which uses the Hosted UI. The
   domain has to be reserved, ACM cert provisioned, DNS pointed.
3. **The `DisabledAuthFlowsAspect` must permit the federation
   flow.** Vestibulum-cdk's magic-link-only mode disables every flow
   that isn't `CUSTOM_AUTH`; federation needs the OAuth code flow
   (`AllowedOAuthFlows: ['code']` plus
   `AllowedOAuthFlowsUserPoolClient: true`) on the app client, and
   `ALLOW_REFRESH_TOKEN_AUTH` if the consumer wants SDK-based
   refresh. The SDK-based password/SRP flows stay blocked —
   federation does not need them. See
   [§ Modified: `DisabledAuthFlowsAspect`](#modified-disabledauthflowsaspect).

The construct surface below adds the props needed for each.

## Construct surface

**Decision: keep `MagicLinkIdentity` as the construct name, expand
its props.** Rationale:

- A separate `Identity` construct creates a three-way decision tree
  for consumers (`Identity` alone, `MagicLinkIdentity`, or some
  federation-only variant) without a clear semantic difference from
  the prop-driven model.
- The construct name is already in the consumer surface; renaming
  forces a breaking change on consumers who don't need federation.
- Federation is, in practice, additive to magic-link. Most consumers
  wanting federation also want magic-link as a fallback (the B2B
  vs B2C split that motivated the trellis-side design).
- Internal class structure can split into an `Identity` base +
  `MagicLinkAuth` mixin without leaking through the construct
  surface.

If a future consumer needs federation-only with no magic-link
plumbing at all (no DDB token table, no SES, no bounce handler), we
add a sibling `FederationIdentity` construct then. Not now.

## New props on `MagicLinkIdentity`

```typescript
interface MagicLinkIdentityProps {
  // ... existing props ...

  /**
   * Custom attributes declared at pool creation. Cannot be added
   * later (Cognito limitation).
   *
   * Federation consumers MUST set this. Vestibulum-cdk does not
   * prescribe attribute names — the consumer's claim-resolver
   * callback decides what claims to emit; this prop declares the
   * pool-level slots those claims need.
   *
   * Common names: 'idpGroups', 'tenantId', 'tenantRole', 'handle'.
   * Cognito prefixes them with 'custom:' automatically.
   */
  customAttributes?: CustomAttributeDeclaration[];

  /**
   * Cognito Hosted UI domain. Required for OAuth code flow
   * (federation). Optional for magic-link-only consumers.
   *
   * Pass either a subdomain of cognito-idp.com (e.g. 'my-app-auth'
   * → 'my-app-auth.auth.{region}.amazoncognito.com') or a custom
   * domain backed by an ACM cert.
   */
  hostedUiDomain?: HostedUiDomainProps;

  /**
   * Enable federation auth flows on the pool and its app clients.
   * Default false (preserves magic-link-only behaviour).
   *
   * When true:
   * - DisabledAuthFlowsAspect permits the OAuth code flow at the
   *   app-client level.
   * - addAppClient(...) defaults to including federation flows in
   *   its props.
   * - The construct fails synth if hostedUiDomain is unset
   *   (federation without Hosted UI doesn't work).
   */
  federationEnabled?: boolean;

  /**
   * Cognito user-pool feature plan. Affects which
   * pre-token-generation trigger event versions are available:
   * - 'Lite':       V1 only.
   * - 'Essentials': V1 + V2 (access token customisation, scope
   *                 manipulation, complex claim values).
   * - 'Plus':       V1 + V2 + V3 (M2M client credentials
   *                 customisation, plus all Essentials features
   *                 and advanced security features).
   *
   * Vestibulum's runtime Lambda templates use V2 features when
   * available. On 'Lite', the template degrades to ID-token-only
   * claim overrides. The construct emits a warning at synth if
   * `federationEnabled: true` and the tier is unset or 'Lite'.
   *
   * The string union mirrors CDK's `cognito.FeaturePlan` enum
   * (LITE / ESSENTIALS / PLUS). When the construct lands, prefer
   * re-exporting CDK's enum over duplicating the string literal —
   * fewer drift surfaces. The string-union form here is shown for
   * doc legibility.
   */
  featureTier?: "Lite" | "Essentials" | "Plus";
}

interface CustomAttributeDeclaration {
  name: string; // without 'custom:' prefix
  dataType: "String" | "Number" | "Boolean" | "DateTime";
  mutable?: boolean; // default true
  required?: boolean; // default false; ignored for non-String types
  minLength?: number; // String only
  maxLength?: number; // String only
}

type HostedUiDomainProps =
  | { kind: "cognito"; prefix: string }
  | { kind: "custom"; domainName: string; acmCertArn: string };
```

### `customAttributes`

Declared at pool creation, immutable thereafter (Cognito enforces).
The `name` is what consumers reference in their claim-resolver
callbacks as `custom:{name}` (the `custom:` prefix is added by
Cognito automatically; the prop accepts the bare name).

Common federation declarations:

```typescript
customAttributes: [
  { name: 'idpGroups',   dataType: 'String', maxLength: 2048 },
  { name: 'tenantId',    dataType: 'String', maxLength: 64 },
  { name: 'tenantRole',  dataType: 'String', maxLength: 32 },
  { name: 'handle',      dataType: 'String', maxLength: 64 },
  { name: 'userId',      dataType: 'String', maxLength: 64 },
],
```

The construct validates at synth time:

- Names match Cognito's `[a-zA-Z0-9_]+` rule and are
  **1–20 characters** (Cognito's per-attribute name length,
  excluding the `custom:` prefix).
- Total attribute count ≤ 50 (Cognito quota).
- Required + mutable=false combinations are flagged as a likely
  mistake (a required immutable attribute can never be set on a
  federated user whose IdP doesn't supply it).

### `hostedUiDomain`

Two shapes. Cognito-managed subdomain is the cheapest path:

```typescript
hostedUiDomain: { kind: 'cognito', prefix: 'my-app-auth' },
```

The prefix must be globally unique within the AWS region. The
construct does not enforce uniqueness at synth time (it would
require a runtime AWS call), but the recommended naming pattern is
`{org}-{environment}-{purpose}` (e.g. `acme-prod-auth`) to avoid
squatting collisions in the shared regional namespace. Cognito
returns a deploy-time error if the prefix is already taken; the
workaround is to pick a more specific prefix and retry.

Custom domain requires an ACM cert in `us-east-1` (Cognito's
requirement, not vestibulum-cdk's):

```typescript
hostedUiDomain: {
  kind: 'custom',
  domainName: 'auth.example.com',
  acmCertArn: 'arn:aws:acm:us-east-1:{account}:certificate/{cert-id}',
},
```

The ACM cert ARN should reference a cert from `EdgeResources` if one
is already provisioned — the same cert can cover both the CloudFront
distribution and the Cognito Hosted UI domain provided it includes
both names.

### `featureTier`

The Cognito user-pool feature plan (`Lite` / `Essentials` / `Plus`)
gates pre-token-generation event versions V2 and V3, which the
federation runtime templates rely on for access-token customisation,
scope manipulation, and complex-typed claim values.

Construct behaviour:

- `featureTier` unset or `'Lite'` with `federationEnabled: true` →
  warning at synth.
- `featureTier: 'Essentials' | 'Plus'` → CloudFormation sets
  `UserPoolTier` accordingly; the runtime Lambda template uses V2
  features.
- Magic-link-only consumers (federation disabled) are not affected.

The tier choice affects per-MAU pricing; the construct warns rather
than errors so consumers can opt into V1-only intentionally if they
have no need for access-token customisation.

### `federationEnabled`

Acts as a feature flag at the construct level. When `false`
(default), the magic-link-only behaviour is preserved: aspects
disable federation flows, app clients are `CUSTOM_AUTH`-only,
`hostedUiDomain` defaults to unset. When `true`:

- The `DisabledAuthFlowsAspect` is relaxed to permit the OAuth code
  flow (`AllowedOAuthFlows: ['code']`) and `ALLOW_REFRESH_TOKEN_AUTH`
  at the app-client level. SDK-based password/SRP flows
  (`ALLOW_USER_PASSWORD_AUTH`, `ALLOW_USER_SRP_AUTH`,
  `ALLOW_USER_AUTH`) stay blocked. `CUSTOM_AUTH` stays enabled (for
  coexistence with magic-link).
- A synth-time check rejects the construct if `hostedUiDomain` is
  unset.
- `addAppClient(...)` and the auto-created AuthSite app client gain
  federation defaults (OAuth code flow, callback URLs, the
  `SupportedIdentityProviders: ['COGNITO']` baseline — the
  vestibulum runtime's IdP CRUD adds per-tenant entries to this list
  at runtime).

Setting `federationEnabled: true` without `customAttributes` is
permitted (some federation consumers don't need custom claims), but
emits a construct-level warning since the common case does need
custom attributes and forgetting them is a deploy-then-rebuild trap.

## App-client federation flags

`MagicLinkIdentity.addAppClient(id, props)` gains federation-aware
defaults when `federationEnabled: true` at the construct level. The
prop shape is the standard CDK `cognito.UserPoolClientOptions`
(see [`05-app-clients.md`](05-app-clients.md)) — no bespoke prop
dialect:

```typescript
import * as cognito from "aws-cdk-lib/aws-cognito";

identity.addAppClient("webapp", {
  oAuth: {
    flows: { authorizationCodeGrant: true },
    callbackUrls: ["https://app.example.com/oauth/callback"],
    logoutUrls: ["https://app.example.com/"],
    scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
  },
  supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
  // ... existing props (token TTLs etc.) ...
});
```

PKCE is implicit on public clients with the authorization-code
flow; no separate `pkce` flag.

Notes:

- `supportedIdentityProviders` defaults to `['COGNITO']`. The
  vestibulum runtime's IdP CRUD adds entries (e.g.
  `'tenant-acme'`) via `OidcIdpManager.attachToAppClients(...)`.
  The runtime — not the construct — manages the per-tenant list.
- `oauth.callbackUrls` is required for any client doing federation.
  The construct validates HTTPS-only on non-localhost.
- `generateSecret: false` is enforced. Public clients (SPAs, mobile
  apps) cannot use the client secret safely; if a consumer needs a
  server-side OAuth client with a secret, they fall back to the raw
  `cognitoPool.addClient` escape hatch.
- `prevent_user_existence_errors: 'ENABLED'` is set automatically
  (security best-practice for the OAuth code flow).

## Aspects and synth-time checks

The federation expansion adds two new aspects and modifies one
existing aspect.

### Modified: `DisabledAuthFlowsAspect`

The magic-link-only mode disables every auth flow except
`CUSTOM_AUTH`. The federation expansion adds the OAuth code flow to
the permitted set when `federationEnabled` is true; it does **not**
open any SDK-based password/SRP/USER_AUTH path:

| Flow                                            | `federationEnabled: false` | `federationEnabled: true`        |
| ----------------------------------------------- | -------------------------- | -------------------------------- |
| `ALLOW_USER_PASSWORD_AUTH`                      | blocked                    | blocked                          |
| `ALLOW_USER_SRP_AUTH`                           | blocked                    | blocked                          |
| `ALLOW_USER_AUTH` (unified flow)                | blocked                    | blocked                          |
| `ALLOW_ADMIN_USER_PASSWORD_AUTH`                | blocked                    | blocked                          |
| `ALLOW_REFRESH_TOKEN_AUTH`                      | permitted (\*)             | permitted (refresh)              |
| `ALLOW_CUSTOM_AUTH`                             | permitted (magic-link)     | permitted (magic-link bootstrap) |
| OAuth code flow (`AllowedOAuthFlows: ['code']`) | blocked                    | permitted (federation)           |

(\*) `ALLOW_REFRESH_TOKEN_AUTH` is permitted in both modes; CDK's L2
`UserPool.addClient` emits it unconditionally and consumers rely on
it. The federation-relevant gating is on the OAuth code flow row.

Passwords are never permitted on vestibulum-cdk-managed pools,
federation or not. Federation goes through the OAuth code flow +
Hosted UI; the SDK-based flows (`USER_SRP_AUTH`,
`USER_PASSWORD_AUTH`, `USER_AUTH`, `ADMIN_USER_PASSWORD_AUTH`) are
independent authentication paths that bypass Hosted UI and are kept
blocked. `ALLOW_USER_AUTH` in particular ([CreateUserPoolClient API
ref](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateUserPoolClient.html))
internally permits SRP and password without needing the
corresponding `ALLOW_*` flags, so it is blocked explicitly even
though it doesn't appear on the existing-flow allowlist.

If a future consumer genuinely needs an SDK-based auth surface
(e.g., for a server-side client that pre-validates credentials), the
aspect exposes an `allowSrpAuth?: boolean` prop gating
`ALLOW_USER_SRP_AUTH` only — opt-in, synth-time warning, no other
SDK flows enabled by the same prop. No consumer should reach for
this without a written reason; the prop exists to make "we knowingly
accepted this risk" explicit rather than to make it easy.

### New: `FederationCustomAttributesAspect`

Synth-time check that flags common mistakes:

- `federationEnabled: true` and `customAttributes` is missing or
  empty → warning ("federation consumers usually need custom
  attributes for tenant/role claims").
- Required + immutable attribute → error (a federated user whose
  IdP doesn't supply the attribute cannot be created).
- **`mutable: false` on any custom attribute when
  `federationEnabled: true` → error.** Cognito's
  `AdminLinkProviderForUser` operation (used for account linking
  and any future SCIM shell-user → federated-login merge) is
  reported to fail when the destination user has immutable custom
  attributes. The [public API
  reference](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminLinkProviderForUser.html)
  documents attribute-conflict constraints in general terms but
  does not explicitly call out the immutable-attribute case; the
  rule in this section is an **empirical observation from a real
  pool** carried over from the trellis design discussions. **Verify
  against a real test pool before treating as a hard rule.** If
  the constraint is confirmed: declaring even one immutable
  attribute on a federation-enabled pool permanently blocks the
  link operation for the lifetime of the pool (custom attributes
  cannot be removed), so `mutable: true` is the only safe value.
  If the constraint is unconfirmed: downgrade the aspect from
  `error` to `warning` and document the empirical source.
- More than ~10 custom attributes → warning (Cognito allows 50, but
  each attribute consumes a per-user storage row; many attributes
  per user is a smell).
- Worst-case ID-token-size estimate (`sum(maxLength of every
attribute) + base claims overhead`) above **5 KB → warning**,
  above **6 KB → error**. The base claims overhead is estimated at
  **2.5–3 KB** for a federated Cognito ID token (Cognito's standard
  claim set, the `cognito:*` namespace, federation provider-name
  claim, and any access-token customisations routinely run that
  large); this is the empirical baseline observed in trellis's
  federated-tenant tokens, not a Cognito-documented figure, and
  should be re-measured against a real sample pool before treating
  the threshold as load-bearing. The 5 KB warning is the soft
  threshold (browser cookies start hitting limits around 4 KB per
  cookie, with ~5–6 KB usable across an `HttpOnly`/`Secure` set
  before request-header limits behind certain proxies become
  problematic); the 6 KB error blocks the synth on the assumption
  that anything larger will break in production traffic.

Opt-out per check via props on the aspect; the construct applies it
by default at the `MagicLinkIdentity` scope.

### New: `HostedUiDomainAspect`

Synth-time check:

- `federationEnabled: true` and `hostedUiDomain` unset → error.
- `hostedUiDomain.kind === 'custom'` and the ACM cert ARN is not in
  `us-east-1` → error (Cognito requires `us-east-1` certs for
  custom Hosted UI domains, same as CloudFront).

## Token TTLs and federation

The token TTL hierarchy from
[`05-app-clients.md § Token TTL hierarchy`](05-app-clients.md#token-ttl-hierarchy)
applies unchanged. Federation does not change ID-token or
refresh-token TTL defaults.

One subtlety: for federated logins, Cognito's ID token is a
Cognito-signed token, not the upstream IdP's token. The TTL is
governed by Cognito's pool/app-client config, not the upstream IdP's
session policy. Consumers who want to enforce shorter sessions for
federated users than for magic-link users can do so by adding a
second app client (federation-only) with shorter TTL props.

## Coexistence with magic-link

The construct supports four configurations:

| `federationEnabled` | `customAttributes` | `hostedUiDomain` | `MagicLinkAuthSite` instances               |
| ------------------- | ------------------ | ---------------- | ------------------------------------------- |
| `false`             | optional           | optional         | required (magic-link is the only auth path) |
| `true`              | required (warning) | required (error) | optional (federation may be the only path)  |

A pool with `federationEnabled: true` but no `MagicLinkAuthSite` is
valid — it skips the SES sender, bounce handler, magic-link token
DDB table, and the four `CUSTOM_AUTH` trigger Lambdas. This is the
"federation-only company-internal app" shape.

A pool with `federationEnabled: false` and a `MagicLinkAuthSite` is
the magic-link-only shape, unchanged from the pre-federation
construct surface.

A pool with both is the multi-tenant consumer shape — B2C magic-link

- B2B federation, side by side. The classic trellis-driven use case.

## Migration for existing consumers

Consumers already on a magic-link-only `MagicLinkIdentity` who want
to add federation later face the **custom-attributes problem**: if
they didn't declare any in the magic-link-only deploy, they can't
add them later without redeploying the Cognito pool, which is a
stateful resource with `RemovalPolicy.RETAIN`.

Three migration paths:

1. **Plan ahead.** Add the custom attributes you might want before
   you've decided to use federation. The cost is trivial (a few
   unused attribute slots).
2. **Side-by-side pool.** Deploy a second `MagicLinkIdentity` with
   the federation attributes; migrate users gradually. Users exist
   in both pools during transition.
3. **In-place pool replacement.** Delete the existing pool (manual
   operation; `RETAIN` resists this) and redeploy. All users lose
   their accounts. Almost never the right answer.

[`01-package-api.md`](01-package-api.md) calls this out in the
prop description for `customAttributes` so consumers know to declare
attributes early.

## Signup-mode policy for federation-adjacent use

Federation does not change the magic-link construct's core
behaviour, but the two-pool topology surfaces a new requirement: a
B2B pool's bootstrap site (where the first tenant admin signs in
before federation is configured) must be invite-only, while a B2C
pool's site is open registration. The magic-link-only construct
surface left both behaviours implicit: open registration was the
only mode, and "invite-only" was something the consumer had to bolt
on via their own PreSignUp Lambda — easy to forget and fail-open
if forgotten.

The federation expansion adds `signupMode` to
**`MagicLinkIdentityProps`** (not `MagicLinkAuthSiteProps`). The
Identity owns the `PreSignUpFn` that enforces the policy, so the
policy belongs to the Identity. See
[`02-magic-link-identity.md § Signup mode`](02-magic-link-identity.md#signup-mode-propssignupmode)
for the prop definition and the synth-time error when
`federationEnabled: true` and `signupMode` is unset.

`allowedEmailDomains: []` retains its semantics ("no domain
restriction") and is unchanged. The `signupMode` prop is the
load-bearing control for B2B-pool security; the domain list is a
defence-in-depth filter on top of it. Consumers wanting both —
invite-only AND domain filter — set `signupMode: 'admin-invite-only'`
and a non-empty `allowedEmailDomains` together; each restriction
applies independently.

**Threat model.** Pairing federation with an open-registration
bootstrap site would let a stranger who discovers the bootstrap URL
self-register into the B2B pool, which is a tenant-isolation
breach. The synth-time error blocks that misconfiguration at deploy
time rather than relying on the consumer to remember.

## What does not change in CDK

- **`EdgeResources` retains its magic-link-only single-pool
  surface.** In the two-pool topology each pool gets its own
  `MagicLinkAuthSite` → its own CloudFront distribution → its own
  Lambda@Edge `check-auth`. The CloudFront-serves-multiple-pools
  shape initially considered is not the pattern that emerged: B2C
  users hit `app.example.com` (B2C distribution), B2B users hit
  `b2b.example.com` (B2B distribution), and the multi-pool concern
  lives in the API tier (the consumer's own service), where the
  vestibulum runtime's `createMultiPoolVerifier` covers it.

  If a future consumer genuinely needs a single CloudFront
  distribution serving traffic for multiple pools, that's an
  `EdgeResources` extension we'll spec then. The runtime helpers
  already exist; only the construct surface would need to grow.

- `MagicLinkAuthSite` is unchanged for magic-link-only consumers.
  The `signupMode` policy lives on `MagicLinkIdentity` (see above).
  Federation does not require any new construct on the site side;
  tenant routing happens via runtime IdP records and per-tenant
  `idp_identifier` query params, not per-tenant CloudFront
  distributions.
- The bounce-handler Lambda and SES setup are unchanged.
- The five mandatory mitigations from
  [`01-package-api.md`](01-package-api.md) apply unchanged.

## Status

Implemented. The decision on construct surface (extend
`MagicLinkIdentity` rather than adding a sibling `Identity` construct)
is settled and built. The exact shape of `CustomAttributeDeclaration`
and `HostedUiDomainProps` may still shift pre-1.0.

Open question: does the construct need a way to configure SES for
sending welcome / one-time emails when the federation
post-confirmation Lambda needs to send mail? Probably not —
vestibulum-cdk already provisions SES for magic-link delivery; the
post-confirmation Lambda can use the same identity. Documented for
the impl pass.
