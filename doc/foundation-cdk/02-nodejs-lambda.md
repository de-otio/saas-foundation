# 02 — NodejsLambda

The `NodejsLambda` construct. A `NodejsFunction` with house defaults:
ARM64, X-Ray active tracing, 30-day log retention, optional Prisma
client bundling, and attached error/throttle alarms wired to an
optional SNS topic.

Source pattern: `trellis/infra/lib/constructs/nodejs-lambda.ts`.
The foundation-cdk version removes the trellis source-path hardcode
(trellis's version reads from `@de-otio/trellis/dist/lambda`); foundation-cdk
accepts `entry` as a path the consumer owns. The foundation-cdk version
also makes `reservedConcurrentExecutions` optional (see § Reserved
concurrency and the unreserved floor below).

## Why a house wrapper instead of raw `NodejsFunction`

CDK's `NodejsFunction` is sound but ergonomically thin. Every house
consumer ends up repeating the same boilerplate:

- ARM64 architecture (up to 34% better price-performance per the
  AWS Graviton2 benchmarks — see [Lambda Graviton2 announcement](https://aws.amazon.com/blogs/aws/aws-lambda-functions-powered-by-aws-graviton2-processor-run-your-functions-on-arm-and-get-up-to-34-better-price-performance/)).
- X-Ray tracing enabled.
- Log retention set (CDK default is "never expire" → unbounded CloudWatch
  Logs cost growth).
- Error alarm + throttle alarm + duration alarm.

A house wrapper makes these default-on. Reserved concurrency is
_configured_ by the construct surface but not mandatory — see
[§ Reserved concurrency and the unreserved floor](#reserved-concurrency-and-the-unreserved-floor).

## Props

```typescript
import type { Duration } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";

export interface NodejsLambdaProps {
  /**
   * Absolute path to the entry file. The consumer owns this path —
   * foundation-cdk does not assume a particular source layout.
   *
   * Typical pattern:
   *   entry: path.join(__dirname, '../../lambda/hourly-cron.ts'),
   */
  entry: string;

  /**
   * Exported handler name. Default 'handler'.
   */
  handler?: string;

  /**
   * Physical Lambda function name. Required (not optional) because
   * downstream wiring — Grafana dashboard dimensions, EventBridge
   * rule targets, alarm dimensions — references the function by
   * physical name; auto-generated names invalidate downstream
   * references on every deploy. Knowing deviation from CDK's
   * "use generated names" guidance; see § Naming and CDK guidance.
   */
  functionName: string;

  /**
   * Reserved concurrent executions. Optional.
   *
   * - Unset (default): the function uses the account's unreserved
   *   concurrency pool.
   * - Set to a positive number: caps the function at that value AND
   *   reserves that capacity for it, removing it from the
   *   unreserved pool.
   *
   * IMPORTANT: AWS requires at least 100 units of unreserved
   * concurrency to remain in the account. The sum of every reserved
   * value across every function in the account cannot exceed
   * `accountQuota - 100`. Deploys that violate the floor fail at
   * CloudFormation apply with a non-obvious error.
   *
   * Guidance:
   * - For critical functions whose throttling would be load-bearing
   *   for downstream protection (e.g., a write to a 3rd-party API
   *   with a strict QPS limit), set this.
   * - For most functions (crons, admin endpoints, internal-API
   *   handlers), leave it unset and let the account pool absorb
   *   traffic.
   * - If many functions need caps, raise the account-level
   *   concurrency quota first; do not pack the existing 1000-unit
   *   default with reservations.
   */
  reservedConcurrentExecutions?: number;

  environment?: Record<string, string>;
  memorySize?: number; // default 256
  timeout?: Duration; // default 30s

  role?: iam.IRole;
  vpc?: NodejsFunctionProps["vpc"];
  vpcSubnets?: NodejsFunctionProps["vpcSubnets"];
  securityGroups?: NodejsFunctionProps["securityGroups"];
  logGroup?: NodejsFunctionProps["logGroup"];
  layers?: lambda.ILayerVersion[];

  /**
   * Optional KMS key for CloudWatch Logs encryption. When unset, log
   * groups created by CDK are encrypted with the AWS-managed CloudWatch
   * key (adequate for most workloads). Set this for EU-residency or
   * customer-managed-key compliance postures.
   */
  logsEncryptionKey?: kms.IKey;

  /**
   * CloudWatch Logs storage class for the construct-created log group.
   *
   * - 'standard' (default): full Logs Insights query throughput.
   * - 'infrequent-access': storage is roughly half the price of
   *   Standard, with the trade-off that Logs Insights queries cost
   *   more per scanned GB. Pick this for log streams that are
   *   written constantly but queried rarely (audit, bounce-handler,
   *   security-event streams).
   *
   * Ignored when `logGroup` is set (the consumer's pre-created group
   * carries its own class).
   */
  logClass?: "standard" | "infrequent-access";

  /**
   * SNS topic for alarm actions. When set, the construct's
   * error / throttle / duration alarms wire to this topic. When unset,
   * alarms are still created but have no action — the consumer can
   * attach actions later via the construct's public alarm properties.
   */
  alarmTopic?: sns.ITopic;

  /**
   * Disable specific alarms. Default: all three alarms enabled.
   * Setting an entry to false skips that alarm (it is not created).
   */
  alarms?: {
    errors?: boolean;
    throttles?: boolean;
    duration?: boolean;
  };

  /**
   * Acknowledge that this function runs in a VPC without an X-Ray
   * VPC interface endpoint configured. By default the construct
   * fails synth when `vpc` is set and X-Ray ACTIVE (the construct
   * default) is paired without a documented X-Ray reachability
   * path — silent X-Ray trace drops are a debug-the-debugger
   * failure mode. Set to true to suppress the check if you have
   * verified reachability via another route (NAT egress, separate
   * VPC endpoint configured outside the construct).
   *
   * @default false
   */
  acknowledgeXrayVpcReachability?: boolean;

  /**
   * Bundle Prisma client + Linux query engines into the Lambda zip.
   * When set, esbuild externalises `@prisma/client` and afterBundling
   * commands copy `node_modules/.prisma/client` + engines into the
   * output dir.
   *
   * Default: disabled. Consumers who don't use Prisma pay nothing.
   */
  prismaBundling?: PrismaBundlingOptions | true;

  /**
   * Additional modules to mark as external in esbuild. Always
   * includes `@aws-sdk/*` (provided by the Lambda runtime).
   *
   * Common: 'sharp', '@prisma/client' (when prismaBundling is set).
   */
  externalModules?: string[];
}

export interface PrismaBundlingOptions {
  /**
   * Engines to copy. Default: both rhel and linux-arm64 (ARM64 is
   * the construct default, but rhel covers Node.js layers and
   * tooling that may run elsewhere).
   */
  engines?: Array<"rhel" | "linux-arm64" | "darwin" | "darwin-arm64">;
}
```

## Class shape

```typescript
import { Construct } from "constructs";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";

export class NodejsLambda extends NodejsFunction {
  public readonly errorAlarm?: cloudwatch.Alarm;
  public readonly throttleAlarm?: cloudwatch.Alarm;
  public readonly durationAlarm?: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: NodejsLambdaProps) {
    // ... merge house defaults, configure bundling, super(), wire alarms
  }

  /**
   * Add a CloudWatch alarm on the SQS event source's iterator age —
   * the canonical "queue consumer is falling behind" signal. Pair
   * with {@link QueueWithDlq}; the DLQ alarm tells you the consumer
   * gave up, this one tells you it's struggling.
   *
   * Default threshold: 5 minutes. Workload-dependent; override based
   * on the consumer's SLO.
   */
  public addQueueIteratorAgeAlarm(
    queue: sqs.IQueue,
    opts?: { thresholdMinutes?: number; alarmTopic?: sns.ITopic },
  ): cloudwatch.Alarm;
}
```

Subclassing `NodejsFunction` (rather than wrapping in a `Construct`)
matches trellis's existing pattern and lets consumers call
`fn.addEventSource(...)`, `fn.grantInvoke(...)` etc. without proxying.
The public alarm properties give the consumer a hook to re-target
specific alarms after construction without re-running prop validation.

## House defaults

| Setting                    | Value                                | Rationale                                                                                                                                                                                                                  |
| -------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime`                  | `lambda.Runtime.NODEJS_24_X`         | Node 24 is the longest-supported Lambda LTS at v0.1 (released Nov 2025, supported until Apr 2028). Bumped per Lambda Node LTS release cadence (~18 months); see [§ Node LTS rotation cadence](#node-lts-rotation-cadence). |
| `architecture`             | `lambda.Architecture.ARM_64`         | Up to 34% better price-performance vs x86_64 (19% perf + 20% cost) per AWS Graviton2 benchmarks.                                                                                                                           |
| `tracing`                  | `lambda.Tracing.ACTIVE`              | X-Ray traces every invocation. Free below 100k traces / month account-wide; see [§ X-Ray cost disclosure](#x-ray-cost-disclosure).                                                                                          |
| `memorySize`               | 256 MB                               | Conservative default; see [§ Memory right-sizing](#memory-right-sizing) for the AWS Lambda Power Tuner workflow.                                                                                                           |
| `timeout`                  | 30 seconds                           | Short enough that hung requests fail fast; consumers override for long-running jobs.                                                                                                                                       |
| `bundling.externalModules` | `['@aws-sdk/*']`                     | Lambda runtime provides v3 SDK; bundling it bloats the zip and shadows the runtime version.                                                                                                                                |
| Log group retention        | 30 days                              | Bounded growth. Consumers override via `logGroup` prop for longer retention. See [§ Log-retention and log-class policy](#log-retention-and-log-class-policy).                                                              |
| Log group class            | Standard (override via `logClass`)   | `'infrequent-access'` is ~50% cheaper for write-heavy, query-rare streams (audit, bounce-handler). See [§ Log-retention and log-class policy](#log-retention-and-log-class-policy).                                        |
| Log group encryption       | AWS-managed CloudWatch key (default) | Adequate for most workloads. Override via `logsEncryptionKey` for EU-residency / CMK postures.                                                                                                                             |
| `logRetentionRole`         | inferred                             | If the consumer doesn't pre-create the log group, CDK creates it with the retention set.                                                                                                                                   |

## Recurring cost

`NodejsLambda` is a paid-by-default construct under the
[paid-by-default disclosure axiom](../01-scope-and-philosophy.md#design-principles)
([`01-scope-and-philosophy.md:165`](../01-scope-and-philosophy.md)):
the house defaults enable CloudWatch alarms, X-Ray tracing, and a CDK-
created log group, all of which carry per-resource billing on top of
the standard Lambda invocation cost. This section names the line items
so the cost is discoverable without reading AWS pricing pages.

### Per-construct billing items

| Item                       | Default                                | Order-of-magnitude (`eu-west-1`, May 2026)                                                                                                                                                                                                  |
| -------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CloudWatch alarms          | 3 per Lambda (error, throttle, duration) | $0.10 / standard-resolution alarm / month → **~$0.30 / Lambda / month**.                                                                                                                                                                  |
| CloudWatch Logs ingestion  | log group with 30-day retention        | $0.50 / GB ingested; the construct does not cap ingestion. Volume depends on the function's logging level and call rate.                                                                                                                  |
| CloudWatch Logs storage    | Standard log class                     | $0.03 / GB / month Standard; ~$0.0166 / GB / month Infrequent Access. IA query cost is materially higher per scanned GB — see `logClass` prop and § Log-retention and log-class policy.                                                   |
| X-Ray tracing              | `tracing: ACTIVE`                       | Free below 100k traces / month account-wide; $5 / million traces past the free tier. See § X-Ray cost disclosure.                                                                                                                          |

### Worked example: a representative 10-Lambda stack

For a consumer stack with **10 NodejsLambdas** at house defaults:

- **Alarms**: 10 × 3 = 30 alarms × $0.10 ≈ **$3.00 / month**.
- **X-Ray**: 0 / month below the 100k-trace account free tier;
  ≈ $5 / month per additional million traces.
- **Logs ingestion + storage**: workload-dependent; a noisy `info`-level
  consumer logging 1 GB / month / function costs ≈ $5 / month ingestion
  + ≈ $0.30 / month storage at Standard class. Same volume on
  Infrequent Access drops storage to ≈ $0.17 / month — a small absolute
  saving at this volume, but the saving grows linearly with retention.
  Worth flipping IA on for audit / bounce-handler streams that
  accumulate over months and are queried rarely.

Combined recurring cost of the cross-cutting AWS features the
construct enables: **≈ $3 / month / 10 Lambdas** plus log volume. The
alarms are the dominant fixed cost; the optimisation lever for
larger fleets is `logClass: 'infrequent-access'` on log streams that
fit the write-heavy / read-rare profile.

### Memory right-sizing

The 256 MB default is a reasonable starting point for cold-startable
event handlers, crons, and low-RPS API handlers. Two reasons it is
not always right:

- **Hot-path / latency-sensitive functions.** Lambda CPU scales
  linearly with memory up to ~1769 MB (one full vCPU). For
  CPU-bound or cold-start-sensitive code, 512 MB or 1024 MB is often
  *cheaper per invocation* than 256 MB because the function
  completes in less than half the wall-clock time. The billing
  model — `GB-seconds` — rewards faster invocations at higher
  memory.
- **Memory-bound work.** Image manipulation, large JSON parses,
  Prisma client init, and AWS-SDK v3 client trees all benefit from
  more headroom; tight memory triggers GC pressure and slower
  cold starts.

The canonical right-sizing tool is **[AWS Lambda Power Tuner](https://github.com/alexcasalboni/aws-lambda-power-tuning)**
(state-machine driven; runs the function across a memory grid,
plots cost vs latency, picks the optimum). For the AWS-side
documentation see
[Lambda configuration → memory](https://docs.aws.amazon.com/lambda/latest/dg/configuration-function-common.html).

**Practical default**: keep 256 MB for crons / admin endpoints / low-RPS
handlers, run Power Tuner for any function that is on a user-facing
hot path or that processes more than a few thousand invocations per
hour. Override via `memorySize` once the tuner picks a value.

### X-Ray cost disclosure

`tracing: ACTIVE` is the construct default (see § House defaults).
X-Ray pricing:

- **Free below 100k traces / month** across the whole AWS account.
- **$5 per million traces** above the free tier.
- Trace **storage** is metered separately (~$0.50 per million traces
  per month, first 30 days included). Most consumers never see this.

At magic-link-auth-site volumes (a handful of trace-producing
Lambdas, low-thousands of invocations per day) the free tier
absorbs everything and X-Ray is effectively free. For high-RPS
data-plane Lambdas — millions of invocations per day, every one
traced — X-Ray cost is **material** and should be sampled or
disabled. Override via the existing `tracing` prop on the
underlying `NodejsFunctionProps`, or pass a sampling rule via the
function's role / config.

The default is ACTIVE because production debugging speed is the
load-bearing concern at the project's current scale; disable when
volume justifies it.

### Log-retention and log-class policy

The project ships three different log-retention defaults across
its constructs, and the heterogeneity is intentional:

- **Standard 30-day retention** for app-code Lambdas
  (`NodejsLambda`, this construct). 30 days covers nearly every
  post-incident review window without producing unbounded
  CloudWatch Logs storage growth.
- **`logClass: 'infrequent-access'`** for audit / security /
  compliance log streams that are written constantly but queried
  rarely (e.g. `audit`, `bounce-handler`, security-event handlers).
  Storage is ~50% cheaper than Standard with the trade-off that
  Logs Insights queries cost more per scanned GB. Wire this prop
  through where the access pattern fits; otherwise leave it at
  Standard.
- **Shorter retention (1–7 days)** for Lambda@Edge and other
  edge-replicated log groups that cannot be effectively queried
  anyway — L@E writes logs into the *replica region* per request,
  so cross-region queries are operationally impractical. Edge
  constructs ship 1-day retention by design.

This policy unifies the per-construct retention defaults the
cost-pillar review flagged: app code keeps 30 days, audit streams
opt into IA, edge log groups keep 1 day.

When a consumer wants different retention or class on a specific
Lambda, the construct's `logGroup` prop accepts a pre-created
`LogGroup` and bypasses the construct's defaults entirely.

## Reserved concurrency and the unreserved floor

AWS Lambda enforces a hard floor: **at least 100 units of unreserved
concurrency must remain in the account at all times**
([Lambda reserved-concurrency docs](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html)).
The sum of every reserved value across every function in the account
cannot exceed `accountQuota - 100`. The default account quota is
1000 in most regions; deploys that violate the floor fail at
CloudFormation apply with `ReservedConcurrentExecutions for function
… exceeds account's UnreservedConcurrentExecution limit`.

Foundation-cdk makes `reservedConcurrentExecutions` **optional** to
avoid the trap. The previous trellis-style "every Lambda must have
a cap" discipline survives as a project-level review rule, not a
construct-level enforcement:

- An unset value (the construct default) means the function shares
  the account's unreserved pool. Throttles still appear under
  `throttleAlarm` if the account-wide pool is exhausted.
- A set value reserves capacity _and_ caps the function. Use this
  when (a) the function calls a downstream with a strict QPS limit
  (caps protect the downstream), or (b) the function must be
  guaranteed capacity even when the rest of the account is busy
  (reservation protects the function).
- For most functions, neither (a) nor (b) applies — leave it unset.

If the consumer's account approaches the floor (sum of reservations
≈ quota - 100), the right move is a quota raise via Service Quotas,
not packing more reservations into the existing budget.

A future Aspect (`AccountReservationBudgetAspect`) could sum
reservations across a stack and warn at synth when the running total
crosses an envelope. v0.1 doesn't ship it — the floor is a single
documentable constant, and the cost of getting it wrong (deploy-time
failure with an explicit error) is bounded.

## Naming and CDK guidance

CDK's general best-practice is to **let CDK generate physical
names**, so resources can be replaced without invalidating downstream
references. `NodejsLambda` deviates: `functionName` is required, and
the underlying L2 honours it.

The trade-off is deliberate. Downstream wiring — Grafana dashboards
keyed on Lambda function name, EventBridge rule targets, IAM policy
references that pin to ARNs, observability tooling that filters by
function-name dimension — all break when CDK regenerates the name on
replacement. For a house construct used across long-lived consumer
deployments, predictability outweighs the replace-friendliness of
auto-naming.

Two consequences the consumer must know:

- **The physical name must be globally unique within the account+region.**
  Two stacks deploying the same function name in the same region
  collide. Stage/env prefix every name (e.g.,
  `${appName}-${stage}-${role}`).
- **Renaming a function in code is a destructive change.** CloudFormation
  replaces it (delete-then-create), and any in-flight invocations on
  the old ARN fail.

Alarm names are **not** keyed on `functionName` — the construct lets
CDK auto-generate alarm names (logical-ID-derived) to avoid the same
cross-stack collision risk on the alarm namespace.

## Node LTS rotation cadence

The Node version is pinned in the construct (not `Runtime.NODEJS_LATEST`)
so consumers control runtime changes via foundation-cdk version
upgrades rather than implicit CDK-side LATEST drift. Trade-off: roughly
one minor version bump every ~18 months as Lambda adds the next Node
LTS and the current pin approaches EOL.

| Date          | Action                                               |
| ------------- | ---------------------------------------------------- |
| 2026-05 (now) | Pinned to `NODEJS_24_X` (supported until Apr 2028)   |
| ~2027-04      | Lambda likely adds NODEJS_26_X; consider bumping.    |
| ~2028-04      | NODEJS_24_X EOL; must bump (already on 26 or later). |

The bump is a single-line change in the construct + a foundation-cdk
minor release. Consumers cascade by bumping the foundation-cdk
dependency; existing deployed Lambdas continue on their prior runtime
until next deploy.

## Prisma bundling

Opt-in via `prismaBundling`. The construct merges in a bundling block
with `commandHooks.afterBundling` that copies the Prisma generated
client + engine binaries into the Lambda zip:

```typescript
afterBundling: (inputDir, outputDir) => {
  const engineFlags = (opts.engines ?? ["rhel", "linux-arm64"]).map(
    (e) =>
      `cp ${inputDir}/node_modules/.prisma/client/libquery_engine-${e}* ${outputDir}/node_modules/.prisma/client/ 2>/dev/null || true`,
  );
  return [
    `mkdir -p ${outputDir}/node_modules/.prisma/client`,
    `mkdir -p ${outputDir}/node_modules/@prisma`,
    `cp -r ${inputDir}/node_modules/@prisma/client ${outputDir}/node_modules/@prisma/client`,
    `cp ${inputDir}/node_modules/.prisma/client/index.js ${outputDir}/node_modules/.prisma/client/`,
    `cp ${inputDir}/node_modules/.prisma/client/default.js ${outputDir}/node_modules/.prisma/client/`,
    `cp ${inputDir}/node_modules/.prisma/client/schema.prisma ${outputDir}/node_modules/.prisma/client/ 2>/dev/null || true`,
    ...engineFlags,
  ];
};
```

`@prisma/client` is added to the externals list when this option is
set, so esbuild doesn't inline it.

## Synth-time validations

In addition to standard CDK prop validation, the constructor enforces
two house-specific synth-time checks:

### X-Ray reachability in VPC

If `vpc` is set and `tracing` resolves to `ACTIVE` (the construct
default) and `acknowledgeXrayVpcReachability !== true`, the construct
throws at synth with a clear error pointing to the [X-Ray VPC
interface endpoint](https://docs.aws.amazon.com/xray/latest/devguide/xray-services-vpc.html)
pattern.

Reason: an X-Ray-enabled Lambda inside a private subnet with no NAT
egress and no `com.amazonaws.{region}.xray` interface endpoint
silently drops traces. The function still runs; traces just never
appear in X-Ray. Operators discover the gap only when they need a
trace to debug an issue, and by then the relevant traces are gone.

The escape hatch (`acknowledgeXrayVpcReachability: true`) exists
because the construct can't always detect NAT-via-default-subnet or
out-of-construct VPC-endpoint configuration. The default is to fail
loudly; consumers who know they have reachability suppress the
check explicitly.

### Reserved-concurrency presence

The construct does **not** validate the sum of reservations against
the unreserved floor. That check would require walking the construct
tree at synth, which is non-trivial and arguably belongs in an
Aspect. See [§ Reserved concurrency and the unreserved floor](#reserved-concurrency-and-the-unreserved-floor)
for the rationale and the deferred `AccountReservationBudgetAspect`.

## Alarms

Three alarms, all created by default, all opt-out-able. Each is a
public readonly property so the consumer can attach additional
actions after construction. Alarm names are CDK-auto-generated
(logical-ID-derived) to avoid the cross-stack collision risk on the
alarm namespace; only the `alarmDescription` is house-defined.

### `errorAlarm`

```
metric:          Errors (Sum, 5 minutes)
threshold:       5
evaluationPeriods: 1
treatMissingData: NOT_BREACHING
```

Fires when a Lambda errors more than 5 times in 5 minutes. Tuned to
avoid noise on background-task retry storms; consumer overrides via
the public property if a tighter threshold matters for their function.

### `throttleAlarm`

```
metric:          Throttles (Sum, 1 minute)
threshold:       1
evaluationPeriods: 1
treatMissingData: NOT_BREACHING
```

Any throttle is a signal — the function hit its reserved-concurrency
cap. Either traffic exceeded the planned headroom or another Lambda
is consuming the unreserved pool. Direct port of trellis's
`addThrottleAlarm`.

### `durationAlarm`

```
metric:          Duration (p99, 5 minutes)
threshold:       0.8 × timeout
evaluationPeriods: 2
treatMissingData: NOT_BREACHING
```

Fires when the p99 duration is consistently within 20% of the timeout.
Early signal that the timeout will start being hit; lets the consumer
tune memory / code before the timeout-related Errors fire.

## Removal posture

`NodejsLambda` does not set a `removalPolicy` — Lambdas are stateless,
the default `DESTROY` is correct. Log groups created by CDK inherit
the retention setting; if a consumer needs the log group preserved
across stack delete/recreate cycles, they pre-create it and pass it
in via `logGroup`.

## Open questions

- **Should the duration-alarm percentile be configurable?** Currently
  hardcoded to p99. Some consumers may want p95 for latency-sensitive
  user-facing paths. Add a prop if a second consumer asks.
- **`bundling.minify`?** CDK default is false; trellis doesn't set it.
  Minification helps cold-start size; readability of CloudWatch error
  traces suffers. Defer to the consumer (no construct opinion).
- **`AccountReservationBudgetAspect`?** Walk the construct tree at
  synth, sum reserved-concurrency values, warn when the sum crosses
  `accountQuota - 100`. Not v0.1; the deploy-time error is bounded.
  Worth revisiting if a consumer hits the floor in practice.
