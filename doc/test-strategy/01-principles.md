# 01 — Principles

The testing philosophy, stated as rules with reasons. These are the
load-bearing decisions; the layer taxonomy ([`02-test-layers.md`](02-test-layers.md))
and the per-package plan ([`03-per-package.md`](03-per-package.md)) are
applications of them.

## P1. Verification is the product, not a side effect

This repo is built and maintained largely by AI agents. The constraint that
shapes everything is the one from
`verification-as-bottleneck`: authoring code is cheap, *verifying it is
correct* is expensive, and the test suite is the instrument that makes
verification cheap enough to keep shipping. A test that does not reduce
the cost of trusting a future change is not pulling its weight.

Consequences:

- **Tests must fail when the change is wrong.** Coverage that exercises a
  line without asserting on its observable effect is theatre. Boundary
  cases and failure paths are mandatory, not optional (see P5).
- **No verification theatre.** No snapshot tests whose only content is "it
  rendered something"; no assertions that restate the implementation; no
  uncalibrated "looks fine" checks. A snapshot must pin semantically
  meaningful output (a CloudFormation logical ID chain, a redaction
  result), not an opaque blob.
- **The spec is the test, where one exists.** For the frozen vocabulary
  and the security paths, the acceptance criteria *are* the property tests
  and the abuse tests. Design review happens on the spec; code review
  happens on correctness against it.

## P2. Determinism is non-negotiable

A flaky test in an AI-maintained repo is worse than a missing one: it
trains both humans and agents to ignore red, and it taxes every future
change. The determinism rules are enforced mechanically, not by goodwill.
They are specified in
[`../02-monorepo-layout.md`](../02-monorepo-layout.md#determinism-rules);
restated here as the contract every test in this repo honours:

1. **No wall-clock.** Code that reads time accepts an injected `clock: () => Date`
   (or `now` ms); tests pin it or use `vi.useFakeTimers()`. ESLint's
   `no-restricted-globals` bans `Date` / `Date.now` inside `test/`.
2. **No unseeded randomness.** Code consuming randomness takes a `Random`
   parameter defaulting to the real one; tests pass a seeded instance.
   ULID generation, token-bucket jitter, and session-key derivation all
   follow this.
3. **No real network or filesystem.** Mock at the AWS SDK boundary
   (`aws-sdk-client-mock`) or the `fetch`/`undici` boundary. Anything that
   genuinely needs a socket is integration-tier and does not run on a PR
   (see [`05-integration-and-e2e.md`](05-integration-and-e2e.md)).
4. **No iteration-order assumptions.** No asserting on `Object.keys`,
   `Map`/`Set` iteration, or unsorted query results without an explicit
   sort or a set-equality matcher. The `check-unsorted-toequal` CI gate
   (`scripts/ci/check-unsorted-toequal.ts`) enforces a conservative,
   low-false-positive subset of this rule: it flags `.toEqual` /
   `.toStrictEqual` applied directly to `Object.keys(x)`,
   `Object.values(x)`, `Object.entries(x)`, or spreads of Map/Set
   iterators (`[...x.keys()]`, `[...someSet]`, etc.). It does not
   perform data-flow analysis on arbitrary variables. Add a
   `// sorted-ok` comment to suppress a finding when order is genuinely
   guaranteed. Broader enforcement of the policy relies on review
   discipline for cases the gate cannot detect.
5. **Order-independence is proven, not assumed.** Every suite runs with
   `sequence: { shuffle: true, seed: 1000 }`. Shared state that leaks
   between tests surfaces as a reproducible failure under that seed, not
   as intermittent CI red.
6. **Snapshots pin every logical-ID input.** Stack name, account, region,
   and any prop that flows into a construct `id` chain are fixed in the
   test, so a snapshot diff means a real change, never ambient drift.

## P3. Test at the seam, mock at the boundary

The architecture is functional-core / imperative-shell by mandate (see the
Software design defaults). The test strategy mirrors it:

- **Pure cores are unit-tested directly, with no mocks.** The token-bucket
  algorithm, CIDR/RFC6890 classification, PII filtering, retention math,
  cookie sealing, the SAML metadata parser, the tenant resolvers — these
  are pure functions and get dense, fast, example-plus-property tests.
- **The imperative shell is mocked at the cloud boundary.** DynamoDB, SQS,
  S3, Secrets Manager, SSM, Cognito IdP, SES are all reached through the
  AWS SDK v3 clients and mocked with `aws-sdk-client-mock`. We assert on
  the *commands issued* (shape, parameters, ordering) rather than spinning
  up fakes.
- **Never mock what you own.** We do not mock the foundation's own
  functions from inside vestibulum's tests; we use the real ones with
  injected boundaries. Mocking owned code couples tests to implementation
  and hides integration defects.

The dividing line: if a defect in the dependency would be a defect for our
consumers, exercise the real thing; if it's AWS's job to be correct, mock
it and assert we called it right.

## P4. The frozen vocabulary is the highest-value test target

`TenantId`, `AuditEvent`, `RequestContext`, `SecretRef`, and the
claim-resolver callback types are the contact surface between packages and
between releases. A silent change here breaks consumers at runtime in ways
the type system alone won't catch (brand erosion, schema drift). Therefore:

- The frozen types carry **property-based brand checkers** (fast-check)
  under `test/frozen/` (foundation) and `src/types/frozen/` (vestibulum).
- These are held to a **≥95% line/branch coverage** floor — higher than
  the 80% repo default — and are explicitly *included* in coverage even
  though they are pure-type-adjacent.
- A change to a frozen type must fan out a coordinated version bump across
  every affected package; the `check-frozen-fanout` CI gate enforces it
  (see [`04-coverage-and-ci-gates.md`](04-coverage-and-ci-gates.md)).

## P5. Cover failure paths and boundaries, not just the happy path

For each module the required coverage set is:

- **Happy path** — the documented success case.
- **Boundary** — empty input, single element, max size, the exact TTL
  edge, the off-by-one on a rate-limit window, the residency-region
  cutover.
- **Failure** — malformed input rejected by the zod schema, an SDK error
  surfaced as the right typed error (`kv/errors.ts`, `net/errors.ts`,
  etc.), a circuit opening under `cockatiel`, a retry exhausting.
- **Adversarial**, for security paths — see
  [`06-security-and-abuse-testing.md`](06-security-and-abuse-testing.md).

The typed `errors.ts` in nearly every module exists precisely so that the
failure path is assertable by error *type*, not by string matching.

## P6. What we deliberately do not test

Stated explicitly so the absence reads as a decision, not a gap:

- **AWS SDK correctness.** We assert we issue the right commands; we trust
  the SDK to execute them.
- **CDK → CloudFormation lowering.** We assert the synthesised template
  (via `Template.fromStack`); we trust `aws-cdk-lib` to deploy it.
- **Real cloud behaviour** (actual DynamoDB throttling, real Cognito
  `CUSTOM_AUTH` round-trips, live CloudFront edge execution) — deferred to
  the integration tier ([`05-integration-and-e2e.md`](05-integration-and-e2e.md)),
  not run per-PR.
- **Performance / load.** None planned pre-`1.0.0` (per
  [`../12-remaining-work.md`](../12-remaining-work.md)). Rate-limit and
  cost-DoS *logic* is unit-tested; throughput is not.
- **Third-party library internals** (pino, zod, aws-jwt-verify,
  xml-crypto) beyond the contract we depend on.

When one of these absences starts costing real incidents, it graduates to
the integration tier — that promotion is a deliberate, documented step.
