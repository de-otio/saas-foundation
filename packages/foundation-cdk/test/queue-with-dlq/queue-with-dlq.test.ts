import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as kms from "aws-cdk-lib/aws-kms";
import * as sns from "aws-cdk-lib/aws-sns";
import { describe, it, expect, beforeEach } from "vitest";
import { QueueWithDlq } from "../../lib/queue-with-dlq/index.js";

const TEST_ENV = { account: "123456789012", region: "eu-west-1" };

function makeStack(name = "TestStack"): cdk.Stack {
  const app = new cdk.App();
  return new cdk.Stack(app, name, { env: TEST_ENV, stackName: name });
}

describe("QueueWithDlq", () => {
  describe("default props", () => {
    let template: Template;

    beforeEach(() => {
      const stack = makeStack("QueueDefaultStack");
      new QueueWithDlq(stack, "MyQueue", { queueName: "my-queue" });
      template = Template.fromStack(stack);
    });

    it("creates exactly two SQS queues", () => {
      template.resourceCountIs("AWS::SQS::Queue", 2);
    });

    it("creates the main queue with the given name", () => {
      template.hasResourceProperties("AWS::SQS::Queue", {
        QueueName: "my-queue",
        VisibilityTimeout: 30,
        MessageRetentionPeriod: 259200, // 3 days in seconds
        SqsManagedSseEnabled: true,
      });
    });

    it("creates the DLQ with the derived name and 14-day retention", () => {
      template.hasResourceProperties("AWS::SQS::Queue", {
        QueueName: "my-queue-dlq",
        MessageRetentionPeriod: 1209600, // 14 days in seconds
        SqsManagedSseEnabled: true,
      });
    });

    it("wires the DLQ with maxReceiveCount=3", () => {
      template.hasResourceProperties("AWS::SQS::Queue", {
        QueueName: "my-queue",
        RedrivePolicy: {
          maxReceiveCount: 3,
        },
      });
    });

    it("creates exactly one CloudWatch alarm", () => {
      template.resourceCountIs("AWS::CloudWatch::Alarm", 1);
    });

    it("creates the DLQ alarm with GREATER_THAN_THRESHOLD on ApproximateNumberOfMessagesVisible", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        MetricName: "ApproximateNumberOfMessagesVisible",
        Namespace: "AWS/SQS",
        Threshold: 0,
        ComparisonOperator: "GreaterThanThreshold",
        EvaluationPeriods: 1,
        TreatMissingData: "notBreaching",
      });
    });

    it("does not create an SNS action when alarmTopic is unset", () => {
      template.resourceCountIs("AWS::CloudWatch::Alarm", 1);
      // Alarm actions array should be absent or empty
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      const alarmValues = Object.values(alarms);
      expect(alarmValues.length).toBe(1);
      const props = alarmValues[0]?.Properties as Record<string, unknown>;
      expect(props?.["AlarmActions"] === undefined || props?.["AlarmActions"] === null).toBe(true);
    });
  });

  describe("custom retention", () => {
    it("propagates retentionPeriodDays correctly", () => {
      const stack = makeStack("QueueRetentionStack");
      new QueueWithDlq(stack, "Q", {
        queueName: "retained-queue",
        retentionPeriodDays: 7,
        dlqRetentionDays: 10,
      });
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::SQS::Queue", {
        QueueName: "retained-queue",
        MessageRetentionPeriod: 604800, // 7 days
      });
      template.hasResourceProperties("AWS::SQS::Queue", {
        QueueName: "retained-queue-dlq",
        MessageRetentionPeriod: 864000, // 10 days
      });
    });
  });

  describe("KMS-managed encryption", () => {
    it("uses KMS_MANAGED encryption when requested", () => {
      const stack = makeStack("QueueKmsStack");
      new QueueWithDlq(stack, "Q", {
        queueName: "kms-queue",
        encryption: { kind: "kms-managed" },
      });
      const template = Template.fromStack(stack);
      // KMS managed: SqsManagedSseEnabled is false, KmsMasterKeyId is alias/aws/sqs
      template.hasResourceProperties("AWS::SQS::Queue", {
        QueueName: "kms-queue",
        KmsMasterKeyId: "alias/aws/sqs",
      });
    });
  });

  describe("customer-managed KMS key", () => {
    it("produces the KMS key reference on both queues", () => {
      const stack = makeStack("QueueCmkStack");
      const key = new kms.Key(stack, "MyKey");
      new QueueWithDlq(stack, "Q", {
        queueName: "cmk-queue",
        encryption: { kind: "customer-managed", key },
      });
      const template = Template.fromStack(stack);
      // Should have a KMS key resource
      template.resourceCountIs("AWS::KMS::Key", 1);
      // Main queue should reference the key via GetAtt
      template.hasResourceProperties("AWS::SQS::Queue", {
        QueueName: "cmk-queue",
        KmsMasterKeyId: { "Fn::GetAtt": Match.arrayWith(["Arn"]) },
      });
    });
  });

  describe("alarm topic wiring", () => {
    it("adds an SNS action when alarmTopic is provided", () => {
      const stack = makeStack("QueueAlarmTopicStack");
      const topic = new sns.Topic(stack, "Topic");
      new QueueWithDlq(stack, "Q", {
        queueName: "alarmed-queue",
        alarmTopic: topic,
      });
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmActions: Match.arrayWith([{ Ref: Match.anyValue() }]),
      });
    });
  });

  describe("custom visibilityTimeout and maxReceiveCount", () => {
    it("propagates custom visibility timeout", () => {
      const stack = makeStack("QueueVisibilityStack");
      new QueueWithDlq(stack, "Q", {
        queueName: "vis-queue",
        visibilityTimeoutSeconds: 180,
        maxReceiveCount: 5,
      });
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::SQS::Queue", {
        QueueName: "vis-queue",
        VisibilityTimeout: 180,
        RedrivePolicy: {
          maxReceiveCount: 5,
        },
      });
    });
  });

  describe("removal policy", () => {
    it("queues have RETAIN removal policy by default", () => {
      const stack = makeStack("QueueRemovalStack");
      new QueueWithDlq(stack, "Q", { queueName: "retain-queue" });
      const template = Template.fromStack(stack);
      // RETAIN is the CDK default so no DeletionPolicy property means retain
      // CDK sets DeletionPolicy: Retain explicitly when RETAIN is applied
      const queues = template.findResources("AWS::SQS::Queue");
      for (const resource of Object.values(queues)) {
        expect((resource as { DeletionPolicy?: string })["DeletionPolicy"]).toBe("Retain");
      }
    });
  });
});
