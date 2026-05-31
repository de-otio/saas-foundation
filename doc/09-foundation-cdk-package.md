# 09 — Adding a fourth package: `@de-otio/saas-foundation-cdk`

The position doc for the fourth published package. Explains why a
separate CDK-constructs package exists alongside `vestibulum-cdk`,
what it owns, what it does not, and how the dependency arrows shift
in [`03-package-relationships.md`](03-package-relationships.md).

## The gap

Before this package, the design ([`01-scope-and-philosophy.md`](01-scope-and-philosophy.md))
covered three packages:

- `@de-otio/saas-foundation` — runtime primitives, no CDK.
- `@de-otio/vestibulum` — identity runtime, no CDK.
- `@de-otio/vestibulum-cdk` — CDK constructs for **one** specific
  opinionated topology (magic-link on CloudFront + Cognito).

A backend consumer who installs only the runtime packages still has
to write their own CDK from scratch: VPC, Lambda functions, SQS
queues with DLQs, DynamoDB tables, dashboards. Every house consumer
(trellis, the planned vestibulum integrations, the next backend) does
this independently, and every time it converges to the same handful
of constructs with the same alarm shapes, the same DLQ patterns, and
the same dashboard JSON. The trellis-platform infra directory is the
empirical proof: three constructs (`NodejsLambda`, `QueueWithDlq`,
`SingleTable`) plus three dashboard templates, none of which are
identity-specific and all of which would be re-typed for the next
backend.

`vestibulum-cdk` is the wrong home for these:

- Its scope is _one topology_ (magic-link auth site). Adding generic
  Lambda/queue/table constructs broadens that scope and forces every
  consumer of `vestibulum-cdk` to live with magic-link opinions even
  when they only want a CloudWatch alarm shape.
