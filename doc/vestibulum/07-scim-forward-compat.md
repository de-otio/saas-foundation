# SCIM forward-compatibility

SCIM 2.0 inbound provisioning is **not** in vestibulum v0.x. It
is the most likely future extension to the package, though, and
the v0.x design intentionally leaves the hooks needed to add it
later as a pure extension rather than a redesign.

This file consolidates the SCIM-shaped affordances scattered
across the rest of the design — the reserved `scim/`
subdirectory, the open-union types, the IdP-record
extensibility — and spells out what SCIM 2.0 support would
look like when it lands. Nothing here is implemented in v0.x;
everything here is "we have not closed the door".

## Why SCIM is deferred, not designed-around

SCIM is the standard way an enterprise IdP (Entra, Okta, ADFS)
pushes user lifecycle events (create, update, deactivate) into
a downstream system. For a B2B SaaS product, SCIM is the
difference between "users disappear when offboarded at the
IdP" (good) and "users linger with a stale Cognito refresh
token until it expires 30 days later" (bad — see [`./README.md
§ Security properties`](./README.md#security-properties-relied-on-across-this-folder)
item 8).

The reasons it's not in v0.x:

1. **JIT provisioning via post-confirmation handles the
   first-time case.** SCIM matters most when an IdP-provisioned
   user is _deactivated_ while their Cognito session is still
   valid. Create/update can be solved with JIT; only
   deactivation needs SCIM specifically (and even then,
   short refresh-token TTL is a partial mitigation).
2. **Account-linking is a hard prerequisite.** A SCIM-provisioned
   "shell" user (created via `Users.POST` before they've ever
   signed in) plus a subsequent federated login from the same
   user has to **merge** into one Cognito user via
   `AdminLinkProviderForUser`. Otherwise the user lands as two
   distinct Cognito subs — once from the SCIM provision and
   once from the federated JIT — and the consumer's
   application sees them as two distinct people. The linking
   call has its own constraints (Cognito's 5-federated-IdPs-per-
   user cap, the immutable-attribute restriction) and is
   non-trivial to do right.
3. **No internal consumer has asked yet.** The first
   internal consumer's B2B side starts with one or two
   tenants whose admin can tolerate manual offboarding. SCIM
   matters at scale; the design defers the implementation cost
   until the scale arrives.

The defer is "we'll build it when we need it", not "we'll
never build it". The hooks in v0.x make the later build a pure
addition.

## Hooks staked out in v0.x

Five extensibility points, each pointing to the place in the
v0.x design where the hook exists.

### 1. Reserved `scim/` subdirectory

`packages/vestibulum/src/scim/` is reserved for the future
SCIM 2.0 inbound endpoint handler and supporting types. It is
not present in v0.x — staked out so the naming and structural
placement are decided before implementation. See [`./01-package-
api.md § Package layout`](./01-package-api.md#package-layout).

### 2. Open `triggerSource` discriminator

`ProvisionerInput.triggerSource` is a growable string union,
not a closed enum:

```typescript
interface ProvisionerInput {
  // ...
  triggerSource:
    | "PostConfirmation_ConfirmSignUp"
    | "PostConfirmation_ConfirmForgotPassword"
    | (string & {});
  // ...
}
```

SCIM-originated provisioning events — `'SCIM_Create'`,
`'SCIM_Update'`, `'SCIM_Deactivate'` — can fire the same
`Provisioner` callback without a breaking change. The consumer
already has to branch on known values and treat unknown sources
defensively; adding new values is mechanical. See [`./01-package-
api.md § Provisioner callback`](./01-package-api.md#provisioner-callback).

### 3. Open `SecretKind` for SCIM bearer tokens

`IdpSecretsClient` methods take an optional `kind` parameter
typed as an open union:

```typescript
type SecretKind = "oidc-client-secret" | (string & {});
```

A future SCIM endpoint authenticates incoming requests with a
bearer token issued by the IdP. The bearer token is stored in
Secrets Manager under the same prefix scheme, with `kind:
'scim-bearer-token'` (or whatever the convention settles on).
The ARN convention from [`./02-oidc-flows.md § ARN convention`](./02-oidc-flows.md#arn-convention)
already includes a `{kind}` segment so the namespacing works
without restructuring:

```
arn:aws:secretsmanager:{region}:{account}:secret:/vestibulum/idp/{app-name}/scim-bearer-token/{tenantId}-{6-char-random}
```

The IdPSecretsClient does not gain a new method; the existing
`store`, `delete`, and `refFor` already accept `kind`.

### 4. IdP-record extensibility

`OidcIdpRecord` and `SamlIdpRecord` are designed to grow.
Optional additive fields — for example future SCIM-related
state — are explicitly non-breaking additions:

```typescript
import type { SecretRef } from "@de-otio/saas-foundation";

