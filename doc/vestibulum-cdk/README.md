# `@de-otio/vestibulum-cdk` — design

The opinionated CDK construct shape for one deployment topology:

- private static or low-traffic web origin,
- magic-link passwordless auth on Cognito `CUSTOM_AUTH`,
- CloudFront edge auth via Lambda@Edge JWT verify,
- EU-residency-friendly data plane,
- AWS-native (no third-party identity provider).

This is the _built_ form of the vestibulum entrance hall. The runtime
pieces (Cognito Lambda trigger templates, JWT verifier, IdP managers)
live in [`@de-otio/vestibulum`](../vestibulum/) — this package
**bundles** them as Lambda code and ships the deployment topology
around them. See [`02-monorepo-layout.md § Bundling vestibulum Lambda
code into vestibulum-cdk`](../02-monorepo-layout.md#bundling-vestibulum-lambda-code-into-vestibulum-cdk)
and [`03-package-relationships.md § The bundling relationship in
detail`](../03-package-relationships.md#the-bundling-relationship-in-detail)
for the cross-package mechanics.

## Opinionated by design

This package is the home of one topology. Per
[`01-scope-and-philosophy.md § @de-otio/vestibulum-cdk`](../01-scope-and-philosophy.md#de-otiovestibulum-cdk--the-entrance-hall-built):

> Out: every other CDK topology. If a second opinionated topology
> arrives later (say, OIDC-fronted SSR site, or B2B-only SAML
> integration), it goes in a separate construct package rather than
> generalising this one.

The implications:

- No abstraction over "auth method" or "edge function". The package
  ships magic-link on `CUSTOM_AUTH` with Lambda@Edge JWT verify,
  full stop. A consumer who wants different auth installs a
  different package (or none).
- Five mandatory mitigations (see below) are enforced in code via
  synth-time Aspects and IAM-shape invariants, not left as caller
  homework.
- The peer-dependency surface is exactly `aws-cdk-lib ^2.x` and
  `constructs ^10.x`. The bundled Lambda code carries its own
  closed transitive deps.

If you find yourself reaching for a new prop that opens up another
topology, stop and revisit
[`01-scope-and-philosophy.md`](../01-scope-and-philosophy.md) before
writing the prop.

## Contents

Numbered design notes, read in order:

- [`01-package-api.md`](01-package-api.md) — the construct surface:
  what the package exports, three primary constructs (`EdgeResources`,
  `MagicLinkIdentity`, `MagicLinkAuthSite`), configuration props, the
  five mandatory mitigations baked in.
- [`02-magic-link-identity.md`](02-magic-link-identity.md) —
  `MagicLinkIdentity` deep design: Cognito pool, `CUSTOM_AUTH` triggers,
  DynamoDB tables, SES + DKIM + DMARC, bounce-handler circuit breaker.
- [`03-edge-resources.md`](03-edge-resources.md) — `EdgeResources`
  deep design: the us-east-1 ACM cert and WAFv2 Web ACL, the
  Lambda@Edge constraint that forces them there, the default WAF
  rule set.
- [`04-magic-link-auth-site.md`](04-magic-link-auth-site.md) —
  `MagicLinkAuthSite` deep design: CloudFront, Lambda@Edge JWT
  verifier, Function URLs gated by OAC, login-page S3 + deployment,
  response-headers policy.
- [`05-app-clients.md`](05-app-clients.md) — adding Cognito app
  clients via `MagicLinkIdentity.addAppClient`; the token-TTL
  hierarchy.
- [`06-trigger-hooks.md`](06-trigger-hooks.md) — extension hooks for
  consumer-supplied `preTokenGeneration` and `postConfirmation`
  Lambdas; the trust model.
- [`07-cdk-changes-from-trellis.md`](07-cdk-changes-from-trellis.md) —
  the federation-related CDK changes (custom attributes, Hosted UI
  domain, `featureTier`, the modified `DisabledAuthFlowsAspect`) that
  vestibulum-cdk absorbs from the work originally done in trellis.
- [`08-metrics.md`](08-metrics.md) — the `metrics` namespace exposed
  by `MagicLinkIdentity` and `MagicLinkAuthSite`; recommended alarms.
- [`09-operational-notes.md`](09-operational-notes.md) — operational
  patterns that aren't part of the construct API but matter for safe
  operation: DKIM drift detection, Quartz-friendly CSP guidance, the
  `customAttributes` / login-page coupling, the
  bearer-token-CloudFront pattern flagged as a future construct
  candidate.
- [`10-lambda-bundle-pipeline.md`](10-lambda-bundle-pipeline.md) — the
  build-time pipeline that bundles vestibulum runtime into Lambda
  artifacts shipped with this package: deterministic esbuild, the
  hash manifest, the CI verification gate, what changes vs what's
  inherited from the top-level monorepo docs.

## File-allocation notes

`vestibulum-cdk`'s docs absorb three of the four top-level docs from
the standalone `vestibulum` repo. The split:

| Source (standalone vestibulum)                                                                  | Destination (saas-foundation)                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doc/01-package-design.md`                                                                      | [`01-package-api.md`](01-package-api.md) (adapted)                                                                                                                                                                                      |
| `doc/02-packaging-and-distribution.md`                                                          | mostly subsumed by `../02-monorepo-layout.md` and `../05-versioning-and-releases.md`; CDK-specific bits (Lambda bundle pipeline, hash manifest, CFn asset shape) land in [`10-lambda-bundle-pipeline.md`](10-lambda-bundle-pipeline.md) |
| `doc/03-trigger-hooks.md`                                                                       | [`06-trigger-hooks.md`](06-trigger-hooks.md) (transplant)                                                                                                                                                                               |
| `doc/04-app-clients.md` + federation app-client section from `doc/federation/05-cdk-changes.md` | [`05-app-clients.md`](05-app-clients.md) (**merge of two sources** — basic prop shape + federation-aware variant in one place)                                                                                                          |
| `doc/05-metrics.md`                                                                             | [`08-metrics.md`](08-metrics.md) (transplant, CDK-specific)                                                                                                                                                                             |
| `doc/06-operational-notes.md`                                                                   | CDK-specific bits → [`09-operational-notes.md`](09-operational-notes.md); deployment topology and runbook concerns defer to `../06-deployment-topology.md`                                                                              |
| `doc/federation/05-cdk-changes.md`                                                              | [`07-cdk-changes-from-trellis.md`](07-cdk-changes-from-trellis.md) (transplant — federation-aware app-client variant merged into `05-app-clients.md`)                                                                                   |

The "deep design" files (`02-magic-link-identity.md`,
`03-edge-resources.md`, `04-magic-link-auth-site.md`) are new — the
standalone-repo design notes folded everything into
`01-package-design.md`. The monorepo split lets each construct have
its own design page sized to the surface area (the Cognito pool
deserves more depth than `EdgeResources`, and intermixing them in
one file was already creaking).

## Construct shape at a glance

Three L3 constructs, deliberately separate lifecycle concerns:

| Construct           | Resources                                                | Stack (typical) | Region            | Lifecycle  |
| ------------------- | -------------------------------------------------------- | --------------- | ----------------- | ---------- |
| `EdgeResources`     | ACM cert, WAFv2 Web ACL (CloudFront scope)               | global stack    | `us-east-1` only  | stateless  |
| `MagicLinkIdentity` | Cognito pool, four triggers, three DDB tables, SES, DKIM | identity stack  | consumer's choice | **RETAIN** |
| `MagicLinkAuthSite` | CloudFront, Lambda@Edge, auth endpoints, login pages     | site stack      | consumer's choice | stateless  |

`MagicLinkAuthSite` takes `EdgeResources` and `MagicLinkIdentity` as
required props. The three-stack pattern follows from two independent
constraints:

- **Region constraint:** CloudFront's ACM cert and CloudFront-scoped
  WAFv2 Web ACL must live in `us-east-1`; Lambda@Edge functions must
  be authored there.
- **Lifecycle constraint:** Cognito pools and DynamoDB tables hold
  persistent data and must be isolated from resources that may be
  replaced on update.

See [`01-package-api.md § Multi-stack handling`](01-package-api.md#multi-stack-handling)
for the consumer-facing example.

## Status

The construct API is `0.x` flux per
[`01-scope-and-philosophy.md § Stability levels`](../01-scope-and-philosophy.md#stability-levels).
The three planned consumers (the existing trellis backend and two
other internal services) will exercise the API before any 1.0 promise.

The previous "CloudFront Function + KVS vs Lambda@Edge" open question
is **resolved: Lambda@Edge** — CloudFront Functions cannot verify
RS256 JWTs (no RSA primitives in the JS runtime). See
[`03-edge-resources.md § The us-east-1 dependency
(resolved)`](03-edge-resources.md#the-us-east-1-dependency-resolved).

## Open questions

- **Dual-publish ESM + CJS** for vestibulum-cdk specifically. ESM-only
  is the rest-of-monorepo default; CDK consumers split between ESM
  and CJS and a CJS consumer hitting `ERR_REQUIRE_ESM` is an awkward
  error. Tracked in
  [`../02-monorepo-layout.md § Module system`](../02-monorepo-layout.md#module-system).
- **Examples placement.** A single root `examples/shared-distribution/`
  vs per-package `packages/vestibulum-cdk/examples/`. Lean root per
  [`../02-monorepo-layout.md § Examples`](../02-monorepo-layout.md#examples).
- **A future `BearerTokenSite` sibling** for OAuth-bearer-token API
  origins (AgentCore Runtime, API Gateway behind CloudFront). Out of
  scope for v0.x; flagged in
  [`09-operational-notes.md § Bearer-token CloudFront`](09-operational-notes.md#bearer-token-cloudfront-future-construct-candidate).
- **A `vestibulum/lambda/*` subpath export** in the vestibulum runtime
  package, replacing the current "vestibulum-cdk picks specific files
  to bundle" arrangement with declared bundle-target entry points.
  Tracked in
  [`../03-package-relationships.md § Open questions`](../03-package-relationships.md#open-questions).
