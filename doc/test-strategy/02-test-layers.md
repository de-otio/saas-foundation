# 02 — Test layers

The taxonomy. Ten layers, ordered roughly from fastest/most-local to
slowest/most-integrated. Each is defined by what it proves, the tooling it
uses, and a real file in the tree that exemplifies it. The first nine run
on every PR; the tenth is deferred (see
[`05-integration-and-e2e.md`](05-integration-and-e2e.md)).

The shape is a pyramid, not a balance: the overwhelming majority of the
~150 test files are layers 1–4 (pure unit, property, schema-contract,
SDK-mock). The CDK layers (5–8) are narrower and snapshot-anchored. The
integration tier (10) is empty by design today.

---

## Layer 1 — Pure unit

**Proves:** a pure function maps inputs to outputs correctly, including
boundaries and typed errors. No mocks, no I/O.

**Tooling:** vitest `describe`/`it`/`expect`.

**Examples:**
- `packages/foundation/test/rate-limit/token-bucket.test.ts` — the pure
  token-bucket core (exported standalone since `0.2.5`).
- `packages/foundation/test/net/cidr.test.ts`,
  `test/net/rfc6890.test.ts` — CIDR membership and reserved-range
  classification.
- `packages/foundation/test/audit/retention.test.ts`,
  `test/audit/ulid.test.ts` — retention-window math, ULID monotonicity.
- `packages/vestibulum/test/.../extract-tenant-subdomain` — subdomain
  parsing for the shared distribution.

This is the densest layer and should stay that way: every algorithm that
*can* be pure is extracted to a pure module and tested here, leaving the
shell thin.

## Layer 2 — Property / brand checkers

**Proves:** invariants hold across a generated input space, not just the
hand-picked examples. Used hardest on the frozen vocabulary (P4).

**Tooling:** `fast-check` + vitest.

**Examples:**
- `packages/foundation/test/frozen/tenant.property.test.ts`,
  `audit.property.test.ts`, `secrets.property.test.ts`,
  `request-context.property.test.ts`,
  `tenant-subdomain.property.test.ts` — brand-construction round-trips and
  rejection of malformed inputs across the generated space.

Required for: every frozen type; any parser/normaliser with an algebraic
property (idempotence of redaction, round-trip of seal/unseal, ordering of
ULIDs). Coverage floor here is 95%, not 80%.

## Layer 3 — Schema / contract

**Proves:** the zod schemas that guard every external input accept the
valid shape and reject the invalid one, and that persisted shapes (DynamoDB
rows, client-config rows) match what the readers expect.

**Tooling:** vitest against the module's `schemas.ts`; fixture rows.

**Examples:**
- `packages/foundation/test/frozen/client-config-row.schema.test.ts` —
  the shared-distribution client-config row contract.
- The `schemas.ts` in `kv/`, `secrets/`, `storage/`, `queue/`,
  `region/`, `audit/`, `feature-toggles/`, and the admin
  `shared-distribution/admin/schemas.ts`.

This layer is the runtime complement to the compile-time type checks: it
catches the drift the type system can't see across a serialization
boundary.

## Layer 4 — AWS-SDK-mock (imperative shell)

**Proves:** the shell issues the correct AWS commands with the correct
parameters, handles SDK errors as typed domain errors, and respects retry /
circuit-breaker policy — without touching real AWS.

**Tooling:** `aws-sdk-client-mock` (+ `aws-sdk-client-mock-vitest`
matchers), `@smithy/util-stream` for streamed responses, `cockatiel` for
retry/circuit assertions.

**Examples:**
- `packages/foundation/test/kv/dynamo-kv.test.ts`,
  `test/storage/s3-storage.test.ts`,
  `test/queue/sqs-queue.test.ts`,
  `test/rate-limit/dynamo-limiter.test.ts` — command shape + error mapping.
- `packages/foundation/test/audit/dynamo-store.test.ts`,
  `multi-store.test.ts` — multi-store fan-out and partial-failure handling.
- vestibulum IdP managers (`idp/oidc-manager`, `idp/saml-manager`) and the
  Cognito-touching admin actions.

The discipline (P3): assert on commands issued, not on a hand-rolled fake's
internal state.

## Layer 5 — Lambda handler unit

**Proves:** the Cognito trigger handlers and edge/admin handlers produce the
right event response for each branch — including quarantine, rate-limit,
and signout — with all boundaries (clock, SDK, secrets) injected.

