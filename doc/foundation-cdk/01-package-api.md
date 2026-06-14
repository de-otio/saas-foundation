# 01 — Package API

The `@de-otio/saas-foundation-cdk` exports surface. Top-level barrel,
sub-path exports, what each module ships, and the `package.json` shape.

## Export strategy

Two import shapes, both supported on day one:

```typescript
// 1. Top-level barrel
import { NodejsLambda, QueueWithDlq, SingleTable } from "@de-otio/saas-foundation-cdk";

// 2. Sub-path exports
import { NodejsLambda } from "@de-otio/saas-foundation-cdk/lambda";
import { QueueWithDlq } from "@de-otio/saas-foundation-cdk/queue";
import { SingleTable } from "@de-otio/saas-foundation-cdk/table";
import { houseDashboard } from "@de-otio/saas-foundation-cdk/dashboards";
```

The sub-paths exist mostly for symmetry with foundation; tree-shaking
matters less here because consumers typically use all three
constructs together, and CDK's `aws-cdk-lib` is already in the
import graph either way.

The barrel is hand-curated, not `export * from ...`.

## Top-level exports (the barrel)

```typescript
// packages/foundation-cdk/lib/index.ts

// Constructs
export { NodejsLambda, NodejsLambdaPropsError } from "./nodejs-lambda/index.js";
export type {
  NodejsLambdaProps,
  PrismaBundlingOptions,
  PrismaEngine,
  IteratorAgeAlarmOptions,
} from "./nodejs-lambda/index.js";

export { QueueWithDlq } from "./queue-with-dlq/index.js";
export type { QueueWithDlqProps } from "./queue-with-dlq/index.js";

export { SingleTable } from "./single-table/index.js";
export type { SingleTableProps } from "./single-table/index.js";

// Dashboards (substitution helper + house templates by name)
export { houseDashboard, listHouseDashboards, readHouseTemplate } from "./dashboards/index.js";
export type { HouseDashboardName, HouseDashboardParams } from "./dashboards/index.js";

// Aspects (compliance enforcement)
export { HouseDefaultsAspect } from "./aspects/index.js";
export type { HouseDefaultsAspectProps } from "./aspects/index.js";
export { HouseTaggingAspect, validateHouseTaggingApplied } from "./aspects/index.js";
export type { HouseTaggingAspectProps } from "./aspects/index.js";
```

## Sub-path exports

| Sub-path                                  | Module                |
| ----------------------------------------- | --------------------- |
| `@de-otio/saas-foundation-cdk/lambda`     | `NodejsLambda`        |
| `@de-otio/saas-foundation-cdk/queue`      | `QueueWithDlq`        |
| `@de-otio/saas-foundation-cdk/table`      | `SingleTable`         |
| `@de-otio/saas-foundation-cdk/dashboards` | dashboard helpers     |
| `@de-otio/saas-foundation-cdk/aspects`    | `HouseDefaultsAspect`, `HouseTaggingAspect`, `validateHouseTaggingApplied` |

## `package.json` sketch

```jsonc
{
  "name": "@de-otio/saas-foundation-cdk",
  "version": "0.3.0",
  "type": "module",
  "description": "AWS CDK constructs for de-otio SaaS deployment plumbing",
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/de-otio/saas-foundation",
    "directory": "packages/foundation-cdk",
  },
  "engines": { "node": ">=24.0.0" },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./lambda": {
      "import": "./dist/nodejs-lambda/index.js",
      "types": "./dist/nodejs-lambda/index.d.ts",
    },
    "./queue": {
      "import": "./dist/queue-with-dlq/index.js",
      "types": "./dist/queue-with-dlq/index.d.ts",
    },
    "./table": {
      "import": "./dist/single-table/index.js",
      "types": "./dist/single-table/index.d.ts",
    },
    "./dashboards": {
      "import": "./dist/dashboards/index.js",
      "types": "./dist/dashboards/index.d.ts",
    },
    "./aspects": { "import": "./dist/aspects/index.js", "types": "./dist/aspects/index.d.ts" },
  },
  "files": ["dist", "README.md", "CHANGELOG.md"],
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "lint": "eslint lib test",
  },
  "peerDependencies": {
    "aws-cdk-lib": "^2.200.0",
    "constructs": "^10.0.0",
  },
  "dependencies": {},
  "devDependencies": {
    "aws-cdk-lib": "^2.200.0",
    "constructs": "^10.0.0",
    "cdk-nag": "^2.x",
  },
  "publishConfig": { "access": "public" },
}
```

