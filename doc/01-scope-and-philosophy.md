# 01 — Scope and philosophy

The lighthouse doc. Defines what saas-foundation _is_, what each of the
four packages owns, and — most importantly — what we will say no to.
Any later design note that pushes against the boundaries set here must
amend this doc first.

## What saas-foundation is

The runtime and infrastructure tier underneath every multi-tenant SaaS
backend built in the de-otio house. A set of audited primitives chosen
because each one gets re-typed by hand every time a new backend starts:
cloud-primitive shims, secrets handling, session crypto, tenant
context, audit log, structured logging, rate-limiting, region routing,
identity federation, the CDK shape for putting an authenticated
edge in front of a private origin, and the generic AWS CDK constructs
(Lambda, queue, table, dashboards) every consumer deploys above the
runtime.

It is not a framework. It does not own request routing, business
logic, ORMs, or response shapes. It is a library of primitives the
consumer composes; the consumer keeps control of the application
spine.

## Audience

Internal first. The medium-term consumer set is small and known: the
existing backends (trellis), the three planned vestibulum integrations,
and the next backend after that. External adoption is a tertiary goal —
design decisions optimise for the consumers whose code we can read.

This shapes two things:

- **Breaking-change policy is honest, not promotional.** 0.x means 0.x.
  When a cross-package type changes, all four consumers get patched in
  one PR sweep; we don't carry compatibility shims to spare an
  imaginary external user.
- **Documentation is technical, not marketing.** Design notes assume
  the reader has read the previous numbered note. No introductions, no
  "imagine you're building a SaaS" framing.

## What each package is for

### `@de-otio/saas-foundation` — the slab

**In:** cloud-primitive shims (`kv`, `queue`, `storage`), secrets
loader, session crypto, tenant context, audit log, structured logger,
rate-limit, region/residency routing, feature toggles, IP derivation.

**Out:** identity (lives in vestibulum), infrastructure-as-code (lives
in vestibulum-cdk), domain logic (lives in the consumer).

**Assumes:** AWS. Cloudflare-compatible interfaces on the cloud
primitives are a future-proofing pattern (a future swap is mechanical),
not a multi-cloud promise.

### `@de-otio/vestibulum` — the entrance hall

**In:** Cognito IdP managers (OIDC + SAML), multi-pool JWT verifier,
Cognito Lambda trigger templates, OIDC issuer probe with SSRF defence,
SAML metadata parser. Cognito-shaped.

