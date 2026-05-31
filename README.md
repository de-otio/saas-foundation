# saas-foundation

[![CI](https://github.com/de-otio/saas-foundation/actions/workflows/ci.yml/badge.svg)](https://github.com/de-otio/saas-foundation/actions/workflows/ci.yml)

The runtime and infrastructure tier underneath every multi-tenant
SaaS backend built in the de-otio house. A monorepo of four
published packages chosen because each one gets re-typed by hand
every time a new backend starts.

## Status

**Implemented.** All four packages are built, typecheck across the
project-reference graph, and pass their test suites; the
shared-distribution (shared CloudFront + shared Cognito pool) feature
is implemented in `vestibulum` and `vestibulum-cdk`. See
[`doc/12-remaining-work.md`](doc/12-remaining-work.md) for outstanding
items before publish. The design went through four design-review
passes (full-set, foundation-cdk + AWS-fact verification,
shared-distribution, and AWS Well-Architected cost pillar); their
findings have been folded into the design docs and the shipped code.

The Roman-house naming convention: the *foundation* is the slab the
house sits on; *vestibulum* is the entrance hall inside it. They
share a monorepo because the contact surface between them
(`TenantId`, `AuditEvent`, `SecretRef`, the claim-resolver
callbacks) is tighter than two separate release pipelines could
keep in sync.

## The four packages

| Package                            | Role                                                                                                                                                                                          | Optional? |
|------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------|
| **`@de-otio/saas-foundation`**     | Runtime core: cloud-primitive shims (`kv`, `queue`, `storage`), secrets, session crypto, tenant context, audit, structured logger, rate-limit, region/residency, feature toggles, IP derivation. No identity opinions. | required for any consumer |
| **`@de-otio/vestibulum`**          | Identity runtime: Cognito IdP managers (OIDC + SAML), multi-pool JWT verifier, Cognito Lambda trigger templates, OIDC issuer probe with SSRF defence, SAML metadata parser, and the shared-distribution edge / trigger / admin handlers. Cognito-shaped.   | optional — only for consumers using Cognito |
| **`@de-otio/saas-foundation-cdk`** | AWS CDK constructs for deployment plumbing every house backend needs: `NodejsLambda`, `QueueWithDlq`, `SingleTable`, house CloudWatch dashboard templates. Identity-agnostic.                  | optional — install when you want the house defaults |
| **`@de-otio/vestibulum-cdk`**      | CDK constructs for opinionated passwordless magic-link auth on Cognito `CUSTOM_AUTH` with CloudFront edge auth via Lambda@Edge (EU-residency), in two flavours: single-tenant (`MagicLinkIdentity` / `MagicLinkAuthSite`) and shared-pool multi-tenant (`SharedDistributionIdentity`).                            | optional — only for consumers wanting this topology |

A consumer who wants only the runtime cloud primitives installs
`@de-otio/saas-foundation`. A consumer with Cognito + their own CDK
installs `@de-otio/saas-foundation` + `@de-otio/vestibulum`. A
consumer who wants the canonical magic-link site installs the
runtime pair plus both CDK packages — `MagicLinkAuthSite` for a
single tenant, or `SharedDistributionIdentity` to serve many tenants
behind one CloudFront distribution with data-only onboarding. A
consumer who wants generic
AWS plumbing (Lambdas, queues, tables, dashboards) but rolls their
own auth installs `@de-otio/saas-foundation` +
`@de-otio/saas-foundation-cdk`. See
[`doc/06-deployment-topology.md`](doc/06-deployment-topology.md)
for the consumer cookbook.

## Repository layout

```
saas-foundation/
├── packages/
│   ├── foundation/          # @de-otio/saas-foundation
│   ├── vestibulum/          # @de-otio/vestibulum
│   ├── foundation-cdk/      # @de-otio/saas-foundation-cdk
│   └── vestibulum-cdk/      # @de-otio/vestibulum-cdk
├── examples/                # consumer integration examples
├── scripts/                 # cross-package tooling (CI gates, topo build)
├── doc/                     # design notes — see below
├── .changeset/              # changesets config
└── .github/workflows/       # CI + changesets release (version PR + OIDC publish)
```

The monorepo layout is specified in
[`doc/02-monorepo-layout.md`](doc/02-monorepo-layout.md).

## Design documents

The whole design is in [`doc/`](doc/). Top-level numbered notes
cover cross-cutting concerns; per-package sub-directories hold the
module-level designs.

**Start here:** [`doc/README.md`](doc/README.md) — index and
framing.

Cross-cutting:

- [`doc/01-scope-and-philosophy.md`](doc/01-scope-and-philosophy.md)
  — what's in, what's out, OSS-reuse principles, design axioms.
- [`doc/02-monorepo-layout.md`](doc/02-monorepo-layout.md) —
  workspaces, tsconfig, ESLint, build orchestration, test framework.
- [`doc/03-package-relationships.md`](doc/03-package-relationships.md)
  — dependency arrows, layering rule, bundling story.
- [`doc/04-shared-vocabulary.md`](doc/04-shared-vocabulary.md) —
  the frozen cross-package type set (`TenantId`, `AuditEvent`,
  `RequestContext`, `SecretRef`, claim-resolver callbacks).
- [`doc/05-versioning-and-releases.md`](doc/05-versioning-and-releases.md)
  — independent per-package versioning via changesets, semver
  policy, RFC process for frozen-set changes.
- [`doc/06-deployment-topology.md`](doc/06-deployment-topology.md)
  — consumer cookbook for the three deployment archetypes.
- [`doc/07-vestibulum-migration.md`](doc/07-vestibulum-migration.md)
  — folding the standalone `vestibulum` repo into this monorepo.
- [`doc/08-trellis-migration.md`](doc/08-trellis-migration.md) —
  extracting trellis's generic infrastructure into foundation.
- [`doc/09-foundation-cdk-package.md`](doc/09-foundation-cdk-package.md)
  — position doc for the fourth package: scope, dependency arrows,
  what's in v0.1, what's deferred.
- [`doc/10-ai-maintained-conventions.md`](doc/10-ai-maintained-conventions.md)
  — architectural conventions specific to AI-built/maintained code.
  Operational rules live in [`CONTRIBUTING.md`](CONTRIBUTING.md).

Per-package:

- [`doc/foundation/`](doc/foundation/) — 11 module designs.
- [`doc/vestibulum/`](doc/vestibulum/) — 8 module designs, plus the
  [`shared-distribution/`](doc/vestibulum/shared-distribution/)
  sub-design (shared CloudFront + shared Cognito pool, 10 docs).
- [`doc/foundation-cdk/`](doc/foundation-cdk/) — 6 construct designs.
- [`doc/vestibulum-cdk/`](doc/vestibulum-cdk/) — 10 construct and
  pipeline designs.

## Versioning

Independent per-package semver via
[changesets](https://github.com/changesets/changesets). Pre-1.0
convention: `0.MINOR.PATCH` where MINOR may be breaking. Frozen-set
type changes require an RFC and a coordinated MINOR bump across
every affected package; the CI fanout gate enforces this.

Detail: [`doc/05-versioning-and-releases.md`](doc/05-versioning-and-releases.md).

## License

Apache-2.0 (matching the standalone `vestibulum` repo this monorepo
absorbs); see [`LICENSE`](LICENSE).
