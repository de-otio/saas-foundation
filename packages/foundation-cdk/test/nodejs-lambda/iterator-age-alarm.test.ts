import * as path from "node:path";
import * as url from "node:url";

import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { describe, expect, it } from "vitest";

import { NodejsLambda } from "../../lib/nodejs-lambda/nodejs-lambda.js";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HANDLER_ENTRY = path.join(__dirname, "fixtures/handler.ts");
const TEST_ENV = { account: "123456789012", region: "eu-west-1" };

function makeStack(name: string): cdk.Stack {
  const app = new cdk.App();
  return new cdk.Stack(app, name, { env: TEST_ENV, stackName: name });
}

describe("NodejsLambda#addQueueIteratorAgeAlarm", () => {
  it("creates an IteratorAge alarm with the default 5-minute threshold", () => {
    const stack = makeStack("IteratorAgeDefaultStack");
    const fn = new NodejsLambda(stack, "Fn", {
      entry: HANDLER_ENTRY,
      functionName: "fn-iter-age",
      // Skip the standard three to keep the assertion narrow.
      alarms: { errors: false, throttles: false, duration: false },
    });
    const queue = new sqs.Queue(stack, "Q", { queueName: "iter-age-queue" });

    const alarm = fn.addQueueIteratorAgeAlarm(queue);
    expect(alarm).toBeDefined();

    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::CloudWatch::Alarm", 1);
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "IteratorAge",
      Namespace: "AWS/Lambda",
      // 5 minutes × 60 s × 1000 ms = 300 000 ms
      Threshold: 300000,
      EvaluationPeriods: 1,
      ComparisonOperator: "GreaterThanThreshold",
      TreatMissingData: "notBreaching",
    });
  });

  it("honours a custom thresholdMinutes value", () => {
    const stack = makeStack("IteratorAgeCustomStack");
    const fn = new NodejsLambda(stack, "Fn", {
      entry: HANDLER_ENTRY,
      functionName: "fn-iter-age-custom",
      alarms: { errors: false, throttles: false, duration: false },
    });
    const queue = new sqs.Queue(stack, "Q", { queueName: "iter-age-custom" });
    fn.addQueueIteratorAgeAlarm(queue, { thresholdMinutes: 10 });

    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "IteratorAge",
      // 10 minutes in ms
      Threshold: 600000,
    });
  });

  it("attaches the alarm to an SNS topic when provided", () => {
    const stack = makeStack("IteratorAgeTopicStack");
    const topic = new sns.Topic(stack, "Topic");
    const fn = new NodejsLambda(stack, "Fn", {
      entry: HANDLER_ENTRY,
      functionName: "fn-iter-age-topic",
      alarms: { errors: false, throttles: false, duration: false },
    });
    const queue = new sqs.Queue(stack, "Q", { queueName: "iter-age-topic-q" });
    fn.addQueueIteratorAgeAlarm(queue, { alarmTopic: topic });

    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "IteratorAge",
      AlarmActions: Match.arrayWith([{ Ref: Match.anyValue() }]),
    });
  });

  it("dimensions include FunctionName and EventSourceArn", () => {
    const stack = makeStack("IteratorAgeDimsStack");
    const fn = new NodejsLambda(stack, "Fn", {
      entry: HANDLER_ENTRY,
      functionName: "fn-iter-dims",
      alarms: { errors: false, throttles: false, duration: false },
    });
    const queue = new sqs.Queue(stack, "Q", { queueName: "iter-age-dims-q" });
    fn.addQueueIteratorAgeAlarm(queue);

    const template = Template.fromStack(stack);
    // Snapshot a single alarm and inspect its dimension list
    const alarms = template.findResources("AWS::CloudWatch::Alarm");
    const props = Object.values(alarms)[0]?.Properties as Record<string, unknown>;
    const dims = props["Dimensions"] as ReadonlyArray<{ Name: string }>;
    const dimNames = dims.map((d) => d.Name).sort();
    expect(dimNames).toEqual(["EventSourceArn", "FunctionName", "Resource"]);
  });
});
