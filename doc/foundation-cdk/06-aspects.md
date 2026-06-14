# 06 — Aspects

`HouseDefaultsAspect` — a CDK Aspect that walks the construct tree at
synth time and warns when raw `aws-cdk-lib` resources appear in
contexts where foundation-cdk has a wrapper construct. The wrapper
constructs are voluntary; the Aspect is the safety net that catches
"oh, I forgot to use it" before it reaches deploy.

## Why an Aspect (and not just wrapper-only enforcement)

CDK best practice from the
[official guidance](https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html):

> Don't rely solely on wrapper constructs for compliance — they can
> be circumvented. Use Aspects and CloudFormation Guard for
> validation.

`NodejsLambda`, `QueueWithDlq`, and `SingleTable` bake house defaults
into wrapper constructs. A consumer who does `new dynamodb.Table(...)`
directly inside a stack bypasses every default without warning. The
foundation-cdk pattern is: ship the wrappers as the _ergonomic_ path,
and ship the Aspect as the _enforcement_ path.

The Aspect is opt-in (the consumer applies it to their CDK app
explicitly). Foundation-cdk does not auto-apply Aspects to consumer
code.

## API

```typescript
import { IAspect, IConstruct, Annotations } from "aws-cdk-lib";

/**
 * Severity level for a HouseDefaultsAspect rule.
 * - 'warn'  Annotations.addWarning — synth succeeds, message shown.
 * - 'error' Annotations.addError   — synth fails.
 * - 'off'   Rule is skipped entirely.
 */
export type RuleSeverity = "warn" | "error" | "off";

export interface HouseDefaultsAspectProps {
  /**
   * Severity for raw-Lambda violations.
   * 'warn'  — Annotations.addWarning (synth succeeds, message shown)
   * 'error' — Annotations.addError (synth fails)
   * 'off'   — skip the check entirely
   * @default 'warn'
   */
  rawLambda?: RuleSeverity;

  /**
   * Severity for raw-Table violations (any dynamodb.Table not created
   * via SingleTable).
   * @default 'warn'
   */
  rawTable?: RuleSeverity;

  /**
   * Severity for raw-Queue violations (any sqs.Queue without an
   * associated deadLetterQueue, OR not created via QueueWithDlq).
   * @default 'warn'
   */
  rawQueue?: RuleSeverity;

  /**
   * Per-resource opt-outs by construct path or logical-ID prefix.
   * Use when a consumer legitimately needs a raw resource (e.g.,
   * a one-off DLQ-less queue for an ephemeral test fixture).
   */
  exempt?: string[];
}

export class HouseDefaultsAspect implements IAspect {
  constructor(props?: HouseDefaultsAspectProps);
  visit(node: IConstruct): void;
}
```

## What it checks

Three rules at synth time:

### Raw Lambda functions

Fires when a `lambda.Function`, `lambda.NodejsFunction`, or any
subclass of `lambda.IFunction` is found that was **not** created via
`NodejsLambda`. Detection: the Aspect tags every `NodejsLambda`-owned
function at construction with a `de-otio:houseConstruct: NodejsLambda`
metadata entry; the Aspect looks for the absence of that tag on any
`CfnFunction`.

Message: `Lambda function at ${path} bypasses NodejsLambda; ARM64,
X-Ray, log retention, and alarm defaults are not applied. Use
NodejsLambda, or add "${path}" to the exempt list.`

### Raw DynamoDB tables

Fires when a `dynamodb.Table` is found without the
`de-otio:houseConstruct: SingleTable` metadata. Catches the
"forgot to use SingleTable" case where house defaults (PITR, TTL,
single-table key shape, alarms) are absent.

Message: `DynamoDB table at ${path} bypasses SingleTable; PITR, TTL,
and spike alarms are not applied. Use SingleTable, or add "${path}"
to the exempt list.`

### Raw SQS queues without DLQ

Fires when a `sqs.Queue` is found that has **no** `deadLetterQueue`
configured. The check is not "wasn't created via `QueueWithDlq`" —
a consumer who builds their own queue+DLQ pair manually still
satisfies the intent. The check is the missing DLQ.

Message: `SQS queue at ${path} has no DLQ. Failed messages will be
lost after maxReceiveCount. Use QueueWithDlq, or attach a DLQ
manually, or add "${path}" to the exempt list.`

## Consumer usage

```typescript
import * as cdk from "aws-cdk-lib";
import { HouseDefaultsAspect } from "@de-otio/saas-foundation-cdk/aspects";

const app = new cdk.App();
// ... declare stacks

// Recommended: warn-level enforcement, surfaces violations in `cdk synth`
cdk.Aspects.of(app).add(new HouseDefaultsAspect());

// Strict: fail synth on any violation
cdk.Aspects.of(app).add(
  new HouseDefaultsAspect({
    rawLambda: "error",
    rawTable: "error",
    rawQueue: "error",
  }),
);

// Selective: error on tables, warn on the rest, exempt one stack
cdk.Aspects.of(app).add(
  new HouseDefaultsAspect({
    rawTable: "error",
    exempt: ["MyApp/EphemeralStack/*"],
  }),
);
```

The Aspect runs during `cdk synth` and emits messages via
`Annotations.of(node).addWarning(...)` or `addError(...)`. CI
pipelines that fail on warnings (recommended) catch the regressions
at PR review.

## What it does not check

