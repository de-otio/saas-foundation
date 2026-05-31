# 03 — QueueWithDlq

The `QueueWithDlq` construct. An SQS queue paired with a dead-letter
queue and a CloudWatch alarm that fires when the DLQ becomes
non-empty. Almost every async backend has one; nobody wants to
re-type the wiring.

Source pattern: `trellis/infra/lib/constructs/queue-with-dlq.ts`.

## Why a house wrapper instead of raw `sqs.Queue`

CDK's `sqs.Queue` requires you to manually:

- Create the DLQ first, with its own retention period (the AWS
  recommendation is 14 days because investigation of the dead-letter
  is rarely same-day).
- Reference the DLQ from the main queue via the `deadLetterQueue`
  prop with a `maxReceiveCount`.
- Decide between SQS-managed and KMS encryption (default _no_
  encryption is a footgun on most accounts).
- Wire a CloudWatch alarm on `ApproximateNumberOfMessagesVisible >
0` on the DLQ.

The wrapper makes the right shape the default and exposes the few
props that genuinely vary.

## Props

```typescript
import * as kms from "aws-cdk-lib/aws-kms";
import * as sns from "aws-cdk-lib/aws-sns";

export interface QueueWithDlqProps {
  /**
   * Physical queue name. The DLQ is named `${queueName}-dlq`.
   */
  queueName: string;

  /**
   * Visibility timeout (seconds). Should exceed the maximum expected
   * consumer processing time. Default: 30.
   */
  visibilityTimeoutSeconds?: number;

  /**
   * Main-queue retention (days). Default: 3.
   * AWS allows 1 minute–14 days.
   */
  retentionPeriodDays?: number;

  /**
   * DLQ retention (days). Default: 14 (maximum).
   * Long retention because DLQ investigation often happens days
   * after the failure.
   */
  dlqRetentionDays?: number;

  /**
   * After how many failed receives a message moves to the DLQ.
   * Default: 3.
   */
  maxReceiveCount?: number;

  /**
   * Encryption. Defaults to SQS-managed. Pass a KMS key for
   * customer-managed encryption.
   */
  encryption?:
    | { kind: "sqs-managed" }
    | { kind: "kms-managed" }
    | { kind: "customer-managed"; key: kms.IKey };

  /**
   * Alarm topic for the DLQ-non-empty alarm. When unset, the alarm
   * is still created but has no action.
   */
  alarmTopic?: sns.ITopic;
}
```

## Class shape

```typescript
import { Construct } from "constructs";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as sqs from "aws-cdk-lib/aws-sqs";

export class QueueWithDlq extends Construct {
  public readonly queue: sqs.Queue;
  public readonly dlq: sqs.Queue;
  public readonly dlqAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: QueueWithDlqProps) {
    super(scope, id);
    // ... DLQ first, then main queue with deadLetterQueue prop, then alarm
  }
}
```

Container `Construct` (not a `sqs.Queue` subclass) because the
construct owns two queues + an alarm, not one queue with extras.
Consumers call `qd.queue.grantSendMessages(...)` and similar.

## House defaults

