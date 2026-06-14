# 04 — SingleTable

The `SingleTable` construct. A DynamoDB table provisioned for the
single-table design pattern: `pk`/`sk` composite primary key, one
GSI (`gsi1pk`/`gsi1sk`), point-in-time recovery on by default,
TTL attribute `ttl`, and read/write-spike alarms.

Source pattern: `trellis/infra/lib/constructs/single-table.ts`.

## Why a house wrapper instead of raw `dynamodb.Table`

Single-table is the house DynamoDB pattern. Every backend that picks
DynamoDB ends up with the same five decisions:

- Composite primary key (`pk` / `sk`) — not partition-only.
- One GSI for reverse lookups (`gsi1pk` / `gsi1sk`), `ProjectionType.ALL`.
- `BillingMode.PAY_PER_REQUEST` (on-demand) — predictable cost for
  variable traffic, no capacity planning until proven necessary.
- AWS-managed encryption.
- Point-in-time recovery enabled.
- TTL attribute set (`ttl`), so the table doesn't need to be
  redesigned later if a column wants expiry semantics.
- Removal policy `RETAIN` (stateful resource).

The construct bakes these in. A consumer who wants something
different uses `dynamodb.Table` directly — single-table is opinionated
by name.

## Props

```typescript
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as sns from "aws-cdk-lib/aws-sns";

export interface SingleTableProps {
  /**
   * Physical table name. Required for downstream wiring (Grafana
   * dashboards, IAM policies, observability filters). Same trade-off
   * as NodejsLambda — see that doc's "Naming and CDK guidance" section.
   */
  tableName: string;

  /**
   * Alarm topic for the read/write-spike alarms. Optional.
   */
  alarmTopic?: sns.ITopic;

  /**
   * Removal policy. Default RETAIN (stateful resource).
   * Consumers building ephemeral envs may pass DESTROY explicitly.
   */
  removalPolicy?: cdk.RemovalPolicy;

  /**
   * Enable point-in-time recovery. Default: true.
   *
   * COST: PITR is billed continuously by table size (including LSIs).
   * As of 2026-05 the rate is roughly $0.20/GB-month in us-east-1, so
   * a steady-state 100 GB table costs ~$20/month indefinitely while
   * PITR is enabled. The default-on posture is intentional — data-loss
   * cost dominates PITR cost in almost every case — but consumers
   * running ephemeral / non-production tables should opt out.
   *
   * See https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/PointInTimeRecovery_Howitworks.html
   */
  pointInTimeRecovery?: boolean;

  /**
   * PITR recovery window in days. Range 1–35; default 7.
   *
   * 7 days covers the "noticed corruption on Monday, it started
   * over the weekend" scenario and is the conventional starting
   * point. PITR billing scales with table size and the retention
   * window — a 35-day window costs roughly 5× more on the PITR line
   * than a 7-day window for an identical table. Override to 35 for
   * compliance regimes that mandate a longer window. A synth-time
   * annotation fires when this value exceeds 14.
   *
   * Ignored when pointInTimeRecovery is false.
   */
  pointInTimeRecoveryDays?: number;

  /**
   * Include the canonical reverse-lookup GSI (gsi1pk / gsi1sk,
   * ALL projection). Default: true.
   *
   * COST: GSI roughly doubles write cost (every base-table write
   * propagates to the index) and adds storage proportional to the
   * indexed item set. Consumers who haven't yet designed an access
   * pattern that uses gsi1 should opt out at table-creation time;
   * dropping a GSI from a populated table later requires draining
   * the index and is non-trivial.
   *
   * Set this true (default) when the consumer plans to use GSI1 from
   * day one. Set false for "single-table with no reverse-lookup yet"
   * — fully removable as a future CDK change (DDB supports
   * `CreateGlobalSecondaryIndexAction`, though backfill against a
   * large table is slow).
   */
  enableGsi1?: boolean;

  /**
   * Enable DynamoDB Streams. Optional.
   *
   * Set this when downstream consumers (Lambda triggers, Kinesis
   * pipelines) need change-data-capture. The value is the stream
   * view type; NEW_AND_OLD_IMAGES is the most common choice.
   *
   * The construct does not provision the consumer Lambda; the
   * consumer composes that themselves via
   * `table.tableStreamArn` and an SqsEventSource / DynamoEventSource.
   */
  stream?: dynamodb.StreamViewType;

  /**
   * Write-spike alarm threshold in WCU/min (Sum statistic).
   * Default: 200.
   *
   * Reason: a sustained spike above 200 WCU/min on an on-demand table
   * usually signals a runaway loop, not legitimate traffic. The
   * threshold should be raised once the consumer has a baseline.
   */
  writeSpikeThreshold?: number;

  /**
   * Read-spike alarm threshold in RCU/min (Sum statistic).
   * Default: 500.
   */
  readSpikeThreshold?: number;

  /**
   * Disable specific alarms. Default: both enabled.
   */
  alarms?: {
    writeSpike?: boolean;
    readSpike?: boolean;
  };
}
```

