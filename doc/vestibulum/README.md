# `@de-otio/vestibulum` — identity runtime

The entrance hall. Cognito-shaped identity-runtime primitives:
multi-tenant OIDC + SAML federation against Cognito user pools,
multi-pool JWT verification, Cognito Lambda trigger templates, OIDC
issuer probe with SSRF defence, SAML metadata parser.

Sits on top of `@de-otio/saas-foundation` (peer-dep, see
[`../03-package-relationships.md`](../03-package-relationships.md));
gets bundled into `@de-otio/vestibulum-cdk`'s Lambda functions at
publish time (build-time only, no runtime npm edge).

## What this folder covers

Numbered notes mirror vestibulum's standalone-repo layout where the
content survives unchanged; renumbered where the saas-foundation
context reshapes the doc set.

- [`01-package-api.md`](01-package-api.md) — exports surface. IdP
  managers (OIDC + SAML), issuer probe, secrets handling, Lambda
  trigger templates, JWT verification helpers, callback shapes,
  error hierarchy. The public contract.
- [`02-oidc-flows.md`](02-oidc-flows.md) — OIDC specifics. Discovery
  protocol, per-provider profiles (Entra / Okta / Auth0 / Google
  Workspace), client-secret lifecycle, rotation, the Cognito
  configuration shape produced by `OidcIdpManager`.
- [`03-saml-flows.md`](03-saml-flows.md) — SAML 2.0 specifics.
  Metadata parsing (XML, signature verification, XXE defence),
  per-provider profiles (Entra / ADFS / Okta SAML / Shibboleth),
  signing-cert rotation, SP-metadata generation.
- [`04-cognito-triggers.md`](04-cognito-triggers.md) — pre-token-
  generation and post-confirmation Lambda templates. Event V1 / V2
  / V3 normalisation, the bundling story (how this code reaches
  the deployed system via `@de-otio/vestibulum-cdk`), error
  discipline.
- [`05-jwt-verification.md`](05-jwt-verification.md) — multi-pool
  verifier and `requirePool` helper. Pool-config shape, exact-iss
  matching, no-decode-before-verify, integration with foundation's
  `RequestContext`.
- [`06-pool-topology.md`](06-pool-topology.md) — B2C / B2B pool
  separation. Why two pools beat one when tier choice matters; the
  consumer-side schema implications; alternative analysed and
  recorded.
- [`07-scim-forward-compat.md`](07-scim-forward-compat.md) — what
  SCIM 2.0 inbound support would add later, the IdP-record
  extensibility story, the `scim/` reserved subdirectory, the
  Cognito 5-IdP-per-user cap and account-linking interaction.
- [`08-shared-pool-multi-tenancy.md`](08-shared-pool-multi-tenancy.md)
  — serving many tenants from a single shared Cognito pool, per-tenant
  claim scoping, and the prototype that motivated shared-distribution.

The [`shared-distribution/`](shared-distribution/) sub-design covers the
implemented shared-CloudFront + shared-Cognito-pool topology (pure-data
tenant onboarding, multi-`aud` edge check, wildcard infra, admin Lambda,
reconciler). Start with its
[`README.md`](shared-distribution/README.md).

## Architecture

vestibulum is one of four published packages in the saas-foundation
monorepo. The other three:

- `@de-otio/saas-foundation` — runtime core. Vestibulum depends on
  it for secrets resolution, structured logging, tenant context,
  audit-event emission, and the frozen-set types (`TenantId`,
  `AuditEvent`, `RequestContext`, `SecretRef`).
- `@de-otio/saas-foundation-cdk` — CDK constructs for the foundation
  runtime (dashboards, alarms, Lambda/Prisma helpers).
- `@de-otio/vestibulum-cdk` — CDK constructs. Imports vestibulum's
  Lambda handler factories at _build_ time only, bundles them into
  the published artifact as `lambda.Code.fromAsset(...)`. No
  runtime npm edge from CDK to vestibulum.

See [`../03-package-relationships.md`](../03-package-relationships.md)
for the dependency graph and bundling mechanics; see
[`../04-shared-vocabulary.md`](../04-shared-vocabulary.md) for the
frozen-set types.

### What vestibulum owns

The five concern areas, expanded in `01-package-api.md`:

1. **IdP managers**. `OidcIdpManager` and `SamlIdpManager` wrap the
   Cognito SDK calls (`CreateIdentityProviderCommand`,
   `UpdateIdentityProviderCommand`, `DeleteIdentityProviderCommand`,
   `DescribeIdentityProviderCommand`, `ListIdentityProvidersCommand`)
   plus the app-client `SupportedIdentityProviders` mutation. They
   enforce the `tenant-{id}` IdP naming convention and the 32-char
   Cognito limit.
