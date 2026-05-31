# saas-foundation — design docs

A monorepo of runtime libraries and CDK constructs that sit underneath every
multi-tenant SaaS backend in the de-otio house: cloud primitives, secrets,
sessions, audit, tenancy, identity federation, the opinionated CDK shape
for putting an authenticated edge in front of a private origin, and the
generic AWS CDK constructs every consumer deploys on top of the runtime.

Four published packages:

- **`@de-otio/saas-foundation`** — runtime core. KV/queue/storage shims over
  AWS primitives, secrets loader, session crypto, tenant context, audit log,
  structured logger, rate-limit, region/residency, feature toggles, IP
  derivation. Zero identity-provider opinions.
- **`@de-otio/vestibulum`** — identity runtime. Cognito IdP managers (OIDC +
  SAML), multi-pool JWT verifier, Cognito Lambda trigger templates, OIDC
  issuer probe with SSRF defence, SAML metadata parser. Depends on
  `saas-foundation` for secrets / tenant / logger.
- **`@de-otio/saas-foundation-cdk`** — AWS CDK constructs for deployment
  plumbing every house backend needs, independent of identity topology:
  `NodejsLambda`, `QueueWithDlq`, `SingleTable`, house CloudWatch dashboard
  templates. Optional; install when you want the house defaults.
- **`@de-otio/vestibulum-cdk`** — CDK constructs for one opinionated
  deployment shape: passwordless magic-link auth on Cognito `CUSTOM_AUTH`,
  CloudFront edge auth, EU-residency-friendly. Optional; install only when
  this is the topology you want.

The Roman-house metaphor: the _foundation_ is the slab the house sits on,
the _vestibulum_ is the entrance hall that screens visitors before
admission. `vestibulum` lives inside the foundation, not next to it.
`saas-foundation-cdk` is the forms and rebar used to pour the slab.

## Top-level design notes

Cross-cutting concerns — scope, layout, versioning, deployment, migration.
Read these in order on first pass.

- [`01-scope-and-philosophy.md`](01-scope-and-philosophy.md) — what's in,
  what's out, what each package owns, why four packages and not one or
  six.
- [`02-monorepo-layout.md`](02-monorepo-layout.md) — workspace structure,
  shared tsconfig / eslint, build & test orchestration, where examples
  and scripts live.
- [`03-package-relationships.md`](03-package-relationships.md) — the
  dependency arrows. `vestibulum` → `foundation`, `vestibulum-cdk` →
  `vestibulum` (bundled Lambda code only). What each package may and
  may not reach for.
- [`04-shared-vocabulary.md`](04-shared-vocabulary.md) — cross-package
  types: `TenantId`, `AuditEvent`, `SecretRef`, `ClaimResolverOutput`,
  `RequestContext`. Which package owns each, stability guarantees.
- [`05-versioning-and-releases.md`](05-versioning-and-releases.md) —
  semver policy, breaking-change discipline, the single version-PR +
  OIDC-publish workflow, CHANGELOG format. Independent versioning, not
  lockstep.
- [`06-deployment-topology.md`](06-deployment-topology.md) — how a
  consumer wires it up. Install which packages, instantiate which
  clients, deploy which CDK constructs. Cookbook for the three
  archetypes (multi-tenant SaaS API, magic-link CloudFront site,
  hybrid).
- [`07-vestibulum-migration.md`](07-vestibulum-migration.md) — folding
  the existing standalone `vestibulum` repo into this monorepo.
- [`08-trellis-migration.md`](08-trellis-migration.md) — extracting
  candidate modules from `trellis` into `@de-otio/saas-foundation`.
  Order, decoupling steps, what to leave behind.
- [`09-foundation-cdk-package.md`](09-foundation-cdk-package.md) —
  position doc for the fourth package: scope, dependency arrows,
  what's in v0.1, what's deferred to v0.2+.
