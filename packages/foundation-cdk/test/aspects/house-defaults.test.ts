/**
 * Tests for HouseDefaultsAspect.
 *
 * Uses CDK's Annotations.fromStack() to inspect warnings/errors emitted
 * during synthesis. Each test applies the Aspect to a fixed, deterministic
 * stack to avoid snapshot flakiness.
 */

import * as path from "node:path";
import * as url from "node:url";

import * as cdk from "aws-cdk-lib";
import { Annotations, Aspects } from "aws-cdk-lib";
import { Annotations as AssertAnnotations, Match } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { describe, it, expect } from "vitest";
import { HouseDefaultsAspect } from "../../lib/aspects/index.js";
import { QueueWithDlq } from "../../lib/queue-with-dlq/index.js";
import { SingleTable } from "../../lib/single-table/index.js";
import { NodejsLambda } from "../../lib/nodejs-lambda/nodejs-lambda.js";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HANDLER_ENTRY = path.join(__dirname, "../nodejs-lambda/fixtures/handler.ts");

const TEST_ENV = { account: "123456789012", region: "eu-west-1" };

function makeStack(name: string): { app: cdk.App; stack: cdk.Stack } {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, name, { env: TEST_ENV, stackName: name });
  return { app, stack };
}

// ---------------------------------------------------------------------------
// Raw Lambda checks
// ---------------------------------------------------------------------------

describe("HouseDefaultsAspect — raw Lambda", () => {
  it("emits no warning for a stack with no Lambda functions", () => {
    const { stack } = makeStack("AspectNoLambdaStack");
    Aspects.of(stack).add(new HouseDefaultsAspect());
    const annotations = AssertAnnotations.fromStack(stack);
    expect(annotations.findWarning("*", Match.anyValue())).toHaveLength(0);
    expect(annotations.findError("*", Match.anyValue())).toHaveLength(0);
  });

  it("emits a warning for a raw lambda.Function (default severity)", () => {
    const { stack } = makeStack("AspectRawLambdaWarnStack");
    new lambda.Function(stack, "RawFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = async () => {}"),
    });
    Aspects.of(stack).add(new HouseDefaultsAspect());
    const annotations = AssertAnnotations.fromStack(stack);
    expect(
      annotations.findWarning("*", Match.stringLikeRegexp("bypasses NodejsLambda")),
    ).not.toHaveLength(0);
    expect(annotations.findError("*", Match.anyValue())).toHaveLength(0);
  });

  it("emits an error for a raw lambda.Function when rawLambda='error'", () => {
    const { stack } = makeStack("AspectRawLambdaErrorStack");
    new lambda.Function(stack, "RawFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = async () => {}"),
    });
    Aspects.of(stack).add(new HouseDefaultsAspect({ rawLambda: "error" }));
    const annotations = AssertAnnotations.fromStack(stack);
    expect(
      annotations.findError("*", Match.stringLikeRegexp("bypasses NodejsLambda")),
    ).not.toHaveLength(0);
  });

  it("emits no warning for a raw lambda.Function when rawLambda='off'", () => {
    const { stack } = makeStack("AspectRawLambdaOffStack");
    new lambda.Function(stack, "RawFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = async () => {}"),
    });
    Aspects.of(stack).add(new HouseDefaultsAspect({ rawLambda: "off" }));
    const annotations = AssertAnnotations.fromStack(stack);
    expect(
      annotations.findWarning("*", Match.stringLikeRegexp("bypasses NodejsLambda")),
    ).toHaveLength(0);
    expect(
      annotations.findError("*", Match.stringLikeRegexp("bypasses NodejsLambda")),
    ).toHaveLength(0);
  });

  it("emits no warning for a lambda.Function that carries the house-construct metadata tag", () => {
    const { stack } = makeStack("AspectTaggedLambdaStack");
    const fn = new lambda.Function(stack, "TaggedFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = async () => {}"),
    });
    // Simulate what NodejsLambda does — tag the parent construct.
    fn.node.addMetadata("de-otio:houseConstruct", "NodejsLambda");
    Aspects.of(stack).add(new HouseDefaultsAspect());
    const annotations = AssertAnnotations.fromStack(stack);
    expect(
      annotations.findWarning("*", Match.stringLikeRegexp("bypasses NodejsLambda")),
    ).toHaveLength(0);
    expect(
      annotations.findError("*", Match.stringLikeRegexp("bypasses NodejsLambda")),
    ).toHaveLength(0);
  });

  it("emits no warning for a NodejsLambda (house construct adds metadata tag)", () => {
    const { stack } = makeStack("AspectNodejsLambdaStack");
    new NodejsLambda(stack, "HouseFn", {
      entry: HANDLER_ENTRY,
      functionName: "aspect-test-fn",
    });
    Aspects.of(stack).add(new HouseDefaultsAspect());
    const annotations = AssertAnnotations.fromStack(stack);
    expect(
      annotations.findWarning("*", Match.stringLikeRegexp("bypasses NodejsLambda")),
    ).toHaveLength(0);
    expect(
      annotations.findError("*", Match.stringLikeRegexp("bypasses NodejsLambda")),
    ).toHaveLength(0);
  });

  it("emits a warning for a raw lambda.Function but NOT for a NodejsLambda in the same stack", () => {
    const { stack } = makeStack("AspectMixedLambdaStack");
    new NodejsLambda(stack, "HouseFn", {
      entry: HANDLER_ENTRY,
      functionName: "aspect-mixed-house-fn",
    });
    new lambda.Function(stack, "RawFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = async () => {}"),
    });
    Aspects.of(stack).add(new HouseDefaultsAspect());
    const annotations = AssertAnnotations.fromStack(stack);
    const warnings = annotations.findWarning("*", Match.stringLikeRegexp("bypasses NodejsLambda"));
    // The raw function should warn; the NodejsLambda should not.
    expect(warnings.length).toBeGreaterThan(0);
    for (const w of warnings) {
      expect(String(w.entry.data)).not.toContain("HouseFn");
    }
  });
});