interface OidcIdpRecord {
  // existing fields...

  // future, added when SCIM lands:
  scimEnabled?: boolean;
  scimEndpointPath?: string; // '/scim/v2/{tenantId}/'
  scimTokenSecret?: SecretRef; // the bearer-token reference,
  // pinned via the same refFor/upsert
  // discipline as OIDC client secrets
  // (see ./01-package-api.md)
  lastScimSyncAt?: Date;
  scimSyncStatus?: "idle" | "syncing" | "error";
}
```

`scimTokenSecret` uses the `SecretRef` type, not a flat ARN
string. This matches the rest of the package's secret-handling
discipline — the consumer never holds a plaintext token in
their record, rotation produces a pinned version, and the IAM
grant covers only the upsert path. A flat string field here
would diverge from
[`./01-package-api.md § Secrets handling`](./01-package-api.md#secrets-handling)
and bypass foundation's `secrets` module unnecessarily.

Same shape for `SamlIdpRecord`. Consumers should destructure
known fields rather than assume either record shape is closed.
See [`./01-package-api.md § IdP record extensibility`](./01-package-api.md#idp-record-extensibility).

The CDK side (`@de-otio/vestibulum-cdk`) gains nothing here —
SCIM is a runtime concern (an HTTP endpoint hosted by the
consumer's API), not an infrastructure concern.

### 5. Account-linking is the named prerequisite

`AdminLinkProviderForUser` is not in v0.x. It is flagged
throughout the design as the dependency that must land
alongside SCIM. The two relevant constraints today:

- **Cognito's `AdminLinkProviderForUser` refuses any user
  whose profile contains an immutable custom attribute**
  ([API ref](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminLinkProviderForUser.html)).
  The `FederationCustomAttributesAspect` in
  `@de-otio/vestibulum-cdk` therefore rejects `mutable: false`
  declarations at synth time on federation-enabled pools,
  since custom attributes cannot be removed from a Cognito
  pool once declared and the lock-in would be permanent.
- **Cognito caps federated identities per user at 5**
  ([same API ref](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminLinkProviderForUser.html)).
  A user federating from more than 5 IdPs into one Cognito
  sub hits this on the 6th link. For SCIM specifically this
  matters when the same user is provisioned by multiple SCIM
  endpoints (rare but real for users in multiple IdP-using
  organisations).

Both constraints are documented today; neither has a workaround
in v0.x because v0.x does not exercise the link path. SCIM
v0.1 will inherit them.

## What SCIM 2.0 inbound support would look like

When SCIM lands, the shape is:

### 1. An HTTP endpoint handler

`@de-otio/vestibulum` exports a request handler that the
consumer mounts in their HTTP framework. The handler implements
the SCIM 2.0 protocol surface: `Users`, `Groups`,
`ResourceTypes`, `Schemas`, `ServiceProviderConfig`. The
consumer wires it into their router:

```typescript
import { createScimHandler } from "@de-otio/vestibulum";