**Tooling:** vitest with constructed Cognito/CloudFront event objects;
SDK-mock for any AWS calls.

**Examples:**
- `packages/vestibulum/src/lambda/handlers/create-auth-challenge/` —
  quarantine-check, magic-link-email, rate-limit branches.
- `define-auth-challenge`, `verify-auth-challenge`, `auth-verify`,
  `auth-signout`, `pre-signup`, `bounce-handler`.
- `lambda/shared-distribution/triggers/*` and `.../admin/actions/*`.

These are the runtime behaviour of the auth flow and are tested as pure-ish
event transformers wherever the trigger contract allows.

## Layer 6 — CDK construct assertion

**Proves:** a construct synthesises the resources, properties, IAM
policies, and counts we intend — independent of the exact logical IDs.

**Tooling:** `aws-cdk-lib/assertions` (`Template.fromStack`,
`hasResourceProperties`, `resourceCountIs`, `Match`).

**Examples:**
- `packages/foundation-cdk/test/**` for `NodejsLambda`, `QueueWithDlq`,
  `SingleTable`, the house dashboard, and the tagging/house-default
  Aspects.
- `packages/vestibulum-cdk/test/**` for `MagicLinkIdentity`,
  `MagicLinkAuthSite`, `SharedDistributionIdentity`, the WAF defaults,
  edge resources, and custom attributes.
- `packages/foundation/test/audit/iam-shape.test.ts` — least-privilege IAM
  shape asserted at the policy level (also a security test — see
  [`06-security-and-abuse-testing.md`](06-security-and-abuse-testing.md)).

This is where "the feature works" is checked for the CDK packages: the
deployable artifact is the template, so we assert on the template.

## Layer 7 — CDK snapshot

**Proves:** the *full* synthesised template hasn't changed unexpectedly —
the regression net under the targeted assertions of Layer 6.

**Tooling:** vitest snapshots of `Template.fromStack(...).toJSON()`, with
every logical-ID input pinned (P2.6).

**Discipline:** a snapshot update in a PR must be explained in the change
description. An unexplained snapshot churn is treated as an unreviewed
behaviour change, not a formatting diff. Snapshots that would be opaque
(no semantic content) are not added — Layer 6 assertions carry the meaning.

## Layer 8 — JSDOM / generated-asset

**Proves:** the browser-side and generated artifacts behave: the
login-page assets, the edge config generation
(`shared-distribution/edge/generated/edge-config.ts`).

**Tooling:** vitest with the JSDOM environment (configured per-package in
vestibulum-cdk's setup), fixture DOM.

## Layer 9 — Bundle integrity + example synth

**Proves:** (a) the Lambda bundles esbuild produces are byte-for-byte the
ones we expect, and (b) a real consumer project can install the packages
and `cdk synth` the shared-distribution topology end-to-end.

**Tooling:**
- `scripts/build-bundles.ts` + `scripts/verify-bundles.ts` in
  vestibulum-cdk, checking SHA-256s against the committed
  `lambda-bundles.lock.json`. Drift in the bundled Lambda code (the only
  way `vestibulum-cdk` reaches `vestibulum` runtime code) is caught here.
- `examples/shared-distribution` synthesised in CI (`npx cdk synth`),
  which transitively exercises real cross-package resolution, bundle
  loading as CDK assets, and `cdk-nag` rules.

This is the closest thing to an end-to-end check that runs per-PR: it
proves the packages compose as published, without deploying.

## Layer 10 — Integration / E2E (deferred)

**Would prove:** real AWS behaviour — DynamoDB conditional writes under
contention, a full Cognito `CUSTOM_AUTH` magic-link round-trip, Lambda@Edge
executing JWT verification at a real edge, SES bounce handling.

**Status:** not run on any PR; no `integration/` config exists yet. The
determinism rules reserve a separate `integration/` test config and
LocalStack/deployed-stack execution for this tier. Scope, scenarios, and
the trigger to invest are in
[`05-integration-and-e2e.md`](05-integration-and-e2e.md).

---

## Cross-cutting: the `scripts/` CI gates

Not a test *layer* over product code but a test suite of its own
(`scripts/ci/check-frozen-fanout.test.ts`), covering the cross-package
release-discipline gates. These are described in
[`04-coverage-and-ci-gates.md`](04-coverage-and-ci-gates.md) and
[`03-per-package.md`](03-per-package.md#scripts).
