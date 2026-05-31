import * as cdk from "aws-cdk-lib";
import { Annotations as AssertAnnotations, Match, Template } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as sns from "aws-cdk-lib/aws-sns";
import { describe, it, expect, beforeEach } from "vitest";
import { SingleTable, SingleTablePropsError } from "../../lib/single-table/single-table.js";

const TEST_ENV = { account: "123456789012", region: "eu-west-1" };

function makeStack(name = "TestStack"): cdk.Stack {
  const app = new cdk.App();
  return new cdk.Stack(app, name, { env: TEST_ENV, stackName: name });
}

describe("SingleTable", () => {
  describe("default props", () => {
    let template: Template;

    beforeEach(() => {
      const stack = makeStack("SingleTableDefaultStack");
      new SingleTable(stack, "MyTable", { tableName: "my-table" });
      template = Template.fromStack(stack);
    });

    it("creates exactly one DynamoDB table", () => {
      template.resourceCountIs("AWS::DynamoDB::Table", 1);
    });

    it("uses the given table name", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "my-table",
      });
    });

    it("uses PAY_PER_REQUEST billing", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        BillingMode: "PAY_PER_REQUEST",
      });
    });

    it("sets pk/sk as composite primary key", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
      });
    });

    it("sets TTL attribute to 'ttl'", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
      });
    });

    it("uses AWS_MANAGED encryption (SSEEnabled: true)", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        SSESpecification: { SSEEnabled: true },
      });
    });

    it("enables PITR by default", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      });
    });

    it("defaults PITR window to 7 days", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
          RecoveryPeriodInDays: 7,
        },
      });
    });

    it("includes GSI1 by default", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        GlobalSecondaryIndexes: [
          {
            IndexName: "gsi1",
            KeySchema: [
              { AttributeName: "gsi1pk", KeyType: "HASH" },
              { AttributeName: "gsi1sk", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          },
        ],
      });
    });

    it("creates two CloudWatch alarms (write + read)", () => {
      template.resourceCountIs("AWS::CloudWatch::Alarm", 2);
    });

    it("creates write spike alarm with default threshold 200", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        MetricName: "ConsumedWriteCapacityUnits",
        Namespace: "AWS/DynamoDB",
        Threshold: 200,
        ComparisonOperator: "GreaterThanThreshold",
        EvaluationPeriods: 2,
        TreatMissingData: "notBreaching",
        Statistic: "Sum",
        Period: 60,
      });
    });

    it("creates read spike alarm with default threshold 500", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        MetricName: "ConsumedReadCapacityUnits",
        Namespace: "AWS/DynamoDB",
        Threshold: 500,
        ComparisonOperator: "GreaterThanThreshold",
        EvaluationPeriods: 2,
        TreatMissingData: "notBreaching",
        Statistic: "Sum",
        Period: 60,
      });
    });

    it("has RETAIN removal policy by default", () => {
      const tables = template.findResources("AWS::DynamoDB::Table");
      for (const resource of Object.values(tables)) {
        expect((resource as { DeletionPolicy?: string })["DeletionPolicy"]).toBe("Retain");
      }
    });
  });

  describe("PITR disabled", () => {
    it("disables PITR when pointInTimeRecovery=false", () => {
      const stack = makeStack("SingleTableNoPitrStack");
      new SingleTable(stack, "T", { tableName: "no-pitr-table", pointInTimeRecovery: false });
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
      });
    });
  });

  describe("PITR recovery window overrides", () => {
    it("uses the specified pointInTimeRecoveryDays when explicitly set to 7", () => {
      const stack = makeStack("SingleTablePitrShortStack");
      new SingleTable(stack, "T", { tableName: "pitr-7-table", pointInTimeRecoveryDays: 7 });
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
          RecoveryPeriodInDays: 7,
        },
      });
    });

    it("uses the specified pointInTimeRecoveryDays when set to 35", () => {
      const stack = makeStack("SingleTablePitr35Stack");
      new SingleTable(stack, "T", { tableName: "pitr-35-table", pointInTimeRecoveryDays: 35 });
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
          RecoveryPeriodInDays: 35,
        },
      });
    });

    it("throws for pointInTimeRecoveryDays out of range", () => {
      const stack = makeStack("SingleTablePitrOobStack");
      expect(() => {
        new SingleTable(stack, "T", { tableName: "bad-pitr", pointInTimeRecoveryDays: 36 });
      }).toThrow(SingleTablePropsError);
    });

    it("throws for pointInTimeRecoveryDays below 1", () => {
      const stack = makeStack("SingleTablePitrZeroStack");
      expect(() => {
        new SingleTable(stack, "T", { tableName: "bad-pitr-zero", pointInTimeRecoveryDays: 0 });
      }).toThrow(SingleTablePropsError);
    });
  });

  describe("PITR extended-window annotation", () => {
    it("emits a synth-time info annotation when pointInTimeRecoveryDays > 14", () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, "SingleTablePitrAnnotationStack", {
        env: TEST_ENV,
        stackName: "SingleTablePitrAnnotationStack",
      });
      new SingleTable(stack, "T", { tableName: "long-pitr-table", pointInTimeRecoveryDays: 21 });
      const annotations = AssertAnnotations.fromStack(stack);
      annotations.hasInfo(
        "/SingleTablePitrAnnotationStack/T",
        Match.stringLikeRegexp("pointInTimeRecoveryDays=21 exceeds 14"),
      );
    });

    it("does not annotate when pointInTimeRecoveryDays is 14", () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, "SingleTablePitr14Stack", {
        env: TEST_ENV,
        stackName: "SingleTablePitr14Stack",
      });
      new SingleTable(stack, "T", { tableName: "fourteen-day-pitr", pointInTimeRecoveryDays: 14 });
      const annotations = AssertAnnotations.fromStack(stack);
      annotations.hasNoInfo(
        "/SingleTablePitr14Stack/T",
        Match.stringLikeRegexp("exceeds 14"),
      );
    });

    it("does not annotate at the default 7-day window", () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, "SingleTablePitrNoAnnotationStack", {
        env: TEST_ENV,
        stackName: "SingleTablePitrNoAnnotationStack",
      });
      new SingleTable(stack, "T", { tableName: "default-pitr-table" });
      const annotations = AssertAnnotations.fromStack(stack);
      annotations.hasNoInfo(
        "/SingleTablePitrNoAnnotationStack/T",
        Match.stringLikeRegexp("exceeds 14"),
      );
    });
  });

  describe("GSI1 disabled", () => {
    it("omits GSI when enableGsi1=false", () => {
      const stack = makeStack("SingleTableNoGsiStack");
      new SingleTable(stack, "T", { tableName: "no-gsi-table", enableGsi1: false });
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "no-gsi-table",
      });
      // GlobalSecondaryIndexes should not be present
      const tables = template.findResources("AWS::DynamoDB::Table");
      const tableProps = Object.values(tables)[0]?.Properties as Record<string, unknown>;
      expect(tableProps?.["GlobalSecondaryIndexes"]).toBeUndefined();
    });
  });

  describe("streams enabled", () => {
    it("enables streams with NEW_AND_OLD_IMAGES", () => {
      const stack = makeStack("SingleTableStreamStack");
      new SingleTable(stack, "T", {
        tableName: "stream-table",
        stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      });
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        StreamSpecification: { StreamViewType: "NEW_AND_OLD_IMAGES" },
      });
    });
  });

  describe("custom thresholds", () => {
    it("propagates custom writeSpikeThreshold and readSpikeThreshold", () => {
      const stack = makeStack("SingleTableThresholdStack");
      new SingleTable(stack, "T", {
        tableName: "threshold-table",
        writeSpikeThreshold: 1000,
        readSpikeThreshold: 2000,
      });
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        MetricName: "ConsumedWriteCapacityUnits",
        Threshold: 1000,
      });
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        MetricName: "ConsumedReadCapacityUnits",
        Threshold: 2000,
      });
    });
  });

  describe("alarms disabled", () => {
    it("creates no alarms when both are disabled", () => {
      const stack = makeStack("SingleTableNoAlarmsStack");
      new SingleTable(stack, "T", {
        tableName: "no-alarms-table",
        alarms: { writeSpike: false, readSpike: false },
      });
      const template = Template.fromStack(stack);
      template.resourceCountIs("AWS::CloudWatch::Alarm", 0);
    });

    it("creates only the read alarm when write is disabled", () => {
      const stack = makeStack("SingleTableReadOnlyAlarmStack");
      new SingleTable(stack, "T", {
        tableName: "read-alarm-only",
        alarms: { writeSpike: false },
      });
      const template = Template.fromStack(stack);
      template.resourceCountIs("AWS::CloudWatch::Alarm", 1);
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        MetricName: "ConsumedReadCapacityUnits",
      });
    });
  });

  describe("alarm topic wiring", () => {
    it("adds SNS actions when alarmTopic is provided", () => {
      const stack = makeStack("SingleTableAlarmTopicStack");
      const topic = new sns.Topic(stack, "Topic");
      new SingleTable(stack, "T", { tableName: "alarm-topic-table", alarmTopic: topic });
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmActions: Match.arrayWith([{ Ref: Match.anyValue() }]),
      });
    });
  });

  describe("custom removal policy", () => {
    it("applies DESTROY removal policy when specified", () => {
      const stack = makeStack("SingleTableDestroyStack");
      new SingleTable(stack, "T", {
        tableName: "destroy-table",
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      const template = Template.fromStack(stack);
      const tables = template.findResources("AWS::DynamoDB::Table");
      for (const resource of Object.values(tables)) {
        expect((resource as { DeletionPolicy?: string })["DeletionPolicy"]).toBe("Delete");
      }
    });
  });
});