| Setting                    | Value                       | Rationale                                                                                                                                                                                                        |
| -------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main queue retention       | 3 days                      | Long enough to survive most upstream outages; short enough that a stale message storm doesn't accumulate indefinitely.                                                                                           |
| DLQ retention              | 14 days (SQS maximum)       | Manual investigation often happens days later. The maximum is the safe default.                                                                                                                                  |
| `maxReceiveCount`          | 3                           | One failure could be transient; three almost certainly is the message itself.                                                                                                                                    |
| `visibilityTimeoutSeconds` | 30                          | Should exceed consumer processing. AWS guidance: when wired to a Lambda event source, set to at least 6 × Lambda timeout. See [§ Visibility timeout and Lambda timeout](#visibility-timeout-and-lambda-timeout). |
| Encryption                 | SQS-managed (`SQS_MANAGED`) | Default _no_ encryption is footgun-shaped. SQS-managed is free and turn-key. Customer-managed KMS available for compliance use cases.                                                                            |

The queue and DLQ physical names are honoured (`queueName` is
required, DLQ is `${queueName}-dlq`). Same trade-off as
[NodejsLambda's naming guidance](02-nodejs-lambda.md#naming-and-cdk-guidance):
predictability for downstream wiring at the cost of replace-friendliness.
The alarm name, by contrast, is CDK-auto-generated to avoid cross-stack
collisions on the alarm namespace.

## Alarm

```
metric:           ApproximateNumberOfMessagesVisible (dlq)
threshold:        0
comparison:       GREATER_THAN_THRESHOLD
evaluationPeriods: 1
treatMissingData: NOT_BREACHING
```

Any message in the DLQ is a signal. The alarm clears (`OK` state) the
moment the queue is drained, which is what the consumer wants — both
fire and resolve transition through SNS if an `alarmTopic` is wired.

The alarm name is CDK-auto-generated (logical-ID-derived); the
`alarmDescription` calls out that DLQ presence indicates repeated
processing failures.

**DLQ depth is not the only signal worth watching.** When the queue
is wired to a Lambda event source, the canonical "consumer is
struggling but hasn't given up" signal is the Lambda's `IteratorAge`
metric — see [NodejsLambda.addQueueIteratorAgeAlarm](02-nodejs-lambda.md#class-shape)
for the companion alarm. The two signals are complementary: DLQ
depth says the consumer _failed_; iterator age says the consumer is
_falling behind_.

## Visibility timeout and Lambda timeout

When the queue is wired to a Lambda event source, AWS guidance is
that the SQS visibility timeout should be **at least 6× the Lambda
timeout** to avoid duplicate processing when a slow message is
retried mid-flight. The construct does not auto-set this (the queue
exists before the consumer is wired) but **validates the ratio at
synth** when `addEventSource(new SqsEventSource(qd.queue))` is
called against a `NodejsLambda`:

- If `visibilityTimeout < 6 × functionTimeout`, the synth fails with
  a clear error pointing at this section.
- The escape hatch is `acknowledgeVisibilityRatio?: boolean` on the
  event-source attach helper (or the consumer adjusts the queue
  prop).

The check is intentionally on the _attach_ path, not the queue
constructor, because the queue's correct visibility timeout depends
on the consumer that will read it. A queue not attached to a Lambda
event source skips the check entirely.

## Cross-construct composition

`QueueWithDlq` is designed to compose with `NodejsLambda`:

```typescript
const ingestQueue = new QueueWithDlq(this, "IngestQueue", {
  queueName: "app-ingest",
  visibilityTimeoutSeconds: 180, // 6× the 30s Lambda timeout below
  alarmTopic,
});

const ingestFn = new NodejsLambda(this, "IngestFn", {
  entry: path.join(__dirname, "../lambda/ingest.ts"),
  functionName: "app-ingest-fn",
  alarmTopic,
});

ingestFn.addEventSource(new SqsEventSource(ingestQueue.queue, { batchSize: 10 }));

// Add the iterator-age alarm for the "consumer is struggling" signal.
ingestFn.addQueueIteratorAgeAlarm(ingestQueue.queue, { alarmTopic });
```

The two constructs do not depend on each other — `QueueWithDlq` does
not know about Lambdas; `NodejsLambda` does not know about queues.
Composition lives in the consumer's stack. The synth-time visibility-
timeout check (see § Visibility timeout) runs when the event source
is attached.

## Removal posture

Queues default to `RETAIN`. SQS queues are stateful (in-flight messages
matter); deleting on stack-destroy can drop messages. Consumers who
genuinely want destroy-on-delete override via:

```typescript
qd.queue.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
qd.dlq.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
```

This is intentionally a per-resource override rather than a construct
prop — consumers should think twice per queue, not flip a flag.

## Recurring cost

Per the [paid-by-default cost-disclosure
principle](../01-scope-and-philosophy.md#design-principles), the
default-on paid resources created by this construct:

| Resource         | Count per construct | Cost shape                                                                                      | Opt-out |
| ---------------- | ------------------- | ----------------------------------------------------------------------------------------------- | ------- |
| CloudWatch alarm | 1 (DLQ-non-empty)   | $0.10/alarm/month (standard resolution, most regions). Free tier does not cover this alarm type. | n/a — alarm is always created; no `alarms` opt-out prop exists today |
| SQS requests     | variable            | First 1 M requests/month free across the account; $0.40 per million after.                      | n/a     |

**Worked example.** Three stacks each deploying one `QueueWithDlq`:

- Alarms: 3 constructs × 1 alarm = 3 alarms × $0.10 = **$0.30/month**,
  regardless of queue traffic.
- SQS: cost depends entirely on message throughput. A light-traffic
  background-job queue processing a few thousand messages per day
  stays within the free tier. A high-throughput ingest queue at
  1 M messages/day = 30 M/month = $12/month for that queue alone.

The alarm cost is predictable and small; the SQS cost is
throughput-driven and can dominate at scale. Plan for both.

Note: the `alarmTopic` prop controls whether the alarm has an SNS
action, not whether the alarm is created. The alarm is always
created. A future opt-out prop (`alarms: false`) would follow the
pattern established by `NodejsLambda` and `SingleTable`.

## Open questions

- **Should the DLQ have its own `maxReceiveCount`** (a redrive policy
  on the DLQ pointing to a "graveyard" queue)? AWS supports this;
  trellis doesn't use it. Defer until a consumer asks.
- **Should the alarm support a count threshold above 0**
  (e.g., `> 10` messages = page; `> 0` messages = log)? Currently
  any non-zero count fires. Trellis's behaviour. Defer.
- **FIFO support?** v0.1 is standard queues only. FIFO has different
  visibility-timeout/dedup semantics; a separate `FifoQueueWithDlq`
  construct is the right shape if a consumer needs it. Not now.
