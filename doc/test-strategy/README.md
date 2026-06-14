# saas-foundation — test strategy

This subfolder is the single source of truth for **how saas-foundation is
tested**: what we test, at which layer, with which tools, what gates a merge,
and what is deliberately deferred. It complements — does not replace — the
determinism rules in
[`../02-monorepo-layout.md`](../02-monorepo-layout.md#test-framework) and the
AI-maintained conventions in
[`../10-ai-maintained-conventions.md`](../10-ai-maintained-conventions.md).

The repo is published as four npm packages that sit underneath production
multi-tenant SaaS backends. The blast radius of a regression is every
consumer that bumps the dependency. The test strategy is sized to that
blast radius: the contact surface between packages (the frozen vocabulary)
and the security-bearing code paths (JWT verification, SSRF defence, SAML
signature checking, edge auth, IAM shape) get the heaviest scrutiny;
glue and config get lighter, snapshot-pinned coverage.

## Why this exists as its own document

Three forces make a written strategy worth maintaining here:

1. **AI-built and AI-maintained.** Most change arrives as agent-authored
   drafts. Verification is the bottleneck, not authorship. The test suite
   is the primary verification instrument, so its shape is a design
   concern, not an afterthought. See
   [`01-principles.md`](01-principles.md).
2. **A published, multi-consumer library.** There is no single deployed
   app to smoke-test. The "feature works" check is split across snapshot
   tests of CDK output, contract tests of the frozen types, and (for the
   shared-distribution topology) example-synth in CI. See
   [`02-test-layers.md`](02-test-layers.md).
3. **Security primitives in scope.** Identity federation, session crypto,
   and an authenticated CloudFront edge are all in the tree. Several test
   files exist purely to pin abuse-resistance behaviour. See
   [`06-security-and-abuse-testing.md`](06-security-and-abuse-testing.md).

## Documents

- [`01-principles.md`](01-principles.md) — testing philosophy for an
  AI-maintained library: determinism, seam injection (clock / random /
  SDK / `fetch`), what we test and what we deliberately don't, and how a
  test earns its keep.
- [`02-test-layers.md`](02-test-layers.md) — the test taxonomy. Ten
  layers from pure-unit through property/brand, schema-contract,
  AWS-SDK-mock, CDK assertion + snapshot, JSDOM, bundle-integrity,
  example-synth, up to the (deferred) integration tier — each with the
  concrete files that exemplify it.
- [`03-per-package.md`](03-per-package.md) — the per-package plan:
  `foundation`, `vestibulum`, `foundation-cdk`, `vestibulum-cdk`, and the
  cross-package `scripts/` CI gates. What each one is responsible for
  proving.
- [`04-coverage-and-ci-gates.md`](04-coverage-and-ci-gates.md) — coverage
  thresholds (80% floor, 95% on frozen-set brand checkers), the CI
  pipeline step-by-step, the gate scripts, and the precise list of what
  blocks a merge.
- [`05-integration-and-e2e.md`](05-integration-and-e2e.md) — the tier we
  do **not** run on every PR: LocalStack and deployed-stack integration,
  the risk-ranked scenario list, and the trigger conditions for investing
  in it before `1.0.0`.
- [`06-security-and-abuse-testing.md`](06-security-and-abuse-testing.md) —
  the security-bearing paths and the adversarial tests that pin them:
  SSRF, JWT cross-pool confusion, SAML signature-wrapping, rate-limit
  evasion, edge-auth bypass, IAM least-privilege shape, PII redaction.
- [`07-implementation-plan.md`](07-implementation-plan.md) — the plan to
  bring the tree into full conformance with this strategy: a gap register
  and phased work to give the documented gates teeth (frozen-95%,
  unsorted-`toEqual` lint, gate-script tests, coverage-include guard),
  audit the existing security tests for adequacy, and stage the deferred
  integration tier.

## How to run

```bash
npm test                                  # all suites, once (vitest run)
npm test -- --coverage                    # with coverage + thresholds
npm test --workspace @de-otio/vestibulum  # one package
npm run test:watch                         # watch mode (root)
npm run typecheck                          # tsc -b across the reference graph
npm run lint                               # type-aware eslint (incl. test rules)
```

The CDK packages additionally depend on the vestibulum-cdk Lambda bundles
being built before their tests run (the constructs load bundles as CDK
assets at synth time). Locally:

```bash
npm run build                                          # topo build, emits dist/
npm run build-bundles --workspace @de-otio/vestibulum-cdk
npm test
```

CI does this in order automatically — see
[`04-coverage-and-ci-gates.md`](04-coverage-and-ci-gates.md).

## The shape, in one paragraph

~150 vitest test files run on every PR, all hermetic (no network, no
real filesystem, no wall-clock), randomised in order with a fixed seed
(`shuffle: true, seed: 1000`) so order-dependence surfaces deterministically.
The frozen cross-package vocabulary is held by property-based brand
checkers at ≥95% coverage; everything else floors at 80%. CDK constructs
are verified by `Template.fromStack` assertions plus seed-pinned snapshots
and `cdk-nag`. Lambda bundles are content-hashed against a committed lock
file. The shared-distribution example is synthesised end-to-end in CI.
Three cross-package gate scripts (changesets, frozen-fanout, peer-dep
ranges) enforce the release discipline. Integration against real AWS is
deferred past `1.0.0` and tracked in
[`05-integration-and-e2e.md`](05-integration-and-e2e.md).