The construct intentionally **does not** expose props for:

- Partition / sort key names. They are `pk` and `sk`. The pattern
  is the value.
- GSI count beyond GSI1, or GSI attribute names. One optional GSI,
  named `gsi1`, with `gsi1pk` and `gsi1sk`. If you need more, use
  `dynamodb.Table` directly.
- Billing mode. On-demand. If you need provisioned, this construct
  is not for you.
- Encryption mode. AWS-managed. KMS-managed (customer-managed key)
  is a v0.2 add when a compliance use case appears.

This is the construct's identity: "the de-otio house single-table."

## Class shape

```typescript
import { Construct } from "constructs";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";

export class SingleTable extends Construct {
  public readonly table: dynamodb.Table;
  public readonly writeSpikeAlarm?: cloudwatch.Alarm;
  public readonly readSpikeAlarm?: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: SingleTableProps) {
    super(scope, id);
    // ... table + GSI1 + alarms
  }
}
```

`Construct` (not `Table`) because the construct owns the table +
alarms, and consumers reach for `st.table.grantReadData(...)`
naturally.

## House defaults

| Setting                        | Value                                       | Rationale                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Partition key                  | `{ name: 'pk', type: STRING }`              | Single-table convention.                                                                                                                                                                              |
| Sort key                       | `{ name: 'sk', type: STRING }`              | Single-table convention.                                                                                                                                                                              |
| Billing mode                   | `PAY_PER_REQUEST` (on-demand)               | No capacity planning until proven necessary.                                                                                                                                                          |
| TTL attribute                  | `ttl`                                       | Reserved for expiry use cases without table redesign.                                                                                                                                                 |
| Encryption                     | `AWS_MANAGED`                               | Turn-key compliance baseline.                                                                                                                                                                         |
| PITR                           | enabled (7-day window)                      | Continuously billed by table size (~$0.20/GB-month in us-east-1); default-on because data-loss cost dominates. Opt out via `pointInTimeRecovery: false`; change window via `pointInTimeRecoveryDays`. Synth annotation fires when window > 14. |
| Removal policy                 | `RETAIN`                                    | Stateful. Manual deletion required.                                                                                                                                                                   |
| GSI1 (when `enableGsi1: true`) | `{ pk: 'gsi1pk', sk: 'gsi1sk', proj: ALL }` | Reverse-lookup pattern. `ALL` projection covers most access patterns at the cost of double write throughput on indexed items. Opt-out for "no reverse-lookup yet" consumers; GSI can be added later.  |
| Streams                        | disabled                                    | Opt in via `stream` prop when downstream CDC consumers exist.                                                                                                                                         |

