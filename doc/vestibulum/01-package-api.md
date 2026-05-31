# `@de-otio/vestibulum` — public API

This file specifies the public surface of the vestibulum runtime
package. The structure follows the five concern areas from
[`README.md § What vestibulum owns`](README.md#what-vestibulum-owns):
IdP managers, issuer probe, secrets handling, Lambda templates,
and callback shapes. JWT verification helpers — added when the
two-pool topology was settled — sit alongside as a sixth area.

Everything in this file is consumer-facing. Internal helpers
(Cognito SDK clients, JSON Schema validators, XML parsers) are
implementation detail and not exported.

## Package layout

```
packages/vestibulum/
  src/
    index.ts                 // re-exports (the canonical export surface)
    types/
      frozen/
        callbacks.ts          // ClaimResolverInput, ClaimResolverOutput,
                              //   ProvisionerInput, CallbackIdentity — the
                              //   frozen-set types vestibulum mints (see
                              //   ../04-shared-vocabulary.md). CI fanout
                              //   gate watches this path.
        index.ts
      identity.ts
      reserved-claims.ts
      secret-kind.ts
    idp/
      oidc-manager.ts        // OidcIdpManager
      saml-manager.ts        // SamlIdpManager
      idp-name.ts            // tenant-{id} naming (see below)
    discovery/
      oidc-probe.ts          // probeOidcIssuer
      saml-metadata.ts       // parseSamlMetadata
      private-ip.ts          // SSRF guard
    secrets/
      secrets-client.ts      // IdpSecretsClient
      read-internal.ts
    profiles/
      oidc.ts                // oidcProfile*, OIDC_PROFILES
      saml.ts                // samlProfile*, SAML_PROFILES
    pools/
      index.ts               // createPoolRegistry, PoolKind, PoolRegistry
      pool-config.ts
      pool-registry.ts
    saml/
      sp-metadata.ts         // buildSpMetadata, wrapPem
    scim/
      index.ts               // forward-compat (see 07-scim-forward-compat.md)
    lambda/
      pre-token-generation.ts          // createPreTokenGenerationHandler
      post-confirmation.ts             // createPostConfirmationHandler
      cognito-events.ts                // V1/V2/V3 normalisation
      shared/
        runtime-env.ts                 // RuntimeEnv, RuntimeEnvKey
      handlers/
        pre-signup/index.ts            // createPreSignupHandler
        define-auth-challenge/index.ts // createDefineAuthChallengeHandler
        create-auth-challenge/index.ts // createCreateAuthChallengeHandler
        verify-auth-challenge/index.ts // createVerifyAuthChallengeResponseHandler
        bounce-handler/index.ts        // createBounceHandler
        auth-verify/index.ts           // createAuthVerifyHandler
        auth-signout/index.ts          // createAuthSignoutHandler
      edge/
        check-auth/index.ts            // createEdgeCheckAuthHandler
      shared-distribution/             // v0.2 shared-distribution mode,
                                       //   re-exported under the
                                       //   `sharedDistribution` namespace
        index.ts
        admin/                         // tenant CRUD actions + reconciler
        edge/                          // multi-tenant edge check-auth
        triggers/                      // multi-tenant Cognito triggers
        shared/                        // client-config-loader,
                                       //   wrap-pre-token-handler, etc.
    verify/
      multi-pool-verifier.ts   // createMultiPoolVerifier, requirePool,
                               //   canonicalIssuer
    callbacks/
      types.ts                 // ClaimResolver, Provisioner function
                               //   aliases (logic shapes; the
                               //   *Input/*Output types live under
                               //   types/frozen/callbacks.ts)
    errors.ts                  // error class hierarchy
```

The Lambda handler factories under `lambda/`, `lambda/handlers/`,
and `lambda/edge/` were colocated with the CDK constructs in the
standalone vestibulum repo (`lib/lambda-handlers/`,
`lib/lambda-edge/`); the
[`../07-vestibulum-migration.md § Lambda handler source move`](../07-vestibulum-migration.md#lambda-handler-source-move--the-cross-package-bundling-prerequisite)
section settles their placement inside this package. Reasoning:
the runtime is what runs at request time; `@de-otio/vestibulum-cdk`
only bundles these factories at build time via esbuild. Without
this split there is no cross-package boundary for the bundle
hash-verify CI gate to verify across.

The published package exports from `src/index.ts` only. Subpath
imports (`@de-otio/vestibulum/idp/...`) are not supported in the
consumer-facing surface (`package.json` declares a single `"."`
export); `@de-otio/vestibulum-cdk` reaches into specific entry
points at _build_ time only, via esbuild, not via npm import
paths (see [`../03-package-relationships.md § The bundling
relationship in detail`](../03-package-relationships.md#the-bundling-relationship-in-detail)).

### Exported surface (generated from `src/index.ts`)

The barrel below is the source of truth; this list is generated
from it. The sections further down document the load-bearing
members in detail. Beyond the IdP managers, probe/discovery,
secrets client, multi-pool verifier, Lambda factories, and
callback/error types covered below, the index also exports:

- **`canonicalIssuer`** — issuer-string canonicaliser, from
  `verify/multi-pool-verifier.ts` (alongside `createMultiPoolVerifier`
  and `requirePool`).
- **`CallbackIdentity`** — the federated-identity shape passed to
  callbacks, from `types/frozen/callbacks.ts`.
- **`OIDC_PROFILES` / `SAML_PROFILES`** plus the individual
  `oidcProfile*` / `samlProfile*` records and the `OidcProfile` /
  `SamlProfile` types, from `profiles/oidc.ts` and
  `profiles/saml.ts`.
- **`buildSpMetadata` / `wrapPem`** (and `BuildSpMetadataProps`,
  `SpMetadata`), from `saml/sp-metadata.ts`.
- **`createPoolRegistry` / `PoolKind` / `PoolRegistry`**, from
  `pools/index.ts` — the forward-compat pool-topology vocabulary.
- **`RuntimeEnv` / `RuntimeEnvKey`**, from `lambda/shared/runtime-env.ts`
  — the environment-variable key constants the handlers read.
- **`sharedDistribution`** — a namespace
  (`export * as sharedDistribution from "./lambda/shared-distribution/index.js"`)
  exposing the v0.2 shared-distribution mode (admin, edge,
  triggers, shared). Additive over v0.1; see
  [`shared-distribution/`](shared-distribution/README.md).

### Cross-package type re-exports

The four foundation-owned frozen-set types
([`../04-shared-vocabulary.md`](../04-shared-vocabulary.md)) are
re-exported from vestibulum's index so consumers have a single
import surface; vestibulum re-exports for consumer convenience,
and vestibulum itself only reads the context (the `set` side is
foundation's). The vestibulum-minted frozen types
(`ClaimResolverInput`, `ClaimResolverOutput`, `ProvisionerInput`)
are defined under `src/types/frozen/callbacks.ts` and exported
alongside the function-shape aliases:

```typescript
// src/index.ts
export type { TenantId, AuditEvent, RequestContext, SecretRef } from "@de-otio/saas-foundation";

export type {
  ClaimResolverInput,
  ClaimResolverOutput,
  ProvisionerInput,
  CallbackIdentity,
} from "./types/frozen/callbacks.js";

export type { ClaimResolver, Provisioner } from "./callbacks/types.js";
```

Vestibulum re-exports; never re-defines. Two definitions of
`TenantId` in two packages create two distinct nominal identities
and the type checker stops catching shape mismatches —
[`../04-shared-vocabulary.md § Where each type is defined`](../04-shared-vocabulary.md#where-each-type-is-defined)
spells this out.

The `types/frozen/callbacks.ts` location is the path the CI
fanout gate watches for vestibulum-owned frozen-set changes (the
sibling of `packages/foundation/src/types/frozen/` for the
foundation-owned ones). Anything outside that file can churn
PATCH-level without consumer impact; anything inside it requires
an RFC and a coordinated bump across consumers — see
[`../05-versioning-and-releases.md § RFC process for frozen-types`](../05-versioning-and-releases.md#rfc-process-for-frozen-types).

### `idp-name.ts` normalisation

Cognito's `ProviderName` field is constrained by the regex
`[^_\p{Z}][\p{L}\p{M}\p{S}\p{N}\p{P}][^_\p{Z}]+`
with a 32-character maximum
([CreateIdentityProvider API ref](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateIdentityProvider.html)).
The relevant constraints: no leading underscore, no leading
whitespace, no leading/trailing Unicode space-class character.
The internal `idp-name.ts` derives a Cognito-safe name from an
arbitrary consumer `TenantId` via:

1. Lowercase the input.
2. Replace any character outside `[a-z0-9-]` with `-`.
3. Collapse runs of `-` to a single `-`.
4. Strip leading/trailing `-`.
5. Truncate to 25 characters (leaving 7 chars for the `tenant-`
   prefix).
6. Prepend `tenant-`.
7. **Uniqueness guard**: the normalisation is lossy (two tenant
   IDs sharing the first 25 normalised chars produce the same
   Cognito name). The consumer's database stores the
   `{tenantId → cognitoIdpName}` mapping; if a second tenant
   would collide, the manager refuses the upsert with
   `IdpManagerError(reason: 'name_collision')` and the admin UI
   must surface the conflict.

Unit tests for `idp-name.ts` cover: leading underscore, leading
whitespace, Unicode input, emoji input, collision detection,
exact 25/26 length boundaries, and the empty/whitespace-only
edge cases.

### Reserved future slot

The `scim/` subdirectory is **reserved** for a future SCIM 2.0
inbound endpoint handler and its supporting types. It exists as a
stub in v0.x (`export {}`) — staked out so the namespace is reserved
and naming and structural placement are decided before implementation.
Consumers MUST NOT rely on any specific shape here until v1.x lands
SCIM support. See
[`07-scim-forward-compat.md`](07-scim-forward-compat.md).

## IdP managers

Two manager classes wrap the relevant Cognito SDK calls behind a
tenant-aware interface.

### `OidcIdpManager`

```typescript
import type { TenantId, SecretRef } from "@de-otio/saas-foundation";

class OidcIdpManager {
  constructor(props: {
    userPoolId: string;
    region?: string; // defaults to AWS_REGION
    cognitoClient?: CognitoIdentityProviderClient; // for DI in tests
  });

  /**
   * Create or update an OIDC IdP for a tenant.
   * Idempotent: if an IdP with the derived name
   * already exists, performs an update.
   */
  async upsert(input: OidcIdpInput): Promise<OidcIdpRecord>;

  /**
   * Delete the IdP and remove its name from every
   * app client's SupportedIdentityProviders list.
   *
   * Concurrency: the manager reads the current
   * app-client config, modifies the
   * `SupportedIdentityProviders` array, and writes
   * back. Cognito has no conditional-write
   * primitive on app-client mutations, so two
   * concurrent `delete` calls against the same
   * pool can lose updates. The recommended shape
   * is to wrap the call in foundation's `kv`
   * lock-helper (foundation owns the lock
   * primitive; vestibulum doesn't redo it). See
   * the sketch below.
   */
  async delete(tenantId: TenantId): Promise<void>;

  /**
   * Read the current state from Cognito. Returns
   * undefined if no IdP is registered for this
   * tenant.
   */
  async get(tenantId: TenantId): Promise<OidcIdpRecord | undefined>;

  /**
   * Attach the IdP to one or more app clients.
   * Mutates SupportedIdentityProviders. Returns
   * the final state.
   */
  async attachToAppClients(tenantId: TenantId, appClientIds: string[]): Promise<void>;
}

interface OidcIdpInput {
  tenantId: TenantId; // branded; see ../04-shared-vocabulary.md
  issuer: string; // OIDC issuer URL
  clientId: string;
  /**
   * Secrets Manager ref pointing at the consumer's
   * stored client secret. **Typically unpinned**
   * (no `versionId`) — `IdpSecretsClient.refFor`
   * returns this shape for direct use as `upsert`
   * input. `OidcIdpManager.upsert` reads the
   * current version internally during the call and
   * records the pinned version on the returned
   * `OidcIdpRecord.clientSecret`. NOT the secret
   * value.
   */
  clientSecret: SecretRef;
  scopes?: string[]; // defaults to ['openid', 'email', 'profile']
  attributeMapping?: Record<string, string>; // defaults provided
  idpIdentifiers?: string[]; // email domains for SP-initiated routing
}

interface OidcIdpRecord {
  tenantId: TenantId;
  cognitoIdpName: string; // e.g. 'tenant-clxxx...'
  status: "ACTIVE" | "PENDING" | "ERROR";
  /**
   * Pinned `SecretRef` — carries the `versionId`
   * actually read at upsert time and pushed to
   * Cognito. Lets the consumer audit "which
   * Secrets Manager version is Cognito holding
   * right now" without a second round-trip; lets
   * rotation tooling detect drift (current
   * `AWSCURRENT` differs from the pinned version
   * Cognito has) and trigger a re-upsert.
   */
  clientSecret: SecretRef;
  attachedAppClientIds: string[];
  lastSyncedAt: Date;
}
```

**`refFor` → `upsert` → `OidcIdpRecord.clientSecret` contract.**
`IdpSecretsClient.refFor(tenantId)` returns an _unpinned_
`SecretRef` (ARN only, no `versionId`) — the canonical input shape
for `OidcIdpManager.upsert`. Inside `upsert`, the manager:

1. Calls `resolveSecret(input.clientSecret)` to fetch the current
   plaintext + the version actually served (foundation's
   `secrets` module returns both — the version is needed for
   pinning).
2. Calls `CreateIdentityProvider` / `UpdateIdentityProvider` with
   the plaintext as `ProviderDetails.client_secret`.
3. Emits an `OidcIdpRecord` whose `clientSecret` is now _pinned_
   to the version that was just pushed to Cognito.

The consumer persists the pinned `OidcIdpRecord.clientSecret` on
their `TenantIdentityProvider` row. A later rotation flow that
calls `upsert` again with the unpinned `refFor(...)` input will
read the new `AWSCURRENT` version and update the pinned record;
drift between the persisted pin and `AWSCURRENT` is the signal
that Cognito is holding a stale secret.

**Recommended `delete` concurrency wrap.** Wrap `delete` (and any
mutation that touches `SupportedIdentityProviders` — `upsert` and
`attachToAppClients` are in the same boat) with foundation's `kv`
lock helper:

```typescript
import { withLock } from "@de-otio/saas-foundation/kv";

await withLock(kv, `vestibulum:idp:${userPoolId}:${tenantId}`, { ttlMs: 30_000 }, () =>
  oidcManager.delete(tenantId),
);
```

The lock key is `pool-scoped` (not tenant-scoped) where the
underlying contention is — the app-client mutation reads and
writes the per-pool `SupportedIdentityProviders` array, so a
delete of tenant A and a delete of tenant B against the same
pool can still race the read-modify-write even though they
target different tenants. A `vestibulum:idp:{userPoolId}` lock
collapses both into a queue; tenant-scoped locks miss that. The
lock primitive lives in foundation's `kv` module; vestibulum
doesn't redo it.

`clientSecret` is a foundation-owned `SecretRef` —
[`../04-shared-vocabulary.md § SecretRef`](../04-shared-vocabulary.md#secretref).
It carries the Secrets Manager ARN and an optional version pin;
it does **not** carry the plaintext value. Cognito itself stores
the literal client secret — it does not dereference Secrets
Manager ARNs at token-exchange time
([CreateIdentityProvider API ref](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateIdentityProvider.html)) —
so the manager reads the plaintext from Secrets Manager during
`upsert(...)` (via foundation's `resolveSecret(ref): Promise<string>`)
and passes it to `CreateIdentityProvider` / `UpdateIdentityProvider`
as the `client_secret` field. The IAM execution role attached to
the upsert path needs `secretsmanager:GetSecretValue` scoped to
the relevant ARN prefix.

The plaintext lives only on the call stack of the manager method;
it is never logged, returned, or stored locally beyond the SDK
invocation. See
[`02-oidc-flows.md § Client-secret handling`](02-oidc-flows.md#client-secret-handling)
for the full mechanics.

### `SamlIdpManager`

```typescript
class SamlIdpManager {
  constructor(props: {
    userPoolId: string;
    region?: string;
    cognitoClient?: CognitoIdentityProviderClient;
  });

  async upsert(input: SamlIdpInput): Promise<SamlIdpRecord>;
  async delete(tenantId: TenantId): Promise<void>;
  async get(tenantId: TenantId): Promise<SamlIdpRecord | undefined>;
  async attachToAppClients(tenantId: TenantId, appClientIds: string[]): Promise<void>;
}

interface SamlIdpInput {
  tenantId: TenantId;
  metadata: { kind: "url"; url: string } | { kind: "xml"; xml: string };
  attributeMapping?: Record<string, string>;
  idpIdentifiers?: string[];
  signRequest?: boolean; // default true
  encryptAssertions?: boolean; // default true if IdP cert supports it
  acceptUnsignedMetadata?: boolean; // default false — see 03-saml-flows.md
}

interface SamlIdpRecord {
  tenantId: TenantId;
  cognitoIdpName: string;
  status: "ACTIVE" | "PENDING" | "ERROR";
  metadataExpiresAt?: Date; // from <md:EntityDescriptor validUntil>
  signingCertNotAfter?: Date;
  attachedAppClientIds: string[];
  lastSyncedAt: Date;
}
```

SAML differs from OIDC at the API level in three ways:

1. **No client secret.** SAML uses X.509 certificates for
   assertion signing/encryption, embedded in metadata. No
   Secrets Manager involvement.
2. **Metadata can be URL or pasted XML.** URL is preferred
   (Cognito refetches periodically); XML paste is supported for
   IdPs that don't expose public metadata.
3. **Metadata can expire.** The returned record surfaces
   `metadataExpiresAt` and `signingCertNotAfter` so consumers
   can alert admins ahead of rotation. See
   [`03-saml-flows.md § Signing-cert rotation`](03-saml-flows.md#signing-cert-rotation).

### Why a class, not free functions

State accumulates: the Cognito client instance, the user pool ID,
the region, the optional in-memory cache of `cognitoIdpName`
lookups. Classes group the configuration once at construction;
consumers call `manager.upsert(...)` against the bound state
rather than passing `userPoolId` to every function.

Free functions would also work but would force either repetitive
arg passing or a global config singleton — both worse for
testability. (Foundation's "no singletons; constructor injection"
principle —
[`../01-scope-and-philosophy.md § Design principles`](../01-scope-and-philosophy.md#design-principles).)

## Issuer probe

```typescript
/**
 * Fetches and validates an OIDC issuer's discovery
 * document. Used by admin flows before saving an
 * IdP config — never inside the auth hot path.
 */
async function probeOidcIssuer(
  issuerUrl: string,
  options?: {
    timeoutMs?: number; // default 5000
    fetchImpl?: typeof fetch; // for testing
  },
): Promise<OidcIssuerMetadata>;

interface OidcIssuerMetadata {
  issuer: string; // must match issuerUrl after normalisation
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  userinfoEndpoint?: string;
  scopesSupported?: string[];
  responseTypesSupported: string[];
  idTokenSigningAlgValuesSupported: string[];
  // Other RFC 8414 fields surfaced as-is.
}
```

Validation enforced inside `probeOidcIssuer`:

- **URL length cap.** Refuse `issuerUrl` longer than 2048 chars
  before parsing — defends against pathologically long inputs.
- HTTPS only (HTTP rejected even on localhost).
- **No URL credentials.** Refuse URLs containing `user:pass@`
  even over HTTPS — the credential segment is never legitimate
  for an OIDC issuer and is a known injection vector (an admin
  who pastes `https://attacker:bearer-token@victim.example` would
  exfiltrate the bearer through the outbound request).
- **SSRF guard with DNS-rebinding TOCTOU defence.** DNS-resolve
  the issuer host and refuse non-public destinations before
  connecting:
  - IPv4 private / special-purpose ranges per RFC 6890:
    `0.0.0.0/8` ("this network"; note `0.0.0.0/32` itself
    resolves to localhost on Linux at connect time, which the
    `/8` covers),
    `10.0.0.0/8` (private),
    `100.64.0.0/10` (CGNAT),
    `127.0.0.0/8` (loopback),
    `169.254.0.0/16` (link-local, covers the EC2 IMDS endpoint
    `169.254.169.254`),
    `172.16.0.0/12` (private),
    `192.0.0.0/24` (IETF Protocol Assignments),
    `192.0.2.0/24` (TEST-NET-1, documentation/examples),
    `192.168.0.0/16` (private),
    `198.18.0.0/15` (benchmarking),
    `198.51.100.0/24` (TEST-NET-2, documentation/examples),
    `203.0.113.0/24` (TEST-NET-3, documentation/examples),
    `224.0.0.0/4` (multicast),
    `240.0.0.0/4` (Class E, reserved for future use),
    `255.255.255.255/32` (limited broadcast).
  - IPv6 equivalents: `::1` (loopback), `fc00::/7` (ULA),
    `fe80::/10` (link-local), `ff00::/8` (multicast),
    `2001:db8::/32` (documentation prefix), and
    `::ffff:0:0/96` (IPv4-mapped, with the IPv4 ruleset applied
    to the embedded address).
  - Refuse non-default ports unless explicit
    `allowNonDefaultPort: true` is passed.

  **Critical:** validating an IP and then handing the URL to
  `fetch` is not enough. Node's `fetch` performs its own DNS
  lookup at connect time, so an attacker controlling DNS with
  TTL=0 can return a public IP for the validation resolve and a
  private IP for the connect resolve (classic DNS-rebinding
  TOCTOU). The implementation pins the connect step to the
  validated IP via an `undici.Agent` with a custom `lookup`
  that bypasses DNS:

  ```typescript
  const agent = new Agent({
    connect: {
      lookup: (_h, _o, cb) => cb(null, validatedIp, family),
    },
  });
  await fetch(probeUrl, { dispatcher: agent, ... });
  ```

  This implementation is the reference for any HTTP fetcher
  added to `@de-otio/saas-foundation`. Foundation's
  "SSRF defence is default-on in every HTTP fetcher" principle
  ([`../01-scope-and-philosophy.md § Design principles`](../01-scope-and-philosophy.md#design-principles))
  delegates to this pattern.

  Maintaining the CIDR list inline is a known liability — each
  new RFC reserved block becomes a vestibulum patch release.
  See [§ Open questions](#open-questions) for the audited-library
  alternative (`ip-cidr` + `is-cidr`) tracked for the impl pass.

- **HTTP redirects rejected.** Pass `redirect: 'manual'` to
  `fetch` and refuse any 3xx response. Without this, a public
  issuer URL can return `302 Location:
https://169.254.169.254/...` and bypass the IP allowlist on the
  redirect hop.
- **Streaming body cap, not Content-Length trust.** Read the
  response body in chunks with a running byte counter; cancel
  the stream once the cap is exceeded. Trusting `Content-Length`
  alone allows a hostile server to claim a small size and send
  unbounded data. Cap: 1 MiB (OIDC discovery documents are
  typically a few KB but some bundle extensive metadata).
- Issuer URL in the response matches the request URL (normalised:
  trailing slash, case, host canonicalisation). Mismatch is a
  security signal, not just a cosmetic one.
- `response_types_supported` contains `code`.
- `id_token_signing_alg_values_supported` is a non-empty subset
  of `[RS256, RS384, RS512, ES256, ES384, ES512]`. `none` is
  rejected.
- `token_endpoint_auth_methods_supported` contains
  `client_secret_post` (Cognito does not support
  `client_secret_basic` or other client-auth methods — see
  [`02-oidc-flows.md § Token-endpoint authentication method`](02-oidc-flows.md#token-endpoint-authentication-method)).
- Network errors raise `OidcProbeError` with a `reason`
  discriminant: `unreachable`, `timeout`, `invalid_json`,
  `issuer_mismatch`, `unsupported_alg`, `too_large`, `not_https`,
  `ssrf_blocked_destination`, `unsupported_auth_method`,
  `redirect_blocked`, `url_too_long`, `url_has_credentials`.

SAML metadata has a separate `parseSamlMetadata` function with
similar shape; see
[`03-saml-flows.md § Metadata parsing`](03-saml-flows.md#metadata-parsing).

## Secrets handling

```typescript
import type { SecretRef } from "@de-otio/saas-foundation";

class IdpSecretsClient {
  constructor(props: {
    region?: string;
    secretPrefix: string; // e.g. '/vestibulum/idp/'
    secretsClient?: SecretsManagerClient;
  });

  /**
   * Store or rotate a secret. Returns a SecretRef
   * pinning the version that was just written. If
   * a secret already exists for this (tenant,
   * kind), creates a new version and keeps the
   * prior version per the AWS retention policy.
   *
   * `kind` defaults to `'oidc-client-secret'` and
   * is typed as an open union so future kinds
   * (e.g. `'scim-bearer-token'`) can be added
   * non-breakingly.
   */
  async store(tenantId: TenantId, secretValue: string, kind?: SecretKind): Promise<SecretRef>;

  /**
   * Delete the secret. Used when the tenant
   * disconnects their IdP. Scheduled deletion with
   * a default 7-day recovery window.
   */
  async delete(tenantId: TenantId, kind?: SecretKind): Promise<void>;

  /**
   * Generate the canonical ARN-only SecretRef for
   * a tenant's secret without making a network
   * call. Used by Cognito IdP CRUD to reference
   * the secret. Equivalent to a `SecretRef` with
   * no version pin (resolves to `AWSCURRENT`).
   */
  refFor(tenantId: TenantId, kind?: SecretKind): SecretRef;
}

/**
 * Open string union. Known values get autocomplete;
 * unknown strings are accepted so future SCIM /
 * other kinds don't require an API bump.
 */
type SecretKind = "oidc-client-secret" | (string & {});
```

The `secretPrefix` prop is mandatory and namespaces the
consumer's secrets so multiple consumers in the same AWS account
don't collide. Recommended convention:
`/vestibulum/idp/{app-name}/{kind}/{tenantId}`, with `kind`
defaulting to `oidc-client-secret`. The kind segment leaves room
for additional secret kinds (e.g. `scim-bearer-token`) under the
same prefix without later restructuring.

**No consumer-facing `get` method.** Cognito stores the literal
client secret internally and does not dereference Secrets Manager
ARNs at runtime
([CreateIdentityProvider API ref](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateIdentityProvider.html)),
so the IdP managers must read the plaintext when they call
`CreateIdentityProvider` / `UpdateIdentityProvider`. That read is
encapsulated inside the manager methods — `IdpSecretsClient`
itself does not expose `get(...)` on its public surface. The
package-internal Secrets Manager client used by the managers is
not re-exported. Effect: an HTTP route handler in the consumer's
app that holds an `IdpSecretsClient` instance cannot accidentally
read tenant client secrets; only the explicit IdP-CRUD code path
can.

**Foundation delegation.** `IdpSecretsClient` is the
vestibulum-specific naming/CRUD facade. The underlying plaintext
resolution goes through foundation's `secrets` module
([`../04-shared-vocabulary.md § SecretRef`](../04-shared-vocabulary.md#secretref))
— `resolveSecret(ref: SecretRef): Promise<string>` — so the
caching, IAM-error handling, and retry policy are foundation's
and not duplicated here.

## Lambda templates

The two trigger Lambdas have ~80% identical plumbing across
consumers (event shape parsing, V1/V2/V3 normalisation, error
handling, claim response formatting). Vestibulum ships factory
functions that take a small consumer callback and return a
complete Lambda handler. Full mechanics — including how this
code reaches the deployed system via the
`@de-otio/vestibulum-cdk` bundling step — are in
[`04-cognito-triggers.md`](04-cognito-triggers.md).

### `createPreTokenGenerationHandler`

```typescript
function createPreTokenGenerationHandler(callbacks: {
  resolveClaims: ClaimResolver;
  onError?: (err: unknown, event: PreTokenGenEvent) => void;
}): PreTokenGenHandler;

type PreTokenGenHandler = (event: PreTokenGenEvent) => Promise<PreTokenGenEvent>;
```

The handler:

1. Normalises Cognito event V1 (id-token-only), V2 (id-token +
   access-token + group config), and V3 into a single shape. See
   [`04-cognito-triggers.md § Event version normalisation`](04-cognito-triggers.md#event-version-normalisation).
2. Calls `callbacks.resolveClaims(input)` with a normalised
   `ClaimResolverInput`.
3. Applies the returned claims via the appropriate
   `claimsOverrideDetails` / `claimsAndScopeOverrideDetails`
   shape for the event version.
4. Catches and rethrows after invoking `onError` (consumer can
   log to their observability stack; the handler still fails the
   token issuance, by design — silently issuing a token without
   tenant claims is worse than failing the login).

### `createPostConfirmationHandler`

```typescript
function createPostConfirmationHandler(callbacks: {
  provision: Provisioner;
  onError?: (err: unknown, event: PostConfEvent) => void;
}): PostConfHandler;
```

The handler:

1. Normalises the Cognito event.
2. Calls `callbacks.provision(input)` with a `ProvisionerInput`
   carrying user attributes, identity-provider identification
   (federated vs magic-link), and the `cognito:user_status`.
3. Always returns the event unmodified (post-confirmation
   triggers can't mutate the user).
4. If `provision` throws, the handler rethrows, which causes
   Cognito to roll back the user confirmation — provisioning
   failure surfaces to the user as a sign-up error rather than a
   silent half-created user.

**`onError` no-throw guarantee.** The optional `onError` callback
on both factories is invoked _before_ the rethrow, and any
exception it raises is caught and swallowed by the handler — a
throwing `onError` does not mask the original error and does not
prevent the rethrow. Consumers can use it freely for observability
(structured-log emission, Sentry capture) without paying defensive
try/catch cost themselves. See
[`./04-cognito-triggers.md § onError is for observability, not recovery`](./04-cognito-triggers.md#onerror-is-for-observability-not-recovery).

## JWT verification helpers

The two-pool topology described in
[`06-pool-topology.md`](06-pool-topology.md) makes the consumer's
API responsible for accepting tokens from multiple Cognito pools
and routing operations correctly. This is the smallest surface
where a bug becomes a tenant-isolation breach ("B2C token
accepted in a B2B-tenant operation"); the runtime ships two
helpers to make the safe pattern the easy path. Full design in
[`05-jwt-verification.md`](05-jwt-verification.md); the public
surface only is reproduced here.

### `createMultiPoolVerifier`

```typescript
interface PoolConfig {
  /**
   * Stable identifier the consumer assigns
   * (e.g. `'b2c'` or `'b2b'`). Returned in the
   * verified-token output so handlers can branch
   * on it. NOT the Cognito pool ID.
   */
  poolKey: string;
  userPoolId: string;
  clientId: string | string[]; // app client(s) issued from this pool
  region: string;
  tokenUse: "access" | "id" | null;
}

function createMultiPoolVerifier(pools: PoolConfig[]): MultiPoolVerifier;

interface MultiPoolVerifier {
  /**
   * Verify a token and return the verified claims
   * plus the originating pool key. Throws
   * `MultiPoolVerifierError` on any failure:
   * unknown issuer, signature mismatch, expired,
   * wrong client_id, etc.
   *
   * Pool selection: the `iss` claim of the token
   * is matched **exact-string** against the
   * canonical issuer URL of each configured pool
   * (`https://cognito-idp.{region}.amazonaws.com/{userPoolId}`).
   * No substring matching; no allowance for
   * trailing slashes or case variants. An unknown
   * `iss` is rejected before any signature work.
   */
  verify(token: string): Promise<VerifiedToken>;
}

interface VerifiedToken {
  poolKey: string; // from PoolConfig
  claims: Record<string, unknown>;
  rawToken: string;
}
```

Implementation: builds an internal `Map<iss, CognitoJwtVerifier>`
from the pool configs (`aws-jwt-verify` is the underlying
library — see [`05-jwt-verification.md`](05-jwt-verification.md)).
The `iss` claim is read **only after** signature verification
(decoding-before-verifying is a classic "decide-then-verify"
anti-pattern); the helper extracts the issuer from the JOSE
header or candidate-pool iteration rather than trusting an
unverified parse of the JWT body.

The helper deliberately does not accept a fallback verifier or
wildcard issuer. If the issuer isn't in the configured list, the
token is rejected — even if it would be signed by a valid (but
unconfigured) Cognito pool.

### `requirePool`

```typescript
function requirePool(token: VerifiedToken, expected: string | string[]): void;
```

Throws if `token.poolKey` is not in `expected`. Used at the
handler boundary so a B2C-issued token cannot reach a B2B-tenant
operation (or vice versa) by mistake.

```typescript
app.post("/tenants/:id/members", async (req, res) => {
  const token = await verifier.verify(req.bearerToken);
  requirePool(token, "b2b"); // tenant-admin op is B2B-only
  // ... rest of handler ...
});
```

This is one line per handler. Centralising the check via
middleware is preferred where the URL structure permits; the
helper exists so handler-level enforcement is also cheap and
obvious.

### `MultiPoolVerifierError`

```typescript
class MultiPoolVerifierError extends VestibulumRuntimeError {
  readonly reason:
    | "unknown_issuer"
    | "expired"
    | "invalid_signature"
    | "wrong_client_id"
    | "wrong_token_use"
    | "wrong_pool"
    | "malformed_token";
}
```

Consumers map this to 401 (or 403, depending on their
convention). The `reason` discriminant is suitable for
structured logs; do not surface the discriminant to end users
(it leaks information that helps attackers refine token-forgery
attempts).

The `wrong_pool` variant is what `requirePool` throws when a
verified token's `poolKey` is not in the expected set; the others
come from `verify`. Same class so consumers can map any auth
failure to a single 401/403 path while the `reason` discriminant
distinguishes the cause in logs.

## Callback shapes

The public contract between vestibulum's Lambdas and consumer
code. These two interfaces and their input/output types are the
most stable surface of vestibulum — breaking changes here are
disproportionately painful and are in the
[frozen-set](../04-shared-vocabulary.md#claimresolverinput-and-provisionerinput)
even though vestibulum (not foundation) mints them.

### Claim resolver callback

The `ClaimResolverInput` and `ClaimResolverOutput` types reproduced
here are part of the cross-package
[frozen set](../04-shared-vocabulary.md#claimresolverinput-and-provisionerinput);
the canonical definition lives in
`packages/vestibulum/src/types/frozen/callbacks.ts` and is mirrored
verbatim in [`../04-shared-vocabulary.md`](../04-shared-vocabulary.md).
The list of `KnownClaimTriggerSource` values is defined there;
this doc references the list rather than redefining it (changes
to that list require an RFC).

```typescript
import type { TenantId } from "@de-otio/saas-foundation";
import type { KnownClaimTriggerSource } from "@de-otio/vestibulum";

type ClaimResolver = (input: ClaimResolverInput) => Promise<ClaimResolverOutput>;

interface ClaimResolverInput {
  /** Cognito user sub. Stable across logins. */
  readonly userSub: string;

  /** User attributes from the Cognito event. */
  readonly userAttributes: Readonly<Record<string, string>>;

  /** App client that initiated the token request. */
  readonly clientId: string;

  /**
   * Trigger source. Open-union sentinel pattern: the
   * known values give autocomplete; an unknown value
   * (e.g. a Cognito-side addition or a future SCIM
   * trigger) is still assignable as a plain string
   * without an API bump. Consumers branch on known
   * values and treat unknown sources defensively.
   * Known set lives in
   * [`../04-shared-vocabulary.md`](../04-shared-vocabulary.md#claimresolverinput-and-provisionerinput).
   */
  readonly triggerSource: KnownClaimTriggerSource | (string & {});

  /**
   * Identity provider info. For federation tokens,
   * `kind: 'federated'` and `providerName` is the
   * Cognito IdP name (e.g. 'tenant-xxx'). For
   * magic-link or native Cognito, `kind: 'cognito'`.
   *
   * **Reverse mapping.** `identity.providerName` is
   * the Cognito IdP name. The consumer's
   * `TenantIdentityProvider` table is the source of
   * truth for the `cognitoIdpName → TenantId` reverse
   * mapping; vestibulum does not provide this lookup.
   * Consumers typically resolve the tenant inside the
   * `resolveClaims` callback by querying their own
   * table on `cognitoIdpName`.
   */
  readonly identity:
    | { kind: "cognito" }
    | { kind: "federated"; providerName: string; providerType: "OIDC" | "SAML" };

  /**
   * Federated group claims, if the identity
   * provider supplied them via attribute mapping.
   * Empty array for non-federated flows.
   */
  readonly federatedGroups: readonly string[];

  /**
   * Whether this is a refresh-token issuance
   * versus a fresh authentication. Refresh flows
   * skip some claim-resolution steps in most
   * consumers.
   */
  readonly isRefresh: boolean;

  /**
   * Caller-supplied metadata from
   * `AdminRespondToAuthChallenge` /
   * `RespondToAuthChallenge`. **Untrusted:**
   * Cognito passes this through from the client
   * without validation, so it MUST NOT be used for
   * authorization decisions. Renamed from
   * `clientMetadata` to make the trust boundary
   * visible at the type level. Cognito does NOT
   * propagate `clientMetadata` from `InitiateAuth` /
   * `AdminInitiateAuth`, so federation flows
   * typically see it empty. Surfaced so consumers
   * can opt into using it (for non-security-sensitive
   * routing hints — UI theme, locale) with eyes open.
   * Full discussion in
   * [`./04-cognito-triggers.md § Untrusted client metadata`](./04-cognito-triggers.md#untrusted-client-metadata).
   */
  readonly untrustedClientMetadata: Readonly<Record<string, string>>;
}

interface ClaimResolverOutput {
  /**
   * Claims to add/override.
   *
   * The following claims are reserved and raise
   * ReservedClaimError if included here, per
   * Cognito's pre-token-generation claims
   * reference:
   *
   *   iss, sub, aud, exp, iat, nbf, jti, nonce,
   *   origin_jti, token_use, auth_time, at_hash,
   *   acr, amr, azp, client_id, event_id,
   *   device_key, version, identities,
   *   cognito:username
   *
   * Group-related claims (cognito:groups,
   * cognito:preferred_role, cognito:roles) are
   * NOT in claimsToAddOrOverride — Cognito
   * exposes a dedicated `groupsToOverride` /
   * `iamRolesToOverride` / `preferredRole`
   * surface for those, accessed via this output
   * shape's `groupsToOverride` field below.
   *
   * Use the `custom:` prefix for app-specific
   * claims. The full reserved list is exported as
   * RESERVED_CLAIMS from the package index for
   * programmatic inspection — see § RESERVED_CLAIMS
   * below for its stability story.
   *
   * See [Cognito claims and scopes reference](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-pre-token-generation.html).
   */
  readonly claimsToAddOrOverride?: Readonly<
    Record<string, string | number | boolean | readonly string[]>
  >;

  /**
   * Claims to suppress from the issued tokens.
   * Available on V1 (ID token) and V2/V3 (ID and
   * access token).
   */
  readonly claimsToSuppress?: readonly string[];

  /**
   * Group-claim override. Replaces the user's
   * `cognito:groups` claim (and, where
   * applicable, `cognito:preferred_role` and
   * `cognito:roles`). Available on all event
   * versions; passed through to Cognito's
   * `groupOverrideDetails.groupsToOverride`.
   */
  readonly groupsToOverride?: readonly string[];

  /**
   * Scopes to add to the access token's `scope`
   * claim. **V2/V3 events only** (requires
   * Cognito Essentials or Plus feature plan).
   * Silently ignored on V1.
   */
  readonly scopesToAdd?: readonly string[];

  /**
   * Scopes to suppress from the access token's
   * `scope` claim. **V2/V3 events only**.
   */
  readonly scopesToSuppress?: readonly string[];
}
```

`ClaimResolverOutput` is in the
[frozen set](../04-shared-vocabulary.md#claimresolverinput-and-provisionerinput)
alongside the inputs: deployed Lambdas receive output from
consumer callbacks, and a silent shape change at this boundary
silently breaks deployed code at the first post-deploy login. The
canonical definition lives in
`packages/vestibulum/src/types/frozen/callbacks.ts`.

### `RESERVED_CLAIMS`

```typescript
export const RESERVED_CLAIMS: ReadonlySet<string>;
```

The reserved-claim set tracks Cognito's documented claim namespace
([pre-token-generation claims reference](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-pre-token-generation.html))
and may grow without a vestibulum MINOR bump — Cognito occasionally
adds new internal claims (recent example: `origin_jti`) and
vestibulum mirrors AWS's documentation as soon as the change is
known. Consumers must use `RESERVED_CLAIMS.has(claimName)` to
check membership; hardcoding the list at the call site means a
client-side admin UI accepts a claim name that the runtime then
rejects with `ReservedClaimError`.

**Pluggable, not standardised.** Vestibulum does not prescribe
claim names. A consumer is free to emit `custom:tenant_id`,
`custom:org`, `custom:workspace`, or no tenant claim at all. The
only constraint is the reserved set above.

The `identity` discriminator lets a consumer distinguish
federated from native logins without parsing the `identities`
claim themselves.

### Provisioner callback

```typescript
import type { KnownProvisionerSource } from "@de-otio/vestibulum";

type Provisioner = (input: ProvisionerInput) => Promise<void>;

interface ProvisionerInput {
  readonly userSub: string;
  readonly userAttributes: Readonly<Record<string, string>>;
  readonly clientId: string;

  /**
   * Trigger source. Open-union sentinel pattern;
   * the `KnownProvisionerSource` set
   * (`PostConfirmation_ConfirmSignUp`,
   * `PostConfirmation_ConfirmForgotPassword`) lives
   * in
   * [`../04-shared-vocabulary.md`](../04-shared-vocabulary.md#claimresolverinput-and-provisionerinput).
   * Future provisioning paths (notably SCIM —
   * `'SCIM_Create' | 'SCIM_Update' |
   * 'SCIM_Deactivate'`) can fire the same callback
   * without a breaking change. Consumers should
   * branch on known values and treat unknown
   * sources defensively. See
   * [`07-scim-forward-compat.md`](07-scim-forward-compat.md).
   */
  readonly triggerSource: KnownProvisionerSource | (string & {});

  /**
   * Same shape as ClaimResolverInput.identity.
   *
   * **Reverse mapping.** `identity.providerName` is
   * the Cognito IdP name. The consumer's
   * `TenantIdentityProvider` table is the source of
   * truth for the `cognitoIdpName → TenantId`
   * reverse mapping; vestibulum does not provide
   * this lookup. Consumers typically resolve the
   * tenant inside the `provision` callback by
   * querying their own table on `cognitoIdpName`.
   */
  readonly identity:
    | { kind: "cognito" }
    | { kind: "federated"; providerName: string; providerType: "OIDC" | "SAML" };
}
```

The provisioner is invoked exactly once per user per confirmation
event. For federated logins, this fires on first sign-in (when
Cognito JIT-creates the user account from the federated
identity). Subsequent sign-ins by the same user do not re-trigger
it.

### Frozen-set status

`ClaimResolverInput`, `ClaimResolverOutput`, and `ProvisionerInput`
are part of the cross-package frozen set even though vestibulum
(not foundation) defines them. Canonical definitions live in
`packages/vestibulum/src/types/frozen/callbacks.ts`; rationale and
RFC process:
[`../04-shared-vocabulary.md § ClaimResolverInput and ProvisionerInput`](../04-shared-vocabulary.md#claimresolverinput-and-provisionerinput).

## Error type hierarchy

```typescript
class VestibulumRuntimeError extends Error {
  readonly code: string;
}

class OidcProbeError extends VestibulumRuntimeError {
  readonly reason:
    | "unreachable"
    | "timeout"
    | "invalid_json"
    | "issuer_mismatch"
    | "unsupported_alg"
    | "too_large"
    | "not_https"
    | "ssrf_blocked_destination"
    | "unsupported_auth_method"
    | "redirect_blocked"
    | "url_too_long"
    | "url_has_credentials";
}

class SamlMetadataError extends VestibulumRuntimeError {
  readonly reason:
    | "invalid_xml"
    | "unsigned"
    | "expired"
    | "unsupported_binding"
    | "no_signing_cert"
    | "too_large"
    | "ssrf_blocked_destination"
    | "redirect_blocked"
    | "unreachable";
}

class IdpManagerError extends VestibulumRuntimeError {
  readonly reason:
    | "name_too_long"
    | "name_collision"
    | "cognito_quota"
    | "concurrent_modification"
    | "not_found"
    | "idp_identifier_invalid";
}

class ReservedClaimError extends VestibulumRuntimeError {
  readonly claimName: string;
}
```

Consumers should catch the base class and discriminate on `code`
/ `reason`. Concrete classes are exported so admin UIs can
produce specific error messages.

The base class is `VestibulumRuntimeError`. All five subclasses
(`OidcProbeError`, `SamlMetadataError`, `IdpManagerError`,
`ReservedClaimError`, `MultiPoolVerifierError`) extend it, and it
is the type to catch when discriminating on `code` / `reason`.

## Cognito-side limits surfaced as typed errors

The managers validate input against Cognito-documented limits
before issuing SDK calls, so consumers see typed errors rather
than Cognito 400 responses with opaque messages.

- **`ProviderName`**: 32 chars max, regex
  `[^_\p{Z}][\p{L}\p{M}\p{S}\p{N}\p{P}][^_\p{Z}]+`. Enforced by
  `idp-name.ts` normalisation.
- **`IdpIdentifiers`**: ≤50 items per IdP, each 1–40 chars,
  regex `[\w\s+=.@-]+`. Enforced in `OidcIdpManager.upsert` /
  `SamlIdpManager.upsert`; violation raises
  `IdpManagerError(reason: 'idp_identifier_invalid')`.
- **`AttributeMapping` key**: 1–32 chars (Cognito attribute
  name). Custom attribute names are capped at 20 chars after the
  `custom:` prefix.
- **`AttributeMapping` value**: 0–131072 chars (IdP claim name).
- **Federated identities per Cognito user**: ≤5
  ([AdminLinkProviderForUser API ref](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminLinkProviderForUser.html)).
  Relevant to the SCIM forward-compatibility hook (see
  [`07-scim-forward-compat.md`](07-scim-forward-compat.md)) — a
  user federating from more than 5 IdPs into one Cognito sub
  will hit this cap on the 6th link.
- **Custom attributes per pool**: ≤50 (Cognito hard limit). The
  CDK `FederationCustomAttributesAspect` (lives in
  `@de-otio/vestibulum-cdk`) warns at >10.

## IdP record extensibility

`OidcIdpRecord` and `SamlIdpRecord` are designed to grow.
Optional additive fields — for example future SCIM-related state
like `scimEnabled`, `scimEndpointPath`,
`scimTokenSecret: SecretRef`, `lastScimSyncAt` — are explicitly
non-breaking additions. Note `scimTokenSecret` uses the same
`SecretRef` discipline as `OidcIdpRecord.clientSecret` rather
than a flat ARN string, so the same rotation / pinning story
applies. Consumers should destructure known fields rather than
assume either record shape is closed. See
[`07-scim-forward-compat.md`](07-scim-forward-compat.md).

## What's deliberately not in the API

- **No `OidcManager.list(...)` returning every IdP on the pool.**
  Pool-wide IdP enumeration is a consumer-side concern (the
  consumer has its own `TenantIdentityProvider` table; the
  source of truth is that table, not Cognito).
- **No webhook / event-bus emitter on IdP changes.** Consumers
  wire their own events; vestibulum's scope ends at returning
  the result of the SDK call.
- **No "test this IdP config" function.** Cognito itself does
  not provide a synthetic test endpoint; the only real test is
  "an admin actually signs in". Surfacing a fake function would
  mislead.
- **No automatic secret rotation.** `IdpSecretsClient.store`
  overwrites with a new version; consumers schedule rotation
  via their own cron / Lambda. Vestibulum could ship a
  scheduled-rotation construct later (in
  `@de-otio/vestibulum-cdk`).
- **No retry / backoff on Cognito calls.** The SDK has its own
  retry policy. Wrapping it would conceal real errors.
  Consumers can wrap calls themselves; per foundation's "Don't
  reinvent OSS" principle
  ([`../01-scope-and-philosophy.md`](../01-scope-and-philosophy.md#design-principles)),
  consumer-side retry policy uses `cockatiel` or equivalent
  directly.
- **No generic identity-provider abstraction.** v0.x is
  Cognito-shaped. Non-Cognito backends (WorkOS, Auth0
  cloud-side, Keycloak) are forward-compatibility hedges only
  ([`../01-scope-and-philosophy.md § Forward compatibility`](../01-scope-and-philosophy.md#forward-compatibility)),
  not designed-around today.

## Status

Implemented. The IdP-manager and Lambda-template surfaces described
here are built in `packages/vestibulum/`. The callback signatures
(`ClaimResolverInput`, `ProvisionerInput`) are the most likely to
change pre-1.0 — they will be exercised against the first consumer
(trellis; [`../08-trellis-migration.md`](../08-trellis-migration.md))
and may grow fields as that work surfaces gaps. This doc is being
reconciled with the landed exports; where they disagree, the code is
authoritative.

## Open questions

Carried forward from the standalone-repo design and adjusted for
the monorepo context:

- **Should the claim resolver receive prior claims** (what
  Cognito would have emitted without the trigger) so the
  consumer can build on top rather than replace? No current
  consumer needs this; deferred unless a consumer asks.
- **Should `OidcIdpManager.upsert` return a richer
  `OidcIdpRecord`** including the issuer metadata fetched at
  create time? Currently returns what Cognito stores. Probably
  yes for observability; tracked for impl pass.
- **Audit-event emission.** Foundation's `AuditEvent` is in the
  frozen set; vestibulum is the natural emitter for
  `idp.create`, `idp.update`, `idp.delete`,
  `auth.federated_link`. Should the IdP managers take an
  optional audit-sink in the constructor, or should the
  consumer wrap each call? Lean toward optional sink — but
  decide alongside the foundation `audit` module design.
- **`RequestContext` propagation into the manager methods.**
  IdP CRUD usually runs inside an admin HTTP handler that has a
  `RequestContext` on `AsyncLocalStorage`. The manager should
  log with the request-id correlation foundation's logger
  provides; this happens automatically if the manager uses
  foundation's logger (which reads ALS) rather than a
  constructor-injected one. Confirm during impl.
- **Subpath exports for Lambda bundling.** Currently the
  bundling step (`@de-otio/vestibulum-cdk`'s
  `build-bundles.ts`) reaches into specific source files. A
  cleaner design exports named bundle-target paths
  (`@de-otio/vestibulum/lambda/pre-token`,
  `@de-otio/vestibulum/lambda/post-confirmation`). Decide
  alongside the exports map; cross-reference
  [`../03-package-relationships.md § Open questions`](../03-package-relationships.md#open-questions).
- **Switch the issuer-probe IPv4/IPv6 deny-list to an audited
  library?** The inline CIDR list under § Issuer probe is
  correct as of the current RFC reservations but maintaining it
  in-tree means each new IETF assignment is a vestibulum patch.
  Candidates: `ip-cidr` + `is-cidr` (both small, both audited,
  the union covers IPv4/IPv6 lookup against named reserved sets).
  Net: less code in vestibulum, one more transitive dep, and a
  fewer ways to get the list wrong on subsequent edits. Tracked
  for the impl pass.