**Out:** identity providers other than Cognito (for now), application
authorisation logic (the consumer's job), audit-log persistence
(delegates to foundation).

**Assumes:** the consumer's authentication layer is built on Cognito.
Doors are not closed against future non-Cognito backends (open-union
types on `identity.providerType`, `triggerSource`, `SecretKind`), but
v0.x ships only Cognito.

### `@de-otio/vestibulum-cdk` — the entrance hall, built

**In:** CDK constructs for one specific deployment topology —
passwordless magic-link auth on Cognito `CUSTOM_AUTH`, CloudFront edge
auth via Lambda@Edge, EU-residency-friendly data plane,
AWS-native (no third-party IdP).

**Out:** every other CDK topology. If a second opinionated topology
arrives later (say, OIDC-fronted SSR site, or B2B-only SAML
integration), it goes in a separate construct package rather than
generalising this one.

**Assumes:** the consumer wants this specific topology. The package
is opinionated by design; consumers who don't want magic-link or
CloudFront-edge-auth do not install it.

### `@de-otio/saas-foundation-cdk` — the slab, poured

**In:** AWS CDK constructs for the deployment plumbing every house
backend needs, _independent_ of identity topology: `NodejsLambda`,
`QueueWithDlq`, `SingleTable`, house CloudWatch dashboard templates.

**Out:** identity-shaped constructs (those are vestibulum-cdk's),
pre-assembled stacks (consumers compose their own), pre-built Lambda
artifacts (foundation-cdk bundles consumer code via standard
`NodejsFunction` entry).

**Assumes:** the consumer's deployment is AWS CDK. No CloudFormation-
or Terraform-flavoured variants — same posture as vestibulum-cdk.

Position and per-construct designs:
[`09-foundation-cdk-package.md`](09-foundation-cdk-package.md) and
[`foundation-cdk/`](foundation-cdk/).

## Why four packages, not one

- **Install cost.** A backend that wants `dynamodb-kv` should not have
  to install `aws-cdk-lib` (>30 MB) or Cognito SDKs. Four packages =
  four install sets. Foundation runtime stays CDK-free; foundation-cdk
  stays identity-free; vestibulum-cdk stays generic-construct-free.
- **Opinion cost.** vestibulum-cdk is highly opinionated about one
  identity topology. Foundation-cdk is opinionated about house
  defaults (ARM64, mandatory concurrency caps, DLQ-on-every-queue)
  but topology-agnostic. Bundling them forces every consumer to
  live with both opinions or fork.
- **Release cadence.** CDK API churn is constant; identity-runtime
  churn is moderate; foundation core churns least; foundation-cdk
  changes when the house construct opinions evolve, which is its own
  rhythm. Independent versions decouple all four.

## Why four packages, not six

- **Cohesion.** foundation's modules share a small cross-package
  vocabulary (`TenantId`, `AuditEvent`, `SecretRef`,
  `RequestContext`). Splitting per concern (cloud-primitives, secrets,
  session, audit, logger, tenant, …) would multiply cross-version
  compatibility dances for ~no install-cost benefit, since most
  consumers use most modules.
- **Subpath exports** — `@de-otio/saas-foundation/kv`, `/secrets`,
  `/audit` — solve the "I only need one slice" case without publish
  overhead.

## Design principles

Each principle is non-negotiable. New code that violates one needs a
specific exemption in the relevant per-package doc.

- **Cloud-primitive shims expose Cloudflare-compat interfaces.** The
  pattern trellis already follows: `kv/dynamodb-kv.ts` implements a
  Cloudflare `KVNamespace`, `queue/sqs-queue.ts` implements a
  Cloudflare `Queue`, etc. Backend swap is mechanical; not a
  multi-cloud audit.
- **Boundary validation, then trust.** Zod (or equivalent) at the
  HTTP / Lambda entry; internal types trusted thereafter. No
  defensive double-validation inside the package.
- **No singletons; constructor injection.** Logger, Prisma client,
  AWS SDK clients — passed in via constructor or factory argument,
  never `getInstance()`'d. Testability is structural, not an
  afterthought.
- **SSRF defence is default-on in every HTTP fetcher.** vestibulum's
  OIDC issuer probe is the reference implementation (DNS-rebinding
  TOCTOU defence via pinned-IP `undici.Agent`, IP allowlist by RFC
  6890, response-size cap on streamed reads, manual redirect
  rejection). Future foundation modules that fetch URLs inherit this
  pattern.
- **Secrets pass through the package as ARNs, not values.** Plaintext
  lives only on the call stack of the AWS-SDK invocation that needs
  it. Never logged, never returned, never stored in any structure
  that could be serialised by accident.
- **Audit at the boundary.** Boundary calls (HTTP handlers, Lambda
  triggers, admin SDK operations) emit `AuditEvent`. Internal-helper
  calls do not. Audit is for "what did the system do on behalf of
  this principal," not "what functions were called."
- **Paid-by-default features must disclose recurring cost in the
  prop docs.** When a construct, runtime module, or default behaviour
  enables an AWS feature that incurs continuous per-resource or
  per-MAU billing — DynamoDB PITR, WAF managed rule groups, Cognito
  Advanced Security, Cognito feature plans above Lite, X-Ray ingest
  past free-tier, etc. — the prop documentation MUST include a
  concrete cost order-of-magnitude and a worked example for a
  representative deployment. Default-on is allowed (and often
  correct) but the cost must be discoverable without reading AWS
  pricing pages. The first review pass (`B-G` ATPRuleSet, `B-H`
  Cognito Advanced Security) and the second pass (`H1` DDB PITR)
  established the pattern; this principle exists so the next
  default-on paid feature is caught at design review, not at the
  first billing-cycle surprise.
- **Design for verification cost.** This project is built and
  maintained by AI agents under human review; the human review _is_
  the verification step. Architectural choices that reduce per-review
  cost — strong types with good inference, `readonly`/`Readonly<>` as
  the default, pure functions outside the explicit I/O / ALS / crypto
  boundaries, small isolated modules, deterministic tests, declarative
  configuration — pay back on every change rather than just at
  maintenance time. The detailed conventions live in
  [`10-ai-maintained-conventions.md`](10-ai-maintained-conventions.md);
  the framing comes from
  [dot-notes verification-as-bottleneck](../../dot-notes/doc/topics/ai-and-software-development/ai-software-patterns/verification-as-bottleneck/).
- **AWS-first.** Cloud primitives are AWS-backed. We do not pay
  generality tax for clouds we do not deploy to.
- **Don't reinvent OSS.** Where a mature OSS library exists for a
  concern that is not core to our domain, we depend on it rather
  than write a thin wrapper. Concretely: ID generation (`ulid`),
  retry / circuit-breaking state machines (`cockatiel`), JWT
  verification (`aws-jwt-verify`), boundary validation (`zod`),
  HTTP framework (`hono` recommended; consumer's choice), helmet-
  equivalent security headers (framework's choice), OpenAPI
  generation (`zod-openapi`). Foundation modules consume these
  directly; they are not re-implemented behind a foundation-shaped
  abstraction. The earlier trellis review identified six in-house
  reimplementations of OSS-solved problems
  ([`analysis/generic-core/14-reusable-components-review.md`](../../trellis/analysis/generic-core/14-reusable-components-review.md)
  in the trellis repo); those modules **do not graduate** to
  foundation. They are retired in place during the trellis migration
  ([`08-trellis-migration.md`](08-trellis-migration.md)).

## What's explicitly out of scope

- **Frontend.** No React, no Vue, no design system, no component
  library. Backend tier only.
- **Domain libraries.** Social, CMS, e-commerce, scheduling, etc. —
  live in vertical repos that consume saas-foundation, not in it.
- **Multi-cloud.** Cloudflare-compat interfaces are a refactor
  affordance, not a portability claim. We do not test against GCP or
  Azure.
- **Workflow / orchestration.** Temporal, Step Functions, Inngest —
  the consumer picks. We expose primitives a workflow engine can sit
  on, not the engine itself.
- **Observability platforms.** We emit structured logs and metrics on
  conventional shapes. We do not ship dashboards, alerting rules, or
  APM agents.
- **Customer-specific work.** This is platform code. Anything that
  reads as "for client X" does not belong here.
- **A "Trellis CLI" or scaffolding tool.** Consumers wire their own
  bootstraps; we do not own project generators.
- **HTTP routing and middleware framework.** Consumers pick — `hono`
  recommended for new code. Foundation is framework-agnostic: it
  provides primitives (session-cookie crypto, IP derivation,
  request-context AsyncLocalStorage, structured logger) that any
  HTTP framework can compose, but it does not ship its own router
  or middleware chain. Trellis's hand-rolled `router.ts` and
  `route-matcher.ts` do not graduate; trellis migrates to a
  third-party router during the
  [`08-trellis-migration.md`](08-trellis-migration.md) work.
- **Circuit-breaker and retry state machines.** Use `cockatiel` (or
  `opossum`) directly. Foundation does not ship a `CircuitBreaker`
  class. Foundation modules that need retry internally (e.g.,
  DynamoDB transient-failure handling) consume `cockatiel`
  themselves; the configuration is not part of the public API.
  Trellis's `circuit-breaker.ts` and `database-circuit-breaker.ts`
  do not graduate.
- **CSRF, security headers, CORS.** Use `helmet` plus the chosen
  HTTP framework's CSRF middleware. These are deeply intertwined
  with the request/response lifecycle of a specific framework and
  do not benefit from a framework-agnostic wrapper. Trellis's
  `csrf.ts`, `security-headers.ts`, and `cors-handler.ts` do not
  graduate.
- **OpenAPI specification generation.** Use `zod-openapi` or
  `@hono/zod-openapi`. Foundation's Zod schemas (where they exist
  — e.g., session-payload validators) are compatible; the spec
  generator lives in the consumer's repo. Trellis's `openapi/`
  module does not graduate.

## Forward compatibility

What we are hedging for:

- **SCIM** in vestibulum. Reserved `scim/` namespace and open-union
  `SecretKind`. No v0.x implementation.
- **Non-Cognito IdPs in vestibulum.** WorkOS / Auth0 / Keycloak.
  Open-union types on `identity.providerType` and `triggerSource`.
  Door is not closed; not implemented.
- **Non-AWS cloud primitives.** Cloudflare-compat shim interfaces.
  Door is not closed; not a v1.0 commitment.
- **Additional vestibulum-cdk topologies.** Second opinionated
  topology arrives as a sibling construct package, not as a
  generalisation of the magic-link one.

What we are _not_ hedging for:

- **Multi-region active-active.** Foundation supports region-pinning;
  cross-region replication is the consumer's responsibility.
- **Non-TypeScript consumers.** Published as ESM + d.ts. No Python /
  Go / Rust SDK.
- **Self-hosted IdPs.** Cognito-bound for v0.x; non-AWS IdP backends
  are future work, not "designed-around" today.
- **Backwards-compatible API growth at 0.x.** Pre-1.0, breaking
  changes are normal. See [`05-versioning-and-releases.md`](05-versioning-and-releases.md).

## Stability levels

Cross-package and consumer-facing surfaces stratify by stability:

- **Frozen — changes require an explicit RFC even pre-1.0:**
  `TenantId`, `TenantSubdomain`, `ClientConfigRow`, `AuditEvent`,
  `RequestContext`, `SecretRef`, `ClaimResolverInput`,
  `ClaimResolverOutput`, `ProvisionerInput`. These are the
  cross-package vocabulary, defined under each package's
  `src/types/frozen/` (the path the CI fanout gate watches); churn
  here ripples across every package and every consumer
  simultaneously.
- **Stable post-1.0 (semver):** all `@de-otio/saas-foundation`
  module exports, `@de-otio/vestibulum` IdP-manager surfaces.
- **0.x flux:** `@de-otio/vestibulum-cdk` construct API, until the
  three planned consumers have integrated and exercised it.
- **Internal:** anything under `_internal/` or not re-exported from
  the package's `index.ts`. No stability guarantees, will be
  refactored without notice.

The frozen set is small on purpose. Cross-package types are the place
where one team's bug becomes another team's runtime crash; the cost
of changing them is concentrated there.

## Status

Implemented. This doc is the scope anchor the per-package designs
reference. If a later doc proposes scope creep (a frontend package, a
non-AWS cloud primitive, a domain library), the proposal amends this
doc first; otherwise the doc is the answer.
