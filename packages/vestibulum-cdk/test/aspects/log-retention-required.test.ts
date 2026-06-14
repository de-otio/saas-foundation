import { describe, it, expect } from "vitest";
import { App, Aspects, Stack } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { LogRetentionRequiredAspect } from "../../lib/aspects/log-retention-required.js";
import { markVestibulumSubtreeRoot } from "../../lib/aspects/subtree-marker.js";

function makeStackWithLambdaAndLogGroup(
  retentionDays: number | undefined,
  markedAsVestibulum: boolean,
  isEdge = false,
): App {
  const app = new App();
  const stack = new Stack(app, "TestStack", {
    env: { account: "123456789012", region: "eu-west-1" },
  });

  let root: Construct = stack;
  if (markedAsVestibulum) {
    root = new Construct(stack, "VestibulumRoot");
    markVestibulumSubtreeRoot(root);
  }

  // The edge heuristic checks the construct path for 'edge' or 'checkauth'.
  // Use an edge-indicating construct ID to trigger the edge path.
  const constructId = isEdge ? "EdgeCheckAuthLogGroup" : "LambdaLogGroup";
  const lgName = isEdge ? "/aws/lambda/us-east-1.check-auth" : "/aws/lambda/auth-verify";

  if (retentionDays !== undefined) {
    new logs.LogGroup(root, constructId, {
      logGroupName: lgName,
      retention: retentionDays,
      removalPolicy: undefined as never,
    });
  } else {
    // Create a log group without retention — using L1 directly.
    const cfnLg = new logs.CfnLogGroup(root, constructId, {
      logGroupName: lgName,
    });
    void cfnLg; // used for side effects
  }

  Aspects.of(app).add(new LogRetentionRequiredAspect());
  return app;
}

describe("LogRetentionRequiredAspect", () => {
  it("passes for a regional log group with retention >= 30 days", () => {
    const app = makeStackWithLambdaAndLogGroup(30, true);
    expect(() => app.synth()).not.toThrow();
  });

  it("passes for a regional log group with retention > 30 days", () => {
    const app = makeStackWithLambdaAndLogGroup(90, true);
    expect(() => app.synth()).not.toThrow();
  });

  it("throws for a regional log group with retention < 30 days", () => {
    const app = makeStackWithLambdaAndLogGroup(7, true);
    expect(() => app.synth()).toThrow(/RetentionInDays/);
  });

  it("throws for a log group with no retention", () => {
    const app = makeStackWithLambdaAndLogGroup(undefined, true);
    expect(() => app.synth()).toThrow(/RetentionInDays/);
  });

  it("throws for an edge log group with retention != 1 day", () => {
    const app = makeStackWithLambdaAndLogGroup(7, true, true);
    expect(() => app.synth()).toThrow(/RetentionInDays/);
  });

  it("passes for an edge log group with retention = 1 day", () => {
    const app = makeStackWithLambdaAndLogGroup(1, true, true);
    expect(() => app.synth()).not.toThrow();
  });

  it("is inert for log groups outside a Vestibulum subtree", () => {
    const app = makeStackWithLambdaAndLogGroup(undefined, false);
    expect(() => app.synth()).not.toThrow();
  });

  describe("CfnFunction without paired log group", () => {
    it("throws for a Lambda function with no paired log group", () => {
      const app = new App();
      const stack = new Stack(app, "TestStack", {
        env: { account: "123456789012", region: "eu-west-1" },
      });
      const root = new Construct(stack, "VestibulumRoot");
      markVestibulumSubtreeRoot(root);

      // Create a Lambda function without an explicit log group.
      new lambda.CfnFunction(root, "MyFn", {
        code: { zipFile: "exports.handler = () => {}" },
        handler: "index.handler",
        role: "arn:aws:iam::123456789012:role/lambda-role",
        runtime: "nodejs22.x",
        functionName: "my-unique-function-name-no-log-group",
      });

      Aspects.of(app).add(new LogRetentionRequiredAspect());
      expect(() => app.synth()).toThrow(/CfnLogGroup|CfnFunction/);
    });
  });

  describe("edge log group detection via log group name", () => {
    it("detects edge by us-east-1. prefix in log group name", () => {
      const app = new App();
      const stack = new Stack(app, "TestStack", {
        env: { account: "123456789012", region: "eu-west-1" },
      });
      const root = new Construct(stack, "VestibulumRoot");
      markVestibulumSubtreeRoot(root);

      // Log group name with us-east-1. prefix triggers edge detection.
      new logs.CfnLogGroup(root, "EdgeLogGroup", {
        logGroupName: "/aws/lambda/us-east-1.check-auth-fn",
        retentionInDays: 1,
      });

      Aspects.of(app).add(new LogRetentionRequiredAspect());
      expect(() => app.synth()).not.toThrow();
    });
  });
});
