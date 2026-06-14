/**
 * Unit tests for the shared cost-DoS guard helper
 * (`lib/_internal/cost-dos-guard.ts`).
 *
 * The construct-level integration is covered by tests in
 * `test/magic-link-identity/` and `test/shared-distribution-identity/`.
 * This file exercises the helper directly to cover edge cases that
 * don't surface cleanly through either parent construct (e.g. the
 * consumer-supplied `alarmTopic` reuse path).
 */

import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as sns from "aws-cdk-lib/aws-sns";
import { describe, expect, it } from "vitest";

import { installCostDosGuard } from "../../lib/_internal/cost-dos-guard.js";

const TEST_ENV = { account: "123456789012", region: "eu-west-1" };

function makeStack(name: string): cdk.Stack {
  const app = new cdk.App();
  return new cdk.Stack(app, name, { env: TEST_ENV, stackName: name });
}

const POOL_ARN = "arn:aws:cognito-idp:eu-west-1:123456789012:userpool/eu-west-1_test123";
const POOL_ID = "eu-west-1_test123";

describe("installCostDosGuard (helper)", () => {
  it("throws when called with enabled: false (caller misuse)", () => {
    const stack = makeStack("GuardMisuseStack");
    expect(() =>
      installCostDosGuard(stack, {
        sesIdentityName: "example.com",
        cognitoPoolArn: POOL_ARN,
        cognitoPoolId: POOL_ID,
        guard: { enabled: false, sendsPerHourCap: 100 },
      }),
    ).toThrowError(/enabled: false/);
  });

  it("creates an internal SNS topic when consumer omits alarmTopic", () => {
    const stack = makeStack("GuardAutoTopicStack");
    const result = installCostDosGuard(stack, {
      sesIdentityName: "example.com",
      cognitoPoolArn: POOL_ARN,
      cognitoPoolId: POOL_ID,
      guard: { enabled: true, sendsPerHourCap: 100 },
    });
    const template = Template.fromStack(stack);
    expect(result.alarmTopic).toBeDefined();
    template.resourceCountIs("AWS::SNS::Topic", 1);
  });

  it("reuses a consumer-supplied alarmTopic (no extra topic created)", () => {
    const stack = makeStack("GuardReuseTopicStack");
    const consumerTopic = new sns.Topic(stack, "ConsumerOpsTopic");
    const result = installCostDosGuard(stack, {
      sesIdentityName: "example.com",
      cognitoPoolArn: POOL_ARN,
      cognitoPoolId: POOL_ID,
      guard: {
        enabled: true,
        sendsPerHourCap: 100,
        alarmTopic: consumerTopic,
      },
    });
    const template = Template.fromStack(stack);
    expect(result.alarmTopic).toBe(consumerTopic);
    // Only the consumer's topic — the helper did not create another.
    template.resourceCountIs("AWS::SNS::Topic", 1);
  });

  it("alarm uses GreaterThanThreshold and a 1-hour Sum statistic", () => {
    const stack = makeStack("GuardAlarmShapeStack");
    installCostDosGuard(stack, {
      sesIdentityName: "example.com",
      cognitoPoolArn: POOL_ARN,
      cognitoPoolId: POOL_ID,
      guard: { enabled: true, sendsPerHourCap: 750 },
    });
    Template.fromStack(stack).hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "AWS/SES",
      MetricName: "Send",
      Threshold: 750,
      Period: 3600,
      Statistic: "Sum",
      ComparisonOperator: "GreaterThanThreshold",
      EvaluationPeriods: 1,
      TreatMissingData: "notBreaching",
      Dimensions: [{ Name: "EmailIdentity", Value: "example.com" }],
    });
  });

  it("alarm action publishes to the resolved SNS topic", () => {
    const stack = makeStack("GuardAlarmActionStack");
    installCostDosGuard(stack, {
      sesIdentityName: "example.com",
      cognitoPoolArn: POOL_ARN,
      cognitoPoolId: POOL_ID,
      guard: { enabled: true, sendsPerHourCap: 100 },
    });
    // CloudFormation renders `AlarmActions` as a non-empty array of
    // SNS topic ARN references — match shape rather than the rendered
    // ref token, which is stack-id-dependent.
    const alarms = Template.fromStack(stack).findResources(
      "AWS::CloudWatch::Alarm",
    );
    const alarmList = Object.values(alarms) as Array<{
      Properties?: { AlarmActions?: unknown[] };
    }>;
    expect(alarmList).toHaveLength(1);
    const actions = alarmList[0]?.Properties?.AlarmActions ?? [];
    expect(actions.length).toBeGreaterThan(0);
  });

  it("self-defence handler IAM grant is scoped to the configured pool ARN", () => {
    const stack = makeStack("GuardIamScopeStack");
    installCostDosGuard(stack, {
      sesIdentityName: "example.com",
      cognitoPoolArn: POOL_ARN,
      cognitoPoolId: POOL_ID,
      guard: { enabled: true, sendsPerHourCap: 100, selfDefence: true },
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              "cognito-idp:DescribeUserPool",
              "cognito-idp:UpdateUserPool",
            ]),
            Resource: POOL_ARN,
          }),
        ]),
      }),
    });
  });

  it("self-defence handler env carries the configured pool id", () => {
    const stack = makeStack("GuardEnvStack");
    installCostDosGuard(stack, {
      sesIdentityName: "example.com",
      cognitoPoolArn: POOL_ARN,
      cognitoPoolId: POOL_ID,
      guard: { enabled: true, sendsPerHourCap: 100, selfDefence: true },
    });
    Template.fromStack(stack).hasResourceProperties("AWS::Lambda::Function", {
      Description: Match.stringLikeRegexp("cost-DoS guard"),
      Environment: {
        Variables: {
          VESTIBULUM_USER_POOL_ID: POOL_ID,
        },
      },
    });
  });

  it("self-defence handler is ARM64 / NodeJS 22.x / minimum memory", () => {
    const stack = makeStack("GuardLambdaShapeStack");
    installCostDosGuard(stack, {
      sesIdentityName: "example.com",
      cognitoPoolArn: POOL_ARN,
      cognitoPoolId: POOL_ID,
      guard: { enabled: true, sendsPerHourCap: 100, selfDefence: true },
    });
    Template.fromStack(stack).hasResourceProperties("AWS::Lambda::Function", {
      Description: Match.stringLikeRegexp("cost-DoS guard"),
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      MemorySize: 128,
      ReservedConcurrentExecutions: 1,
    });
  });

  it("no self-defence handler is provisioned when selfDefence is omitted", () => {
    const stack = makeStack("GuardNoSelfDefenceStack");
    installCostDosGuard(stack, {
      sesIdentityName: "example.com",
      cognitoPoolArn: POOL_ARN,
      cognitoPoolId: POOL_ID,
      guard: { enabled: true, sendsPerHourCap: 100 },
    });
    Template.fromStack(stack).resourceCountIs("AWS::Lambda::Function", 0);
  });

  it("throws when sendsPerHourCap is Infinity (not finite)", () => {
    const stack = makeStack("GuardInfStack");
    expect(() =>
      installCostDosGuard(stack, {
        sesIdentityName: "example.com",
        cognitoPoolArn: POOL_ARN,
        cognitoPoolId: POOL_ID,
        guard: { enabled: true, sendsPerHourCap: Number.POSITIVE_INFINITY },
      }),
    ).toThrowError(/sendsPerHourCap/);
  });
});