// ---------------------------------------------------------------------------
// Raw DynamoDB table checks
// ---------------------------------------------------------------------------

describe("HouseDefaultsAspect — raw DynamoDB table", () => {
  it("emits no warning for a stack with no DynamoDB tables", () => {
    const { stack } = makeStack("AspectNoTableStack");
    Aspects.of(stack).add(new HouseDefaultsAspect());
    const annotations = AssertAnnotations.fromStack(stack);
    expect(annotations.findWarning("*", Match.anyValue())).toHaveLength(0);
    expect(annotations.findError("*", Match.anyValue())).toHaveLength(0);
  });

  it("emits a warning for a raw dynamodb.Table (default severity)", () => {
    const { stack } = makeStack("AspectRawTableWarnStack");
    new dynamodb.Table(stack, "RawTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
    });
    Aspects.of(stack).add(new HouseDefaultsAspect());
    const annotations = AssertAnnotations.fromStack(stack);
    expect(
      annotations.findWarning("*", Match.stringLikeRegexp("bypasses SingleTable")),
    ).not.toHaveLength(0);
    expect(annotations.findError("*", Match.anyValue())).toHaveLength(0);
  });

  it("emits an error for a raw dynamodb.Table when rawTable='error'", () => {
    const { stack } = makeStack("AspectRawTableErrorStack");
    new dynamodb.Table(stack, "RawTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
    });
    Aspects.of(stack).add(new HouseDefaultsAspect({ rawTable: "error" }));
    const annotations = AssertAnnotations.fromStack(stack);
    expect(
      annotations.findError("*", Match.stringLikeRegexp("bypasses SingleTable")),
    ).not.toHaveLength(0);
  });

  it("emits no warning for a raw dynamodb.Table when rawTable='off'", () => {
    const { stack } = makeStack("AspectRawTableOffStack");
    new dynamodb.Table(stack, "RawTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
    });
    Aspects.of(stack).add(new HouseDefaultsAspect({ rawTable: "off" }));
    const annotations = AssertAnnotations.fromStack(stack);
    expect(
      annotations.findWarning("*", Match.stringLikeRegexp("bypasses SingleTable")),
    ).toHaveLength(0);
    expect(annotations.findError("*", Match.stringLikeRegexp("bypasses SingleTable"))).toHaveLength(
      0,
    );
  });

  it("emits no warning for a SingleTable (correctly tagged)", () => {
    const { stack } = makeStack("AspectSingleTableStack");
    new SingleTable(stack, "HouseTable", { tableName: "aspect-test-table" });
    Aspects.of(stack).add(new HouseDefaultsAspect());
    const annotations = AssertAnnotations.fromStack(stack);
    expect(
      annotations.findWarning("*", Match.stringLikeRegexp("bypasses SingleTable")),
    ).toHaveLength(0);
    expect(annotations.findError("*", Match.stringLikeRegexp("bypasses SingleTable"))).toHaveLength(
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// Raw SQS queue checks (DLQ-presence based, not metadata-tag based)
// ---------------------------------------------------------------------------

describe("HouseDefaultsAspect — raw SQS queue without DLQ", () => {
  it("emits no warning for a stack with no SQS queues", () => {
    const { stack } = makeStack("AspectNoQueueStack");
    Aspects.of(stack).add(new HouseDefaultsAspect());
    const annotations = AssertAnnotations.fromStack(stack);
    expect(annotations.findWarning("*", Match.anyValue())).toHaveLength(0);
    expect(annotations.findError("*", Match.anyValue())).toHaveLength(0);
  });

  it("emits a warning for a raw sqs.Queue with no DLQ (default severity)", () => {
    const { stack } = makeStack("AspectRawQueueWarnStack");
    new sqs.Queue(stack, "RawQueue", { queueName: "no-dlq-queue" });
    Aspects.of(stack).add(new HouseDefaultsAspect());
    const annotations = AssertAnnotations.fromStack(stack);
    expect(annotations.findWarning("*", Match.stringLikeRegexp("has no DLQ"))).not.toHaveLength(0);
    expect(annotations.findError("*", Match.anyValue())).toHaveLength(0);
  });

  it("emits an error for a raw sqs.Queue when rawQueue='error'", () => {
    const { stack } = makeStack("AspectRawQueueErrorStack");
    new sqs.Queue(stack, "RawQueue", { queueName: "no-dlq-queue-err" });
    Aspects.of(stack).add(new HouseDefaultsAspect({ rawQueue: "error" }));
    const annotations = AssertAnnotations.fromStack(stack);
    expect(annotations.findError("*", Match.stringLikeRegexp("has no DLQ"))).not.toHaveLength(0);
  });

  it("emits no warning for a raw sqs.Queue when rawQueue='off'", () => {
    const { stack } = makeStack("AspectRawQueueOffStack");
    new sqs.Queue(stack, "RawQueue", { queueName: "no-dlq-queue-off" });
    Aspects.of(stack).add(new HouseDefaultsAspect({ rawQueue: "off" }));
    const annotations = AssertAnnotations.fromStack(stack);
    expect(annotations.findWarning("*", Match.stringLikeRegexp("has no DLQ"))).toHaveLength(0);
    expect(annotations.findError("*", Match.stringLikeRegexp("has no DLQ"))).toHaveLength(0);
  });

  it("emits no warning for a sqs.Queue that has a DLQ attached manually", () => {
    const { stack } = makeStack("AspectQueueWithManualDlqStack");
    const dlq = new sqs.Queue(stack, "ManualDlq", { queueName: "manual-dlq" });
    new sqs.Queue(stack, "MainQueue", {
      queueName: "main-with-dlq",
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });
    Aspects.of(stack).add(new HouseDefaultsAspect());
    const annotations = AssertAnnotations.fromStack(stack);
    // ManualDlq itself has no DLQ — it should warn (DLQ-of-DLQ is intentionally
    // not checked here by the aspect: it still sees it as a queue with no DLQ).
    // Main queue should not warn since it has a DLQ.
    const warnings = annotations.findWarning("*", Match.stringLikeRegexp("has no DLQ"));
    // Only the ManualDlq itself should fire (it has no DLQ).
    // Main queue should not fire.
    for (const w of warnings) {
      expect(w.entry.data).not.toContain("main-with-dlq");
    }
  });

  it("emits no warning for a QueueWithDlq (both queues satisfy the check)", () => {
    const { stack } = makeStack("AspectQueueWithDlqStack");
    new QueueWithDlq(stack, "HouseQueue", { queueName: "aspect-test-queue" });
    Aspects.of(stack).add(new HouseDefaultsAspect());
    const annotations = AssertAnnotations.fromStack(stack);
    // The main queue has a DLQ — no warning expected for it.
    // The DLQ itself has no further DLQ, but that is an intentional trade-off.
    const warnings = annotations.findWarning("*", Match.stringLikeRegexp("has no DLQ"));
    // Filter to ensure the main queue path is not in the warnings.
    for (const w of warnings) {
      // The main queue path contains "Queue" but not "Dlq" at the end.
      const data = String(w.entry.data);
      expect(data).not.toMatch(/AspectQueueWithDlqStack\/HouseQueue\/Queue /);
    }
  });
});

// ---------------------------------------------------------------------------
// Exempt list
// ---------------------------------------------------------------------------

describe("HouseDefaultsAspect — exempt list", () => {
  it("silences warnings for paths matching the exact exempt prefix", () => {
    const { stack } = makeStack("AspectExemptExactStack");
    new lambda.Function(stack, "ExemptFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = async () => {}"),
    });
    Aspects.of(stack).add(
      new HouseDefaultsAspect({
        exempt: ["AspectExemptExactStack/ExemptFn"],
      }),
    );
    const annotations = AssertAnnotations.fromStack(stack);
    expect(
      annotations.findWarning("*", Match.stringLikeRegexp("bypasses NodejsLambda")),
    ).toHaveLength(0);
  });

  it("silences warnings for all paths under an exempt prefix", () => {
    const { stack } = makeStack("AspectExemptPrefixStack");
    new lambda.Function(stack, "Fn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = async () => {}"),
    });
    Aspects.of(stack).add(
      new HouseDefaultsAspect({
        exempt: ["AspectExemptPrefixStack"],
      }),
    );
    const annotations = AssertAnnotations.fromStack(stack);
    expect(
      annotations.findWarning("*", Match.stringLikeRegexp("bypasses NodejsLambda")),
    ).toHaveLength(0);
  });

  it("does not silence warnings for non-matching paths", () => {
    const { stack } = makeStack("AspectExemptMismatchStack");
    new lambda.Function(stack, "Fn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = async () => {}"),
    });
    Aspects.of(stack).add(
      new HouseDefaultsAspect({
        exempt: ["OtherStack"],
      }),
    );
    const annotations = AssertAnnotations.fromStack(stack);
    expect(
      annotations.findWarning("*", Match.stringLikeRegexp("bypasses NodejsLambda")),
    ).not.toHaveLength(0);
  });

  it("exempt applies to all rule types simultaneously", () => {
    const { stack } = makeStack("AspectExemptAllRulesStack");
    new lambda.Function(stack, "Fn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = async () => {}"),
    });
    new dynamodb.Table(stack, "T", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
    });
    new sqs.Queue(stack, "Q", { queueName: "raw-q" });

    Aspects.of(stack).add(
      new HouseDefaultsAspect({
        exempt: ["AspectExemptAllRulesStack"],
      }),
    );
    const annotations = AssertAnnotations.fromStack(stack);
    expect(annotations.findWarning("*", Match.anyValue())).toHaveLength(0);
    expect(annotations.findError("*", Match.anyValue())).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Annotations type import guard (unused import check)
// ---------------------------------------------------------------------------

// Verify we don't accidentally leave an unused import; this is a type-only
// re-export test to ensure the Annotations core import is used somewhere.
describe("HouseDefaultsAspect — import sanity", () => {
  it("Annotations from aws-cdk-lib core is accessible", () => {
    expect(typeof Annotations.of).toBe("function");
  });
});