const scimHandler = createScimHandler({
  resolveTenant: (req) => {
    /* extract tenantId from URL */
  },
  authenticate: (req, tenantId) => {
    /* verify bearer against stored token */
  },
  upsertUser: async (tenantId, scimUser) => {
    /* consumer's user write */
  },
  deactivateUser: async (tenantId, scimUserId) => {
    /* consumer's deactivation */
  },
  // ... etc
});

app.use("/scim/v2/:tenantId/*", scimHandler);
```

The factory pattern matches the Lambda templates
([`./04-cognito-triggers.md`](./04-cognito-triggers.md)) — the
consumer supplies a small policy callback, vestibulum supplies
the protocol plumbing.

### 2. Bearer-token authentication

Each tenant's SCIM endpoint authenticates with a bearer token
the IdP holds. The token is stored in Secrets Manager under
`kind: 'scim-bearer-token'`. Rotation works the same way as
OIDC client secrets (see [`./02-oidc-flows.md § Rotation`](./02-oidc-flows.md#rotation)),
but the cutover is simpler because the consumer's SCIM endpoint
controls the verification — old and new tokens can be accepted
in parallel during a rotation window without IdP coordination.

The handler's `authenticate` callback resolves the bearer
against the stored secret and rejects mismatches with `401 Bad
Request` (per SCIM spec) before any user write.

### 3. Account-linking on first federated login after SCIM

provision

When SCIM creates a user (`POST /Users`) and the user
subsequently federates from the same IdP, the
post-confirmation Lambda detects the prior SCIM provision
(via a lookup keyed on the IdP's `externalId` claim) and calls
`AdminLinkProviderForUser` to merge the federated identity
into the existing Cognito sub.

This is the path that requires the v0.x constraints listed
above (no immutable attributes, ≤5 IdPs per user) to hold.

### 4. Deactivation triggers `AdminUserGlobalSignOut`

`PATCH /Users/{id}` with `active: false` (the SCIM-standard
deactivation pattern) causes the consumer's `deactivateUser`
callback to fire. The recommended consumer implementation:

1. Mark the user as deactivated in the consumer's database.
2. Call `cognito-idp:AdminUserGlobalSignOut` on the Cognito
   sub. This revokes all refresh tokens for the user — they
   can no longer obtain a new access token.
3. Optionally, force-expire any active access tokens via the
   consumer's session layer (cookie clear / session-store
   invalidation).

The refresh-token-outlives-IdP-session vulnerability noted in
[`./README.md`](./README.md) closes here.

### 5. SCIM endpoint URL is tenant-scoped

Each tenant gets `https://api.example.com/scim/v2/{tenantId}/`
as their SCIM endpoint. The IdP configures this URL plus the
bearer token in their SCIM-provisioning app. Vestibulum's
`SamlIdpRecord` / `OidcIdpRecord` extensions (above) carry
the path so the admin UI can display the configured URL
without computing it from the tenant ID.

### 6. JIT provisioning still works alongside SCIM

A tenant can have SCIM enabled _or_ rely on JIT (federation
without SCIM), not both for the same provisioning flow. The
post-confirmation Lambda detects which mode is active per
tenant (via `OidcIdpRecord.scimEnabled`) and either:

- **JIT mode**: creates the user in the consumer DB at
  first federated login. The current v0.x behaviour.