- **cdk-nag rules.** Those are the consumer's choice. The Aspect's
  scope is foundation-cdk's _wrapper-bypass_ protection, not
  general security/compliance posture. cdk-nag is the right tool
  for the latter; foundation-cdk's own test suite asserts against
  it (see [`./01-package-api.md § Testing posture`](./01-package-api.md#testing-posture)).
- **Reserved-concurrency budget.** Sum-of-reservations vs the
  account 100-unit floor is a deferred Aspect (see
  [`./02-nodejs-lambda.md § Open questions`](./02-nodejs-lambda.md#open-questions)).
- **Cross-construct visibility-timeout ratio.** That check runs in
  the `addEventSource` attach helper, not the Aspect (see
  [`./03-queue-with-dlq.md § Visibility timeout and Lambda timeout`](./03-queue-with-dlq.md#visibility-timeout-and-lambda-timeout)).

## HouseTaggingAspect (required for cost attribution)

A second Aspect, `HouseTaggingAspect`, applies the four cost-allocation
tags that map a stack's spend onto the AWS Well-Architected Cost
Optimization Pillar (Cloud Financial Management focus area):

| Tag key       | Source prop      | Example value         |
| ------------- | ---------------- | --------------------- |
| `Environment` | `environment`    | `prod`                |
| `Service`     | `service`        | `magic-link-auth`     |
| `CostCenter`  | `costCenter`     | `trellis-platform`    |
| `Owner`       | `owner`          | `platform-team`       |

All four props are required strings; an empty value emits a synth-time
error and the aspect skips applying the marker so a downstream
validation pass can flag the stack.

### Prop spec

```typescript
export interface HouseTaggingAspectProps {
  /** Deployment environment, e.g. "prod", "staging", "dev". */
  readonly environment: string;

  /** Logical service the stack belongs to. */
  readonly service: string;

  /** Cost-centre / billing-owner identifier. */
  readonly costCenter: string;

  /** Team or individual responsible for the stack. */
  readonly owner: string;
}

export class HouseTaggingAspect implements IAspect {
  constructor(props: HouseTaggingAspectProps);
  visit(node: IConstruct): void;
}

export function validateHouseTaggingApplied(scope: IConstruct): void;

/**
 * The four cost-allocation tag keys that HouseTaggingAspect emits.
 * Names follow AWS conventional PascalCase so they line up with
 * default cost-allocation tag activation in Billing.
 */
export const HOUSE_TAGGING_KEYS: readonly ["Environment", "Service", "CostCenter", "Owner"];

/**
 * Metadata key set on a Stack by HouseTaggingAspect to record that
 * the aspect was applied. Read by validateHouseTaggingApplied.
 */
export const HOUSE_TAGGING_APPLIED_METADATA_KEY: "de-otio:houseTaggingApplied";
```

### Usage

```typescript
import * as cdk from "aws-cdk-lib";
import {
  HouseTaggingAspect,
  validateHouseTaggingApplied,
} from "@de-otio/saas-foundation-cdk/aspects";

const app = new cdk.App();
// ... declare stacks containing NodejsLambda / SingleTable / QueueWithDlq

cdk.Aspects.of(app).add(
  new HouseTaggingAspect({
    environment: "prod",
    service: "magic-link-auth",
    costCenter: "trellis-platform",
    owner: "platform-team",
  }),
);

// Synth-time check: fails synth if any stack containing house
// constructs was not tagged. Closes the silent-miss loophole.
validateHouseTaggingApplied(app);
```

`validateHouseTaggingApplied` registers a second, read-only aspect at
`AspectPriority.READONLY` (1000) so it always runs after the tagging
aspect (default priority 500). The validator walks each Stack, checks
for the `de-otio:houseConstruct` metadata marker on any descendant, and
if found requires the `de-otio:houseTaggingApplied` marker on the
Stack. Stacks that are missing the latter get an `Annotations.addError`
naming the stack path.

### Caveat — Lambda@Edge does not inherit tags

Tag propagation does **not** reach Lambda@Edge replicas. CloudFront
replicates an edge function into every PoP region under
`/aws/lambda/us-east-1.{name}`, and the replicated functions do not
carry the tags of the source function. This is a CloudFront
limitation, not an aspect bug. The practical consequence is that
Lambda@Edge invocations cannot be split by tag in Cost Explorer — only
the source function's storage line item is taggable. For
shared-distribution stacks with significant edge-function spend, plan
to attribute edge-invocation cost at the distribution level rather
than per-tag.

## Open questions

- **Should the Aspect ship as `default-applied`?** I.e., should
  importing anything from foundation-cdk install the Aspect at the
  app root automatically? Lean: no. CDK best practice is opt-in
  Aspects; auto-application surprises consumers and breaks the
  "compose, don't enforce" composition philosophy. Document the
  opt-in pattern in the package README instead.
- **Logical-ID exempts vs path exempts?** The shipped surface uses
  path matching (string-prefix). Logical-ID matching is also
  reasonable. Path matching is closer to "what the consumer sees in
  `cdk synth` output." Path wins for v0.1.
- **More rules?** Candidate additions: warn on `s3.Bucket` without
  `enforceSSL`, warn on `kms.Key` without rotation enabled, warn on
  Lambda without `tracing: ACTIVE`. Defer until a consumer surfaces
  one as load-bearing — speculative-generality risk on the Aspect
  itself.