Notes:

- **No runtime dependencies.** Everything CDK-shaped is a peer.
  Consumers bring their own `aws-cdk-lib` + `constructs` versions;
  foundation-cdk does not deduplicate.
- **No `@de-otio/saas-foundation` import** — value or type-only —
  permitted in the published artifact (enforced by ESLint, see
  [`../03-package-relationships.md`](../03-package-relationships.md)).
  Frozen-type names appear as string literals where they appear at
  all (CloudWatch dashboard variables, alarm dimensions); types are
  reconstructed locally if needed.
- **No `@de-otio/vestibulum*`** — value or type — in any direction.
  Foundation-cdk has no opinion about identity.
- **Dual-publish ESM + CJS?** Same open question as vestibulum-cdk
  ([`../02-monorepo-layout.md § Module system`](../02-monorepo-layout.md#module-system)).
  Lean ESM-only for v0.1 with vestibulum-cdk; revisit together.

## Source layout

```
packages/foundation-cdk/
├── lib/                              # CDK source (trellis convention)
│   ├── index.ts                      # barrel
│   ├── nodejs-lambda/
│   │   ├── index.ts
│   │   ├── nodejs-lambda.ts
│   │   ├── prisma-bundling.ts
│   │   └── alarms.ts
│   ├── queue-with-dlq/
│   │   ├── index.ts
│   │   └── queue-with-dlq.ts
│   ├── single-table/
│   │   ├── index.ts
│   │   └── single-table.ts
│   ├── dashboards/
│   │   ├── index.ts
│   │   ├── house-dashboard.ts        # substitution helper
│   │   └── templates/                # JSON assets shipped as data
│   │       ├── api-health.json
│   │       ├── database.json
│   │       └── workers.json
│   └── aspects/
│       ├── index.ts
│       ├── house-defaults.ts         # HouseDefaultsAspect, RuleSeverity
│       ├── tagging.ts                # HouseTaggingAspect, validateHouseTaggingApplied
│       └── metadata-tags.ts          # HOUSE_CONSTRUCT_METADATA_KEY, getHouseConstructTag
├── test/
│   ├── nodejs-lambda.test.ts
│   ├── queue-with-dlq.test.ts
│   ├── single-table.test.ts
│   ├── dashboards.test.ts
│   └── aspects.test.ts
├── CHANGELOG.md
├── README.md
├── package.json
└── tsconfig.json
```

The `lib/` (not `src/`) convention mirrors `vestibulum-cdk` and the
CDK community default. Foundation runtime uses `src/`; CDK packages
use `lib/`. Both conventions are stable inside their respective
packages.

The dashboard JSON templates ship as files in `dist/dashboards/templates/`
(unmodified copies; the build step copies them next to the compiled
JS). The `houseDashboard()` helper reads them at runtime — synth time,
not deploy time — so the consumer's CDK process sees the JSON.

## Module index → doc map

| Module                | Design doc                                         |
| --------------------- | -------------------------------------------------- |
| `lib/nodejs-lambda/`  | [`./02-nodejs-lambda.md`](./02-nodejs-lambda.md)   |
| `lib/queue-with-dlq/` | [`./03-queue-with-dlq.md`](./03-queue-with-dlq.md) |
| `lib/single-table/`   | [`./04-single-table.md`](./04-single-table.md)     |
| `lib/dashboards/`     | [`./05-dashboards.md`](./05-dashboards.md)         |
| `lib/aspects/`        | [`./06-aspects.md`](./06-aspects.md)               |

## Testing posture

The CDK snapshot pattern: each construct test uses CDK's
`Template.fromStack(stack)` and asserts on `hasResourceProperties`
for the resources it creates. No deploy testing in CI — synth-only.

A small fixture: each test file constructs a throwaway `cdk.App` +
`cdk.Stack`, instantiates the construct with the props under test,
and asserts shape.

**Deterministic snapshot inputs are mandatory.** Every snapshot test
pins:

- A fixed stack name (no auto-generated identifiers in the stack
  hierarchy).
- A fixed `env: { account: '123456789012', region: 'eu-west-1' }`
  (consistent across all tests so logical-ID derivation is stable).
- Fixed values for every prop that flows into a child construct's
  `id` chain (e.g., `tableName`, `functionName`, `queueName`).
- A frozen clock for any construct that reads time at synth (none
  currently, but the rule is preventative).

Without these pins, a snapshot diff is indistinguishable from a real
regression: a CDK version bump or a CDK-side logical-ID change
produces noise the reviewer cannot triage. The same posture extends
to the cdk-nag snapshots described below — they read from the same
template, so non-deterministic logical IDs would invalidate the
snapshot on every run.

These rules align with the
[determinism rules](../02-monorepo-layout.md#determinism-rules) in
the monorepo layout doc; this section restates them for CDK
snapshot tests specifically.

**cdk-nag is wired in as a snapshot-asserted dev dependency.** Each
construct test synthesises a throwaway stack, applies
`AwsSolutionsChecks` via `Aspects.of(...)`, captures the resulting
warnings/errors, and snapshots them. The snapshot serves two
purposes:

1. **Regression catch.** If a future change to the construct
   accidentally regresses a nag rule (e.g., removes a default
   encryption flag), the snapshot diff surfaces it in CI.
2. **Documentation of intentional violations.** Where the construct
   knowingly violates a nag rule (e.g., AwsSolutions-DDB3 vs the
   default-on PITR posture), the snapshot is the explicit record of
   "we accept this." Consumers can grep the snapshot to understand
   the trade-offs.

cdk-nag noise on consumer-side stacks remains the consumer's
concern; foundation-cdk does not auto-apply the aspect to the
consumer's app.

## Conventions

- **Each construct's `lib/<name>/index.ts` re-exports its class and
  props type.** No deep imports across constructs; the barrel is
  the public surface.
- **Constructs accept an optional `alarmTopic?: sns.ITopic`.** When
  unset, alarms are created but have no action wired — the consumer
  can attach actions later via `Aspects.of(...)`. Same shape as
  trellis's existing constructs.
- **Removal policy defaults to `RETAIN`** on stateful resources
  (DynamoDB tables, SQS queues). Inertia bias: easier to manually
  delete than to recreate.
- **Errors are `Error` subclasses named per construct**
  (`NodejsLambdaPropsError`, etc.), thrown synchronously in the
  constructor when prop validation fails. Synth-time errors are
  more useful than deploy-time failures.

## Open questions

- **`alarmTopic` global vs per-alarm?** Trellis passes one topic to
  the construct and wires every alarm to it. A consumer might want
  a different topic for write-spike vs throttle (e.g., pager vs
  Slack). Two ways: add per-alarm topic overrides (verbose), or
  expose the alarm constructs as public readonly properties so the
  consumer can rewire them after construction. Lean toward the
  latter — composable, no API growth.
- **Should `NodejsLambda` extend `NodejsFunction` (trellis) or
  contain one (composition)?** Trellis extends. CDK community
  generally prefers composition. Extension makes
  `someLambda.addEventSource(...)` work without proxying.
  Composition is cleaner. Decide in implementation; the prop shape
  is the same either way.
- **Should the dashboard templates be CDK constructs or JSON
  assets?** Currently planned as JSON assets with a substitution
  helper (lower commitment, easier to swap). Constructs are more
  type-safe but a larger v0.1 surface. Revisit after the first
  consumer adopts.