- **SCIM mode**: expects the user to already exist (SCIM
  pre-provisioned them); if they don't, either creates them
  on the fly (if the consumer's policy allows JIT-as-fallback)
  or rejects the login (if the consumer's policy requires
  SCIM provisioning first).

The choice is per-tenant, persisted in the consumer's
`TenantIdentityProvider` row (alongside the IdP config), and
read by the post-confirmation Lambda via a callback into the
consumer's DB.

## Cognito's 5-IdPs-per-user cap

Worth a separate callout. Cognito caps the number of federated
identities that can be linked to a single Cognito user at 5.
For SCIM specifically, this matters in two ways:

1. **A user provisioned by SCIM and federating from the same
   IdP**: that's 1 IdP link (the federated login), with the
   SCIM provision being the original Cognito user. Fine.
2. **A user provisioned by SCIM from IdP A, then signing in
   via federated IdPs B, C, D, E, F**: 6 federated identities,
   `AdminLinkProviderForUser` on the 6th throws. Rare in
   practice — most users federate from exactly one IdP — but
   real for users who belong to multiple SCIM-enabled
   organisations and the consumer's product spans those
   organisations.

The handler surfaces this with a typed error:
`ScimError(reason: 'idp_link_cap_exceeded')`. The consumer's
UI shows the user a "your account is linked to too many
identity providers; contact support" message; the support path
involves unlinking an unused IdP via
`AdminDisableProviderForUser`. There is no automatic resolution
— the cap is hard.

## What does _not_ get added later

Even when SCIM lands, vestibulum does not plan to add:

- **SCIM outbound provisioning** (us provisioning users into a
  downstream system). SCIM inbound is the federation-side
  story; outbound is a different product surface entirely.
- **Custom SCIM schema extensions.** SCIM 2.0 supports
  enterprise extensions (e.g.,
  `urn:ietf:params:scim:schemas:extension:enterprise:2.0:User`).
  Vestibulum will ship the standard `User` and `Group` schemas;
  consumer-specific extensions are passthrough only.
- **SCIM 1.1.** Cognito only matters via SCIM 2.0; older
  versions are not in scope.
- **A SCIM client.** Vestibulum is the _server_ side. If a
  consumer needs to push provisioning events out to a
  downstream system, they pick a SCIM client library
  themselves.
- **An "SCIM admin UI".** Configuring SCIM on the IdP side is
  the admin's job in the IdP's own admin UI; vestibulum's
  surface ends at the bearer-token storage and endpoint URL
  display.

## Status

Forward-compatibility only — SCIM is deliberately not implemented in
v0.x. v0.x ships JIT provisioning via the post-confirmation handler;
the reserved namespace and hooks above keep the door open but are not
exercised in code. The first SCIM consumer will surface gaps the
design has not anticipated.

The most likely v1.x-blocker is the account-linking path: the
combination of (a) immutable-attribute restriction on
federation-enabled pools, (b) 5-IdP-per-user cap, and (c)
SCIM-pre-provisioned-then-federated merge — none of which is
exercised in v0.x — may surface a constraint that forces a
schema change. Worth a small spike alongside the SCIM design
when it lands.

## Open questions

- **Per-tenant SCIM toggle or per-IdP?** Currently the design
  assumes per-IdP (an IdP either pushes SCIM or doesn't). A
  tenant with two IdPs configured (a primary + a backup, or
  test + prod) might want SCIM on one and JIT on the other.
  Pencil in as per-IdP; revisit if a consumer asks.
- **SCIM bulk operations.** SCIM 2.0 supports
  `POST /Bulk` for batch user changes. Useful for initial
  large provisions; complex to implement correctly. Defer
  past v0.1 of SCIM.
- **Endpoint hosting: consumer's API process or a dedicated
  Lambda?** Both work. The consumer-API path uses an HTTP
  framework integration (one route per SCIM resource); the
  Lambda path uses a Function URL with the SCIM handler as
  the entry. Lean toward consumer-API integration as the
  default; the Lambda path is a future
  `@de-otio/vestibulum-cdk` construct candidate if a consumer
  asks.
- **`AdminUserGlobalSignOut` synchronously on SCIM
  deactivate, or eventually?** Synchronous is the safe
  default (the SCIM `PATCH` response confirms the user is
  signed out); the AWS SDK call adds ~100ms. Eventually-async
  via SQS is faster but introduces a window where the user
  could still authenticate after the SCIM confirm. Lean
  toward synchronous; revisit if latency becomes a problem
  at scale.
