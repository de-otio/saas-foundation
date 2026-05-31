# Cognito triggers

The two Cognito Lambda triggers vestibulum ships as handler
factories: pre-token-generation (claim shaping at token
issuance) and post-confirmation (JIT provisioning after user
creation). Public API surfaces in
[`./01-package-api.md § Lambda templates`](./01-package-api.md#lambda-templates);
this file covers the mechanics — event-version normalisation,
how the bundled code reaches the deployed Lambda, and the error
discipline that makes the difference between a silent-corruption
failure mode and a loud-failure one.

## Why factory functions, not classes or raw handlers

The two trigger Lambdas have ~80% identical plumbing across
consumers (event-shape parsing, V1/V2/V3 normalisation, error
handling, claim-response formatting). The recurring 80% is
worth capturing once with the mandatory mitigations enforced in
code, not prose. The remaining 20% — what claims to emit, what
data to provision — is the consumer's policy layer, expressed
through a single small callback.

Factory functions, not classes, because there is no per-instance
state to thread through: the factory closes over the callback
once and returns a stateless handler. Classes would force
either `new` syntax in the Lambda entry file (awkward) or
static methods (worse for the callback-injection pattern).

## `createPreTokenGenerationHandler`

```typescript
function createPreTokenGenerationHandler(callbacks: {
  resolveClaims: ClaimResolver;
  onError?: (err: unknown, event: PreTokenGenEvent) => void;
}): PreTokenGenHandler;

type PreTokenGenHandler = (event: PreTokenGenEvent) => Promise<PreTokenGenEvent>;
```

### What it does

1. **Event-version normalisation.** Cognito's pre-token
   generation trigger event has evolved across three versions
   (V1, V2, V3). The handler reads the event's
   `triggerSource` and the presence of V2-only fields to
   identify the version, then constructs a single normalised
   `ClaimResolverInput` regardless. See [§ Event version
   normalisation](#event-version-normalisation).
2. **Identity discrimination.** From the event's `identities`
   array, derives the `ClaimResolverInput.identity`
   discriminator: `{ kind: 'cognito' }` for native Cognito
   logins and magic-link, `{ kind: 'federated', providerName,
providerType }` for federated logins. The consumer's
   callback never has to parse `identities` itself.
3. **Federated-group extraction.** If the federated IdP supplied
   a groups attribute (mapped to a Cognito attribute via the
   IdP's `AttributeMapping`), it's pre-extracted to
   `federatedGroups`. Empty array for native flows.
4. **Callback invocation.** Calls
   `callbacks.resolveClaims(input)` with the normalised input.
5. **Reserved-claim guard.** Before applying the returned
   claims, checks each key against the `RESERVED_CLAIMS` set
   (`iss`, `sub`, `aud`, `exp`, `iat`, `nbf`, `jti`, `nonce`,
   `origin_jti`, `token_use`, `auth_time`, `at_hash`, `acr`,
   `amr`, `azp`, `client_id`, `event_id`, `device_key`,
   `version`, `identities`, `cognito:username`). Throws
   `ReservedClaimError` for any match — overriding `identities`
   in particular would be a federation-spoofing vector.
6. **Response-shape selection.** Builds the appropriate
   `claimsOverrideDetails` (V1) or `claimsAndScopeOverrideDetails`
   (V2/V3) shape for the event version. V2/V3-only features
   (`scopesToAdd`, `scopesToSuppress`, complex-typed claim
   values) are silently dropped on V1; documented behaviour,
   not a runtime error.
7. **Error handling.** Catches any exception from the callback
   or from claim application, invokes `callbacks.onError?` for
   the consumer's observability, then **rethrows**. See
   [§ Error handling discipline](#error-handling-discipline)
   for why.

### Event version normalisation

Cognito ships three versions of the pre-token-generation event:

| Version | Trigger source                                       | What it adds                                                                          |
| ------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| V1      | `TokenGeneration_Authentication` (and friends)       | ID-token claim override only; string-typed only                                       |
| V2      | `TokenGeneration_HostedAuth` and others (Essentials) | Access-token claim override; scope add/suppress; group override; complex-typed values |
| V3      | All sources (Plus)                                   | V2 plus client-credentials flow event support                                         |

V2 and V3 require the Cognito **Essentials** or **Plus** feature
plan; Lite pools receive V1 only. The handler does not gate
itself on tier; it inspects the event shape and normalises.
Documented in
[`./06-pool-topology.md`](./06-pool-topology.md) as the reason
the recommended default is two pools (B2C Lite + B2B
Essentials).

The normalisation flattens the three event shapes into one:

```typescript
// Cognito V1 event (simplified):
{
  triggerSource: 'TokenGeneration_Authentication',
  request: {
    userAttributes: { ... },
    groupConfiguration: { groupsToOverride: [...] },
    // No accessTokenGeneration field.
  },
  response: { claimsOverrideDetails: null },
}

// Cognito V2 event (simplified):
{
  triggerSource: 'TokenGeneration_HostedAuth',
  request: {
    userAttributes: { ... },
    groupConfiguration: { ... },
    scopes: ['openid', 'email'],
    clientMetadata: { ... },
  },
  response: { claimsAndScopeOverrideDetails: null },
}

// Normalised ClaimResolverInput (single shape):
{
  userSub: 'cognito-sub-here',
  userAttributes: { ... },
  clientId: '...',
  triggerSource: 'TokenGeneration_HostedAuth',  // KnownClaimTriggerSource | (string & {})
  identity: { kind: 'federated', providerName: 'tenant-acme', providerType: 'OIDC' },
  federatedGroups: ['admins', 'devs'],
  isRefresh: false,
  untrustedClientMetadata: { ... },
}
```

The `triggerSource` is preserved as-is (open-union sentinel
pattern, per
[`./01-package-api.md § Claim resolver callback`](./01-package-api.md#claim-resolver-callback)
and the canonical `KnownClaimTriggerSource` list in
[`../04-shared-vocabulary.md`](../04-shared-vocabulary.md#claimresolverinput-and-provisionerinput)),
so consumers can branch on known values and treat unknown
sources defensively. A future SCIM trigger source — say,
`'PreTokenGeneration_ScimAttributeRefresh'` — would land on the
same callback without an API bump.

### Untrusted client metadata

The `clientMetadata` field on Cognito's
`AdminRespondToAuthChallenge` / `RespondToAuthChallenge` calls is
surfaced as `ClaimResolverInput.untrustedClientMetadata`. The
field rename (from `clientMetadata` to
`untrustedClientMetadata`) makes the trust boundary visible at
the type level — `clientMetadata` reads as "metadata the
trusted client sent" by reflex; the explicit prefix removes the
ambiguity.

**MUST NOT be trusted for authorization decisions.** Cognito
passes the field through from the calling client (web SDK,
mobile SDK, custom IdP integration) without any validation or
sanitisation. A malicious client injects arbitrary key-value
pairs. If a consumer's `resolveClaims` callback reads
`untrustedClientMetadata.requestedRole` and uses it to choose
which tenant claims to emit, that is a privilege-escalation
vector — the client picks its own role.

Legitimate uses are non-security-sensitive routing hints:

- UI theme (`theme: 'dark'` / `'light'`).
- Locale preference (`locale: 'de-DE'`).
- Originating surface (`origin: 'web-app'` vs `'mobile'`) for
  observability tagging — _not_ for branching auth logic.

**Cognito does NOT propagate `clientMetadata` from
`InitiateAuth` / `AdminInitiateAuth`** ([trigger event
reference](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-triggers.html#cognito-user-pools-lambda-trigger-syntax-pre-token-generation)).
The field is only populated when the client explicitly attaches
it to `RespondToAuthChallenge` or `AdminRespondToAuthChallenge`.
For federation flows — where the Cognito challenge response is
internal to the federation handshake, not driven by the
consumer's client — the field is typically empty. Surfacing it
on `ClaimResolverInput` lets consumers opt into using it for the
legitimate cases above with eyes open about the trust boundary.

### `RESERVED_CLAIMS` exported

The reserved-claim list is exported as a constant:

```typescript
import { RESERVED_CLAIMS } from "@de-otio/vestibulum";

// Consumer-side validation, e.g. in an admin UI that lets
// admins configure custom claim names:
if (RESERVED_CLAIMS.has(proposedClaimName)) {
  return { error: "reserved_claim" };
}
```

Programmatic access is for admin UIs that want to validate
input _before_ it reaches the runtime — same data, two
enforcement points.

## `createPostConfirmationHandler`

```typescript
function createPostConfirmationHandler(callbacks: {
  provision: Provisioner;
  onError?: (err: unknown, event: PostConfEvent) => void;
}): PostConfHandler;
```

### What it does

1. Normalises the post-confirmation event (single version
   today; the shape is more stable than pre-token-generation).
2. Calls `callbacks.provision(input)` with a `ProvisionerInput`
   carrying user attributes, identity-provider identification
   (federated vs native), and the trigger source
   (`PostConfirmation_ConfirmSignUp` or
   `PostConfirmation_ConfirmForgotPassword`).
3. Always returns the event unmodified —
   `post-confirmation` triggers cannot mutate the user.
4. If `provision` throws, the handler rethrows, which causes
   Cognito to roll back the user confirmation. See [§ Error
   handling discipline](#error-handling-discipline).

### When it fires

- **For federated logins:** on first sign-in. Cognito JIT-creates
  the user account from the federated identity and fires
  post-confirmation. Subsequent sign-ins by the same user do
  not re-trigger.
- **For magic-link / native:** after the user clicks the magic
  link and Cognito confirms the sign-up.
- **For password resets:** after a successful
  `ConfirmForgotPassword`. Provisioner gets
  `triggerSource: 'PostConfirmation_ConfirmForgotPassword'` and
  can branch (typically: no-op, the user is already
  provisioned).

The provisioner is invoked exactly once per user per
confirmation event. Reliable side effects (user-record creation,
tenant-membership grants, welcome emails) belong here.

### Tenant lookup is the consumer's responsibility

`ProvisionerInput.identity.providerName` is the Cognito IdP name
(e.g., `tenant-acme-clxx...`). The consumer's
`TenantIdentityProvider` table is the source of truth for the
`cognitoIdpName → TenantId` reverse mapping; vestibulum does not
provide this lookup. The same holds for
`ClaimResolverInput.identity.providerName` in the pre-token-gen
Lambda.

Typical consumer pattern inside the callback:

```typescript
const provision: Provisioner = async (input) => {
  if (input.identity.kind === "federated") {
    const tenantId = await db.tenantIdentityProvider
      .findUnique({
        where: { cognitoIdpName: input.identity.providerName },
      })
      .then((row) => row?.tenantId);
    if (!tenantId) throw new Error("Unknown federation IdP");
    // ...provision against the resolved tenant...
  }
};
```

Vestibulum stays out of this lookup so the consumer's tenant
schema (cuid / uuid / slug / whatever) remains opaque, and so
the same callback shape works whether the consumer's IdP table
is in Postgres, DynamoDB, or somewhere else entirely.

## Error handling discipline

The factory functions rethrow on callback failure. Both Lambdas.
Always. This is the single most consequential design choice in
the trigger surface.

### Why rethrow

**Pre-token-generation**: if the callback throws (consumer DB
unavailable, tenant lookup failed, claim resolution timed out)
and the handler swallows the error, Cognito issues a token
without the consumer's claims. The user gets a "successful"
login that's silently authorised as a non-tenant or non-admin
user. The bug surfaces later as authorisation drift ("why is
this user a B2C user when they federated through their B2B IdP?")
and is much harder to diagnose than a failed login.

Rethrowing turns the failure mode into "the login fails with an
error the user can report". Cognito surfaces a generic auth
error; the consumer's logs (via `onError`) carry the structured
detail. This is loud-failure, by design.

**Post-confirmation**: if the callback throws (consumer DB
write failed, JIT user-record creation hit a unique-constraint
violation, etc.) and the handler swallows the error, Cognito
considers the user confirmed but the consumer's database has no
corresponding row. The user can now log in (their Cognito
account exists) but every request fails because the consumer
has no user record for them. Half-created users are worse than
failed sign-ups.

Rethrowing causes Cognito to **roll back the user confirmation**
— the user gets a sign-up error, can retry once the consumer-side
issue is fixed, and there is no orphan Cognito user.

### `onError` is for observability, not recovery

The optional `onError` callback fires _before_ the rethrow.
Consumers use it to log to their observability stack (CloudWatch
Logs, Sentry, etc.) with structured context. It must not throw
itself; a throwing `onError` is caught and swallowed so it
cannot mask the original error.

```typescript
const handler = createPreTokenGenerationHandler({
  resolveClaims: async (input) => {
    /* ... */
  },
  onError: (err, event) => {
    logger.error("Claim resolution failed", {
      err,
      userSub: event.request.userAttributes.sub,
      tenant: event.request.userAttributes["custom:activeTenantId"],
    });
  },
});
```

Consumers cannot use `onError` to "recover" by returning
fake-success claims; the rethrow happens regardless. The hook is
narrowly for "I want my logs to know about this", not "I want
the user to still log in".

## How the bundled code reaches the deployed Lambda

Vestibulum's runtime code does not deploy itself. It reaches
the Cognito user pool via `@de-otio/vestibulum-cdk`'s bundling
step:

1. **Consumer writes a small entry file** in their CDK app that
   imports vestibulum's factory and supplies a callback:

   ```typescript
   // consumer-app/src/lambda/pre-token.ts
   import { createPreTokenGenerationHandler } from "@de-otio/vestibulum";
   import { resolveClaims } from "./my-claim-resolver.js";

   export const handler = createPreTokenGenerationHandler({
     resolveClaims,
   });
   ```

2. **vestibulum-cdk's `build-bundles.ts` runs at publish time**
   (of vestibulum-cdk, not the consumer's app):
   - esbuild bundles vestibulum's pre-token-generation
     factory into a single self-contained `.js` file.
   - Output: `packages/vestibulum-cdk/lambda-bundles/pre-token-<hash>.js`.
   - SHA-256 hashes go into
     `packages/vestibulum-cdk/lambda-bundles.lock.json`.

3. **vestibulum-cdk's CDK constructs reference the bundled
   files at synth time** via `lambda.Code.fromAsset(...)`. The
   consumer's CDK app instantiates the construct, which knows
   which bundle to deploy.

4. **The consumer's own Lambda entry file** (step 1) is what
   actually deploys. It imports from `@de-otio/vestibulum` at
   runtime — _if_ the consumer is using their own deploy
   tooling (not vestibulum-cdk). When vestibulum-cdk is in
   play, the bundling step pulls in vestibulum source as a
   build-time input, and the consumer's entry file is the
   one bundled with it.

See [`../03-package-relationships.md § The bundling relationship
in detail`](../03-package-relationships.md#the-bundling-relationship-in-detail)
for the full mechanics — including the
`verify-bundles` CI gate that catches the case where someone
tries to publish vestibulum-cdk without re-bundling after a
vestibulum change.

### Version-bump consequences

- A vestibulum change that only affects non-Lambda code (e.g.,
  the `OidcIdpManager` used by an admin HTTP handler) does
  **not** require re-publishing vestibulum-cdk. Bump
  vestibulum, leave vestibulum-cdk alone.
- A vestibulum change that touches `createPreTokenGenerationHandler`
  or `createPostConfirmationHandler` (or any code reachable
  from them) requires re-bundling and re-publishing
  vestibulum-cdk with the bumped `lambda-bundles.lock.json`.
- A consumer who installs `@de-otio/vestibulum@0.2.0` and
  `@de-otio/vestibulum-cdk@0.1.5` (the latter bundling
  `vestibulum@0.1.4`) is fine — _unless_ they expect their
  Lambda triggers to run the 0.2.0 code. They won't. Lambdas
  run the bundled-at-publish-time code. The consumer-facing
  docs make this explicit.

This split between "runtime npm dep" (consumer's API process,
hot-swappable) and "bundled Lambda code" (CDK-managed,
publish-time-pinned) is deliberate. CDK constructs accidentally
calling Cognito SDK at synth time is a real failure mode that
the bundling isolation prevents.

## IAM principle of least privilege

The two trigger Lambdas should have minimal IAM. Specifically:

- **`secretsmanager:GetSecretValue`**: NOT needed. The triggers
  do not read OIDC client secrets; only the IdP-upsert code
  path does, and that runs in the consumer's admin HTTP
  handler, not in the trigger Lambdas.
- **`cognito-idp:CreateIdentityProvider` /
  `UpdateIdentityProvider`**: NOT needed. The triggers do not
  call IdP-management APIs.
- **`logs:CreateLogGroup` / `CreateLogStream` /
  `PutLogEvents`**: needed (Lambda default execution role).
- **Consumer-callback-specific permissions**: whatever the
  consumer's `resolveClaims` / `provision` callback needs (e.g.,
  DynamoDB read for tenant lookup, RDS connection via
  `rds-data` for membership queries). Granted on the consumer
  side, not by vestibulum.

The CDK constructs in `@de-otio/vestibulum-cdk` enforce this —
the trigger-Lambda execution roles do not grant the IdP-upsert
permissions even if the same vestibulum version exposes both
surfaces in code.

## Open questions

- **Should the handler accept a foundation `logger`?**
  Currently the factory takes only the callback. A
  `logger?: Logger` prop on the callback object would let the
  trigger Lambda emit structured logs via foundation's logger
  (with request-id correlation via AsyncLocalStorage if the
  consumer's callback sets it up). Lean toward yes; decide
  alongside foundation's `logger-and-request-context` module
  design.
- **`AuditEvent` emission from the post-confirmation Lambda.**
  First-sign-in for a federated user is a meaningful audit
  event (`auth.federated_link` with the IdP details). The
  Lambda has the information; the consumer's callback may or
  may not emit the audit. Should the factory emit one
  automatically when the callback succeeds, via an injected
  audit-sink? Lean toward yes; decide alongside foundation's
  `audit` module.
- **V3 event support.** V3 adds client-credentials-flow event
  support; vestibulum doesn't have an opinion about
  client-credentials yet. Defer until a consumer asks; the
  open-union `triggerSource` keeps the door open.