2. **Issuer probe**. `probeOidcIssuer(issuerUrl)` fetches
   `.well-known/openid-configuration`, validates it, and returns
   parsed metadata. Includes SSRF defence with DNS-rebinding TOCTOU
   mitigation via pinned-IP `undici.Agent`. The reference
   implementation for any foundation-level HTTP fetcher.
3. **Secrets handling**. `IdpSecretsClient` namespaces OIDC client
   secrets and any future kinds (`scim-bearer-token`, etc.) in
   Secrets Manager. The internal read path is encapsulated inside
   the IdP managers; no consumer-facing `get`.
4. **Lambda templates**. `createPreTokenGenerationHandler` and
   `createPostConfirmationHandler` are factory functions returning
   complete Lambda handlers; the consumer supplies callbacks
   (`ClaimResolver`, `Provisioner`) for business logic.
5. **JWT verification**. `createMultiPoolVerifier` and `requirePool`
   make the safe pattern the easy path for multi-pool deployments.

### What vestibulum does not own

- An HTTP framework, router, or middleware. Consumers wire their own
  (`hono`, `express`, etc.); vestibulum exports plain functions.
- The consumer's tenant data model (`Tenant`, `TenantMember`,
  `TenantIdentityProvider` tables). Vestibulum returns the Cognito
  IdP name; the consumer stores the `{tenantId → cognitoIdpName}`
  mapping themselves.
- Authorisation / RBAC. Vestibulum sets claims via the consumer's
  `ClaimResolver`; what those claims _mean_ is the consumer's
  decision.
- Account linking via `AdminLinkProviderForUser`. Reserved for the
  SCIM extension; see [`07-scim-forward-compat.md`](07-scim-forward-compat.md).
- Infrastructure-as-code. CDK constructs live in
  `@de-otio/vestibulum-cdk`; vestibulum has no `aws-cdk-lib`
  import.

### Cognito-shaped, by design

v0.x targets Cognito specifically. The package surface does **not**
abstract over IdP backends. Doors are left open for non-Cognito
backends (WorkOS, Auth0 cloud-side, Keycloak) via open-union types
on `identity.providerType`, `triggerSource`, and `SecretKind` — but
there is no generic provider-abstraction layer in v0.x, and adding
one is future work, not "designed-around" today.

### Re-exports from foundation

The four frozen-set types vestibulum consumes are re-exported from
the package root so consumers have a single import surface; the
three vestibulum-minted frozen types
(`ClaimResolverInput`, `ClaimResolverOutput`, `ProvisionerInput`)
live alongside them under `src/types/frozen/callbacks.ts`:

```typescript
// packages/vestibulum/src/index.ts
export type { TenantId, AuditEvent, RequestContext, SecretRef } from "@de-otio/saas-foundation";

export type {
  ClaimResolverInput,
  ClaimResolverOutput,
  ProvisionerInput,
} from "./types/frozen/callbacks.js";
```

A consumer using vestibulum imports `TenantId` from
`@de-otio/vestibulum` without knowing or caring that foundation
defined it. The re-export is the _only_ duplication — types are
never re-defined, because two definitions create two distinct
identities and the type checker loses its ability to catch shape
mismatches. See [`../04-shared-vocabulary.md`](../04-shared-vocabulary.md).

The `types/frozen/` directory is the path the CI fanout gate
watches per
[`../05-versioning-and-releases.md`](../05-versioning-and-releases.md).
Changes to any file under it require a coordinated frozen-set
RFC; logic (validators, factories, AsyncLocalStorage plumbing)
lives outside that directory and changes PATCH-level.

## Coexistence: magic-link + federation on one pool

Federation does not replace magic-link; both can coexist on a single
Cognito user pool. The CDK constructs in
`@de-otio/vestibulum-cdk` configure the pool and app clients
accordingly; vestibulum's runtime helpers are agnostic to which flow
issued the token (the `ClaimResolverInput.identity` discriminator
distinguishes federated from native at claim-resolution time).

Per [`06-pool-topology.md`](06-pool-topology.md), the recommended
default is **separate pools** for B2C vs B2B when feature-tier
economics matter; the runtime API supports either shape.

## Security properties relied on across this folder

A consolidated audit checklist; each linked to the file that owns
the detail.