- The "opinionated topology = sibling construct package" rule from
  [`01-scope-and-philosophy.md § Why four packages, not one`](01-scope-and-philosophy.md#why-four-packages-not-one)
  already anticipates additional construct packages.

The foundation runtime package is also the wrong home: no
`aws-cdk-lib` may appear in `packages/foundation/` (lint rule, see
[`02-monorepo-layout.md`](02-monorepo-layout.md)). CDK is build/deploy
time; foundation is runtime.

A fourth package is the only consistent answer.

## What it is

**`@de-otio/saas-foundation-cdk`** — AWS CDK constructs and templates
for the deployment plumbing every house backend needs, independent of
identity topology. The constructs you pour the slab with: Lambda,
queue, table, dashboards.

Roman-house metaphor: if `saas-foundation` is the slab itself
(runtime primitives), `saas-foundation-cdk` is the forms and rebar
used to pour it. `vestibulum-cdk` is the entrance hall once the slab
is set.

## What it owns (v0.1)

| Construct / asset     | Purpose                                                                       | Source pattern                                                                                         |
| --------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `NodejsLambda`        | `NodejsFunction` + house defaults                                             | trellis-platform/infra/lib/constructs/nodejs-lambda.ts   |
| `QueueWithDlq`        | SQS queue + DLQ + DLQ-non-empty alarm                                         | trellis-platform/infra/lib/constructs/queue-with-dlq.ts  |
| `SingleTable`         | DynamoDB single-table (pk/sk + optional gsi1) + alarms                        | trellis-platform/infra/lib/constructs/single-table.ts    |
| Dashboard helpers     | House CloudWatch dashboard templates                                          | trellis-platform/infra/lib/dashboards/*.json              |
| `HouseDefaultsAspect` | Opt-in CDK Aspect: warn on raw `aws-cdk-lib` resources where a wrapper exists | net-new (CDK best-practice "Aspects for compliance")                                                   |

Each piece comes with its own design note under
[`foundation-cdk/`](foundation-cdk/).

## What it does not own

- **Identity topology.** Lives in `vestibulum-cdk`. The two packages
  don't reach across into each other's construct surface.
- **Domain stacks.** Whole-stack opinions (api-stack, workers-stack,
  cdn-stack, network-stack) live in the consumer's CDK app. The
  foundation-cdk package ships constructs — _building blocks_ — not
  pre-assembled stacks. Consumer stacks are reference reading, not
  graduating targets.
- **WAF rule packs, NAT-instance ASG pattern, ALB/ACM/Route53
  helper.** Deferred to a later minor. The v0.1 surface ships only
  what at least two consumers (trellis and the planned next backend)
  already type by hand. Adding more before that surfaces invites
  speculative-generality drift.
- **Lambda code.** The `NodejsLambda` construct bundles consumer
  code via `NodejsFunction`'s standard `entry` mechanism. The
  package does not ship pre-built Lambda artifacts (that pattern
  belongs in `vestibulum-cdk` for its trigger handlers — see
  [`vestibulum-cdk/10-lambda-bundle-pipeline.md`](vestibulum-cdk/10-lambda-bundle-pipeline.md)).

## Dependency arrows

Updated graph (full version in
[`03-package-relationships.md`](03-package-relationships.md)):

```
                    ┌──────────────────────────┐
                    │     consumer app         │
                    └────────────┬─────────────┘
                                 │
        ┌──────────────────┬─────┴──────┬───────────────────┐
        │                  │            │                   │
        ▼                  ▼            ▼                   ▼
  ┌───────────┐    ┌─────────────┐  ┌──────────────────┐  ┌─────────────────┐
  │ saas-     │    │ vestibulum  │  │ saas-            │  │ vestibulum-cdk  │
  │ foundation│    │  (runtime)  │  │ foundation-cdk   │  │  (CDK)          │
  └─────┬─────┘    └──────┬──────┘  └─────────┬────────┘  └────────┬────────┘
        │                 │                   │                    │
        │  ◄────peer──────┤                   │                    │
        │                                     │                    │
        │      (transitively, via bundle)     │                    │
        │  ◄──────────────────────────────────┼────────────────────┤
        │                                     │  ◄──optional peer──┤
        │                                     │                    │
        └─── (no upward deps) ────            ▼                    ▼
                                       ┌──────────────────────────────┐
                                       │ aws-cdk-lib, constructs      │
                                       └──────────────────────────────┘
```

New arrows:

| Arrow                                               | Kind                    | Form            |
| --------------------------------------------------- | ----------------------- | --------------- |
| `saas-foundation-cdk` → `aws-cdk-lib`, `constructs` | peerDependency          | `^2.x`, `^10.x` |
| `vestibulum-cdk` → `saas-foundation-cdk`            | optional peerDependency | `^0.x.0`        |
| `saas-foundation-cdk` → anything else in this repo  | forbidden               | —               |

`vestibulum-cdk` does **not** strictly require foundation-cdk in
v0.1. The two ship independently and a consumer may install only
foundation-cdk, only vestibulum-cdk, or both. If vestibulum-cdk later
adopts foundation-cdk constructs internally (e.g., to use
`QueueWithDlq` for the SES bounce queue), the peer-dep becomes
mandatory; the v0.1 design keeps the option open without locking in.

Critically, **`saas-foundation-cdk` has no dependency on the
foundation runtime package.** CDK code runs at synth time in the
consumer's CDK process; it has no business pulling AWS SDK runtime
into the synth. Constructs that reference frozen-type names
(`TenantId`, `AuditEvent`) do so as string literals or via the
type-only import shape `import type { TenantId } from
'@de-otio/saas-foundation'` — and `import type` does not pull the
implementation. The lint rule in
[`03-package-relationships.md § Cycle prevention`](03-package-relationships.md#cycle-prevention)
extends to forbid value imports from foundation runtime inside
foundation-cdk.

## Versioning

Independent semver per
[`05-versioning-and-releases.md`](05-versioning-and-releases.md).
Pre-1.0, foundation-cdk follows the same `0.MINOR.PATCH` shape where
MINOR may be breaking. Its publish tag is `@de-otio/saas-foundation-cdk@0.x.y`.

Frozen-type changes do not affect foundation-cdk directly (it has no
value imports of foundation), so the CI fanout gate (frozen-set
fanout to vestibulum + vestibulum-cdk) does not extend to
foundation-cdk. The "type-only imports allowed" lint rule means a
frozen-type rename would surface in foundation-cdk's TypeScript
compile if it referenced the renamed type by name, but no version
fanout is mandated.

## Consumer-side topology

A typical consumer that doesn't use vestibulum at all:

```json
{
  "dependencies": {
    "@de-otio/saas-foundation": "^0.2.0"
  },
  "devDependencies": {
    "@de-otio/saas-foundation-cdk": "^0.3.0",
    "aws-cdk-lib": "^2.200.0",
    "constructs": "^10.0.0"
  }
}
```

A consumer that uses the full magic-link topology:

```json
{
  "dependencies": {
    "@de-otio/saas-foundation": "^0.2.0",
    "@de-otio/vestibulum": "^0.2.0"
  },
  "devDependencies": {
    "@de-otio/saas-foundation-cdk": "^0.3.0",
    "@de-otio/vestibulum-cdk": "^0.3.0",
    "aws-cdk-lib": "^2.200.0",
    "constructs": "^10.0.0"
  }
}
```

The two CDK packages compose without overlapping. A consumer who
wants only the identity topology (and writes their own Lambda /
queue / table constructs) installs vestibulum-cdk alone. A consumer
who wants the deploy-plumbing constructs but rolls their own auth
installs foundation-cdk alone.

## Migration path from trellis

Trellis itself does not deploy — it is library-only — so the
trellis-side adoption is "trellis publishes; the consumer switches its
infra/lib/constructs/ to import from `@de-otio/saas-foundation-cdk`."
This is a one-PR cutover for the three constructs and a follow-up
for the dashboards. See
[`08-trellis-migration.md § Stream 4`](08-trellis-migration.md#stream-4--residual-stays-in-trellis).

The consumer-side cutover is **out of scope** for the
trellis-migration plan (the consumer depends on trellis, not foundation
directly; the constructs live in the consumer's infra, not in trellis).
The consumer picks up foundation-cdk in a separate cycle once
foundation-cdk ships its first construct.

## Out of scope (deferred to v0.2+)

Catalogued so reviewers know they were considered, not forgotten:

- **WAF rule packs.** Managed-rule wrappers (`AWSManagedRulesCommonRuleSet`,
  rate-limit by IP, geo-block, per-route burst). Both the trellis-platform
  `network-stack` and vestibulum-cdk's `EdgeResources` provision WAF
  independently. A shared `WafRulePack` would deduplicate, but the
  shapes diverge enough today (regional vs CloudFront-scope) that
  pinning the API too early is risky. Revisit when both consumers
  have shipped a real WAF config.
- **NAT-instance ASG pattern.** The trellis-platform network-stack
  has a NAT-instance-with-ASG replacement pattern that's strictly
  better than CDK's `NatProvider.instance` (which doesn't
  auto-replace on failure). Worth extracting once a second consumer
  needs it.
- **ALB + ACM + Route53 helper.** The trellis-platform network-stack
  wires these together with a small amount of boilerplate. Extract
  when the second consumer's shape matches; not before.
- **Pre-assembled stacks.** `ApiStack`, `WorkersStack`, etc. Out of
  scope on principle: foundation-cdk ships constructs (composable),
  not stacks (opinionated wholes). Consumers assemble their own.

## Status

Implemented. The constructs described here are built and tested in
`packages/foundation-cdk/lib/`, and the package is versioned alongside
the others. This doc remains the position statement for what the
package is and is not; the per-construct designs live in
[`foundation-cdk/`](foundation-cdk/).