- [`10-ai-maintained-conventions.md`](10-ai-maintained-conventions.md)
  — conventions specific to the repo being AI-built/maintained:
  immutability defaults, purity heuristic, test determinism,
  property-based brand checkers, module-size budget, PR-size policy,
  specs-as-evals. Operational counterpart:
  [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
- [`11-implementation-plan.md`](11-implementation-plan.md) —
  executed historical build-order plan for the four-package v0.1
  ship. Six phases, agent-per-phase concurrency, model assignments,
  MCP checkpoints, risk register. Retained as a record.
- [`12-remaining-work.md`](12-remaining-work.md) — post-0.2 status
  and the gap to 1.0.0: what shipped, what remains, what's blocked
  externally, what's out of scope.
- [`13-cost-attribution-conventions.md`](13-cost-attribution-conventions.md)
  — house cost-allocation tag conventions and the per-tenant
  attribution model, tying together the tagging aspect and the
  shared-distribution cost doc.
- [`14-multi-tenancy/`](14-multi-tenancy/) — multi-tenant data
  isolation analysis and the RLS-first implementation plan. The
  [`deep-dive/`](14-multi-tenancy/deep-dive/) is the source of truth
  (pool model + PostgreSQL Row-Level Security as the DB-enforced
  boundary); the top-level `14-*` notes are the earlier pass it
  supersedes.
- [`15-minimal-vertical-app-deploy.md`](15-minimal-vertical-app-deploy.md)
  — how to stand up a minimal throwaway instance (the trellis API on
  the foundation) for end-to-end testing, including the multi-tenancy
  path. Honest about what infra exists vs. what you author.

## Per-package designs

Detailed designs live in sub-directories, mirroring `vestibulum`'s
existing numbered-design-notes style.

### [`foundation/`](foundation/) — runtime core

The slab. Cloud primitives, secrets, sessions, logging, audit, tenancy.

- `01-package-api.md` — exports surface and module boundaries.
- `02-cloud-primitives.md` — `dynamodb-kv`, `sqs-queue`, `s3-storage`
  shims; the Cloudflare-compat interfaces over AWS.
- `03-secrets.md` — SSM / Secrets Manager loader with caching.
- `04-session-crypto.md` — AES-GCM cookie encryption. No identity
  coupling; verifies an opaque session blob.
- `05-tenant-context.md` — tenant resolver + AsyncLocalStorage carrier.
- `06-audit-log.md` — append-only event log, retention tiers.
- `07-logger-and-request-context.md` — structured logging with
  request-id correlation.
- `08-rate-limit.md` — KV-backed token bucket.
- `09-region-and-residency.md` — multi-region routing.
- `10-feature-toggles.md` — DB-backed boolean toggles.
- `11-ip-derivation.md` — trusted-proxy client-IP resolution.

### [`vestibulum/`](vestibulum/) — identity runtime

The entrance hall. Cognito IdP federation, JWT verification, Cognito
triggers. Cognito-shaped (other IdP backends out of scope for v0.x).

- `01-package-api.md` — exports surface (transplant of vestibulum's
  current `federation/02-runtime-api.md`).
- `02-oidc-flows.md` — issuer probe, OIDC IdP manager, client-secret
  handling.
- `03-saml-flows.md` — metadata parsing, SAML IdP manager,
  signing-cert rotation.
- `04-cognito-triggers.md` — pre-token-generation and
  post-confirmation Lambda templates.
- `05-jwt-verification.md` — multi-pool verifier, `requirePool`.
- `06-pool-topology.md` — B2C vs B2B pool separation.
- `07-scim-forward-compat.md` — reserved namespace and IdP-record
  extensibility.
- `08-shared-pool-multi-tenancy.md` — single shared Cognito pool
  serving many tenants; per-tenant claim scoping.

The [`shared-distribution/`](vestibulum/shared-distribution/) sub-design
covers the implemented shared-CloudFront + shared-Cognito-pool topology:

- `01-architecture.md` — the shared-distribution model end to end.
- `02-construct-api.md` — runtime/handler surface consumed by the CDK.
- `03-tenant-onboarding.md` — onboarding/offboarding and the reconciler.
- `04-multi-aud-edge-check.md` — the edge auth check across many `aud`s.
- `05-wildcard-infra.md` — wildcard cert + DNS infrastructure.
- `06-trigger-handlers.md` — pre-token / auth-verify / auth-signout handlers.
- `07-security-and-isolation.md` — tenant isolation guarantees.
- `08-observability-and-audit.md` — metrics, logs, audit at the edge.
- `09-implementation-plan.md` — build order for the shared-distribution work.

### [`foundation-cdk/`](foundation-cdk/) — generic AWS CDK constructs

The forms and rebar. AWS CDK constructs for the deployment plumbing
every house backend needs, independent of identity topology.

- `01-package-api.md` — exports surface and module boundaries.
- `02-nodejs-lambda.md` — `NodejsLambda` construct.
- `03-queue-with-dlq.md` — `QueueWithDlq` construct.
- `04-single-table.md` — `SingleTable` construct.
- `05-dashboards.md` — house CloudWatch dashboard templates.
- `06-aspects.md` — `HouseDefaultsAspect` (opt-in compliance enforcement).

### [`vestibulum-cdk/`](vestibulum-cdk/) — identity infrastructure

One opinionated deployment shape: magic-link auth on CloudFront,
EU-residency, AWS-native.

- `01-package-api.md` — exported constructs surface.
- `02-magic-link-identity.md` — `MagicLinkIdentity` construct.
- `03-edge-resources.md` — `EdgeResources` / CloudFront / WAF.
- `04-magic-link-auth-site.md` — `MagicLinkAuthSite` construct.
- `05-app-clients.md` — Cognito app-client provisioning rules.
- `06-trigger-hooks.md` — wiring vestibulum runtime triggers into the
  Cognito user pool.
- `07-cdk-changes-from-trellis.md` — what Trellis already had that
  these constructs absorb.
- `08-metrics.md` — emitted metrics and the metric-builder helpers.
- `09-operational-notes.md` — deploy-time and runtime operational guidance.
- `10-lambda-bundle-pipeline.md` — the SHA-256-locked Lambda bundle
  build/verify pipeline and the bundle lock manifest.

## Design reviews

Point-in-time review passes, with findings tracked through to source:

- [`review/2026-05-24-initial-design-pass.md`](review/2026-05-24-initial-design-pass.md)
  — first full-set review (12 BLOCKERs, 3 HIGH-security, 29 SIGNIFICANT).
- [`review/2026-05-24-foundation-cdk-and-aws-verification.md`](review/2026-05-24-foundation-cdk-and-aws-verification.md)
  — foundation-cdk + AWS-fact verification pass.
- [`review/2026-05-25-shared-distribution-design-review.md`](review/2026-05-25-shared-distribution-design-review.md)
  — shared-distribution (shared CloudFront + shared Cognito pool) pass.

## Status

Implemented. All four packages are built and tested; the
shared-distribution feature has landed in `vestibulum` and
`vestibulum-cdk`. The numbered top-level docs remain the place to land
cross-cutting decisions — a doc that proposes a change still amends the
relevant note first. These docs are being reconciled with the landed
code; see [`12-remaining-work.md`](12-remaining-work.md) for outstanding
items before publish.