1. **OIDC client secret never leaves the manager call stack.** No
   consumer-facing `get`. See
   [`01-package-api.md § Secrets handling`](01-package-api.md#secrets-handling)
   and [`02-oidc-flows.md § Client-secret handling`](02-oidc-flows.md#client-secret-handling).
2. **SSRF guards on admin-controlled URLs.** `probeOidcIssuer` and
   `parseSamlMetadata` refuse private, link-local, and IMDS
   destinations _before_ connecting; the connect step is pinned to
   the validated IP via `undici.Agent` to defeat DNS-rebinding
   TOCTOU. See [`01-package-api.md § Issuer probe`](01-package-api.md#issuer-probe)
   and [`03-saml-flows.md § Metadata parsing`](03-saml-flows.md#metadata-parsing).
3. **SAML metadata rejected by default if unsigned.** Pasted XML is
   the trust anchor; phishing an admin into pasting hostile metadata
   is realistic. `acceptUnsignedMetadata: true` is the explicit
   opt-out. See [`03-saml-flows.md § Trust on paste`](03-saml-flows.md#trust-on-paste-default-reject-unsigned).
4. **XML library version pins are security-critical.** `xml-crypto`
   ≥ 6.0.0 and `@xmldom/xmldom` ≥ 0.8.10. CI fails on downgrade.
5. **No decode-before-verify in the JWT verifier.** The multi-pool
   verifier decodes the unverified `iss` claim directly from the
   base64url-decoded JWT payload (the JWT body), purely to select
   which configured pool's verifier to run. Trust is only established
   after the selected pool's verifier successfully validates the
   signature, expiry, and audience — the unverified `iss` never
   influences any trust decision. See
   [`05-jwt-verification.md`](05-jwt-verification.md).
6. **Reserved-claims list is explicit.** The pre-token-generation
   Lambda template refuses to override Cognito's read-only claims
   (`iss`, `sub`, `aud`, etc.); `identities` overriding would be a
   federation-spoofing vector. See [`04-cognito-triggers.md`](04-cognito-triggers.md).
7. **JIT provisioning failure is loud, not silent.** The
   post-confirmation Lambda rethrows on consumer-callback failure;
   Cognito rolls back the user confirmation. Half-created users are
   worse than failed sign-ups. See [`04-cognito-triggers.md`](04-cognito-triggers.md).
8. **Refresh-token TTL outlives the IdP session.** When a user is
   offboarded at the upstream IdP, Cognito's refresh token remains
   valid until its own TTL expires (default 30 days). For B2B
   federation, shorter refresh-token TTL on federation app clients
   (24h recommended) is the mitigation today; the SCIM-future
   `Deactivate` path will call `AdminUserGlobalSignOut`. See
   [`07-scim-forward-compat.md`](07-scim-forward-compat.md).

## Library choices (no in-house reimplementations)

Per saas-foundation's "Don't reinvent OSS" principle
([`../01-scope-and-philosophy.md`](../01-scope-and-philosophy.md#design-principles)):

- **JWT verification**: `aws-jwt-verify`. The multi-pool verifier
  wraps it; it does not reimplement signature checking.
- **SAML XML signing**: `xml-crypto` ≥ 6.0.0 (signature-wrapping
  CVEs).
- **XML parsing**: `@xmldom/xmldom` ≥ 0.8.10 (prototype-pollution
  CVEs).
- **HTTP dispatcher pinning** (SSRF defence): `undici.Agent` with
  custom `lookup`. Pinning is custom code, not a library, but
  built on undici's documented dispatcher API rather than a
  hand-rolled HTTP client.

## Versioning

Pre-1.0. Per [`../05-versioning-and-releases.md`](../05-versioning-and-releases.md),
independent versioning, not lockstep with foundation or
vestibulum-cdk. Breaking changes are normal at 0.x. The four planned
internal consumers get patched in one PR sweep when a frozen-set
type changes.

v1.0 across all four packages when:

- At least two non-trellis consumers have integrated successfully.
- The OIDC and SAML paths have both been exercised end-to-end in
  production deployments.
- One rename pass has happened on the runtime API.

## Status

Implemented. The concern areas above are built and tested in
`packages/vestibulum/`, including the shared-distribution feature (see
[`shared-distribution/`](shared-distribution/)). Per-doc open questions
are recorded at the foot of each file. The most likely v0.x churn is in
the callback signatures (`ClaimResolverInput`, `ProvisionerInput`),
which may grow fields as real consumers exercise them.

For the trellis-side integration path see
[`../08-trellis-migration.md`](../08-trellis-migration.md); for the
fold-in plan from the standalone vestibulum repo see
[`../07-vestibulum-migration.md`](../07-vestibulum-migration.md).