Alarm names are CDK-auto-generated (logical-ID-derived); only the
`alarmDescription` is house-defined. Same posture as
[NodejsLambda](02-nodejs-lambda.md#alarms) — avoids cross-stack
collisions on the alarm namespace.

## Alarms

### `writeSpikeAlarm`

```
metric:    ConsumedWriteCapacityUnits (Sum, 1 minute)
threshold: 200 (configurable via writeSpikeThreshold)
comparison: GREATER_THAN_THRESHOLD
evaluationPeriods: 2
treatMissingData: NOT_BREACHING
alarmName: CDK auto-generated (no explicit name)
```

Two-minute sustained signal. The threshold is conservative for a
new table; consumers raise it after observing a real-traffic baseline.

### `readSpikeAlarm`

```
metric:    ConsumedReadCapacityUnits (Sum, 1 minute)
threshold: 500 (configurable via readSpikeThreshold)
comparison: GREATER_THAN_THRESHOLD
evaluationPeriods: 2
treatMissingData: NOT_BREACHING
```

Same shape, different threshold. Read spikes are usually less
catastrophic than write spikes (no data corruption risk) but
worth visibility.

Trellis's existing read-spike alarm is identical; this construct
brings both alarms in by default (trellis's `SingleTable` constructor
also creates both; the file's comment "Read spike alarm (previously
missing)" suggests it was a later addition).

## Cross-construct composition

`SingleTable` and `NodejsLambda` compose for the common request-path
pattern:

```typescript
const usersTable = new SingleTable(this, "UsersTable", {
  tableName: "app-users",
  alarmTopic,
});

const userApi = new NodejsLambda(this, "UserApi", {
  entry: path.join(__dirname, "../lambda/user-api.ts"),
  functionName: "app-user-api",
  // reservedConcurrentExecutions optional — leave unset to share
  // the account's unreserved pool; set it only to protect a
  // downstream or guarantee capacity. See NodejsLambda § Reserved
  // concurrency and the unreserved floor.
  environment: { USERS_TABLE: usersTable.table.tableName },
  alarmTopic,
});

usersTable.table.grantReadWriteData(userApi);
```

## Migration from trellis

The trellis `SingleTable` is a near-direct port. The differences:

- Foundation-cdk exposes `writeSpikeThreshold` and `readSpikeThreshold`
  as props (trellis hardcodes 200 / 500).
- Foundation-cdk exposes the alarms as public properties (trellis
  doesn't, but the consumer rarely needs to re-target them).
- Foundation-cdk's `removalPolicy` defaults the same (`RETAIN`).
- Foundation-cdk does not export the underlying `Table` via a
  `getter` — `st.table` is a plain readonly property.
- Foundation-cdk exposes `pointInTimeRecovery`,
  `pointInTimeRecoveryDays`, `enableGsi1`, and `stream` as props;
  trellis hardcodes them (PITR on, GSI1 always, no streams).

Trellis's cutover (after foundation-cdk 0.1.0 ships): one PR replaces
`import { SingleTable } from '../constructs/single-table'` with
`import { SingleTable } from '@de-otio/saas-foundation-cdk/table'`,
keeps the construct call sites unchanged, deletes the local file.

## Cost disclosure summary

Per the [paid-by-default cost-disclosure
principle](../01-scope-and-philosophy.md#design-principles), the
default-on paid features in this construct:

| Feature    | Default     | Cost shape                                                                                                                                           | Opt-out                      |
| ---------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| PITR       | enabled     | Billed by table size × retention window (~$0.20/GB-month per 7-day increment in us-east-1 as of 2026-05). A 10 GB table at 7-day window ≈ $2/mo; same table at 35-day window ≈ $10/mo. | `pointInTimeRecovery: false` |
| GSI1       | enabled     | Roughly doubles write throughput cost; storage proportional to indexed item count.                                                                   | `enableGsi1: false`          |
| Encryption | AWS_MANAGED | Free                                                                                                                                                 | n/a                          |

Streams (opt-in) and KMS encryption (v0.2, opt-in) when added will
follow the same disclosure shape.

## Recurring cost

Per the [paid-by-default disclosure axiom](../01-scope-and-philosophy.md#design-principles),
every construct that creates per-resource billable AWS resources must
state the cost order-of-magnitude here.

### PITR (continuous backup)

PITR billing scales with table size and the configured retention window.
The charge is approximately $0.20/GB-month per 7 days of retention in
us-east-1 (verify current rates at
[aws.amazon.com/dynamodb/pricing](https://aws.amazon.com/dynamodb/pricing/)).

Worked example for a 10 GB table:

| Window          | Approximate monthly PITR cost |
| --------------- | ----------------------------- |
| 7 days (default) | ~$2/mo                       |
| 14 days          | ~$4/mo                       |
| 35 days          | ~$10/mo                      |

The default is 7 days (cost-pillar review S3). Override via
`pointInTimeRecoveryDays`. A synth-time annotation fires when the value
exceeds 14 to make the cost choice visible in `cdk synth` output.

To opt out entirely (ephemeral / non-production tables only):
`pointInTimeRecovery: false`.

### CloudWatch alarms

Each `SingleTable` creates 2 CloudWatch alarms by default:

- `writeSpikeAlarm` — ConsumedWriteCapacityUnits spike detector.
- `readSpikeAlarm` — ConsumedReadCapacityUnits spike detector.

Standard-resolution alarms are billed at **$0.10/alarm/month** after the
first 10 alarms in the account (which are free). Two tables = 4 alarms =
$0.40/mo at standard billing; across a stack with 10 tables that is $2/mo
for alarms alone.

Disable either alarm via `alarms: { writeSpike: false }` or
`alarms: { readSpike: false }`. Disabling both (`alarms: { writeSpike: false, readSpike: false }`)
removes the alarm cost entirely at the cost of losing the runaway-write
and hot-read signals.

## When to switch to provisioned billing

`SingleTable` hardcodes `BillingMode.PAY_PER_REQUEST` (on-demand). This
is correct for unknown, spiky, or new workloads: no capacity planning,
no under-provisioned throttles, no wasted pre-allocated capacity.

On-demand billing is, however, materially more expensive than provisioned
at steady-state throughput. AWS's published crossover is roughly:

> Once your steady-state utilisation exceeds 20–30% of the equivalent
> provisioned capacity, PROVISIONED + Application Auto Scaling +
> a Reserved Capacity commitment is cheaper.

Concrete prompt: if you have **30 or more days** of stable traffic data
and your average consumed capacity is above approximately:

- **50 WCU/sec** (write-heavy workloads), or
- **150 RCU/sec** (read-heavy workloads),

run the comparison in the
[AWS Pricing Calculator](https://calculator.aws/pricing/2/home#/).
Compare on-demand cost (from your CloudWatch `ConsumedWriteCapacityUnits`
/ `ConsumedReadCapacityUnits` metrics) against provisioned + auto-scaling
with a 1-year Reserved Capacity commitment for the baseline tier.

Exposing `billingMode` as a prop is deferred until a real consumer asks
for it. Premature flexibility costs verification time (per the project's
[verification-cost axiom](../01-scope-and-philosophy.md#design-principles));
the correct moment to add the prop is when a consumer has done the
calculation and confirmed provisioned is cheaper for their workload. At
that point use `dynamodb.Table` directly or open an issue to add the prop.

## Open questions

- **KMS encryption?** v0.2. The construct's surface accepts it the
  same way `QueueWithDlq` does — a discriminated union — but the
  default stays AWS-managed.
- **Second GSI?** v0.2 or later. Single-table designs with two GSIs
  exist in the wild; trellis's tables use one. If a consumer's
  access pattern justifies it, add `enableGsi2?: boolean`.
  Speculative-generality risk: don't add until asked.
- **Sparse-GSI variant?** GSI1 is currently a dense GSI (every item
  is indexed if it has `gsi1pk`). A sparse-GSI helper for
  "index-on-attribute-existence" is a useful pattern but not
  load-bearing. Defer.
- **Kinesis-stream attachment as an alternative to DDB Streams?** DDB
  natively supports both `stream` (legacy) and `kinesisStream` (newer,
  higher throughput, supports fan-out). v0.1 ships only `stream`;
  add `kinesisStream` if a consumer needs the higher-throughput
  path.
