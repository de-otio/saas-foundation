import { describe, it, expect } from "vitest";
import { App, Stack } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import { CfnPolicy, CfnRole } from "aws-cdk-lib/aws-iam";
import { NagRuleCompliance } from "cdk-nag";
import { LambdaEdgeNoLogs } from "../../lib/cdk-nag-rules/lambda-edge-no-logs.js";

describe("LambdaEdgeNoLogs", () => {
  it("has the correct function name", () => {
    expect(LambdaEdgeNoLogs.name).toBe("LambdaEdgeNoLogs");
  });

  it("returns NOT_APPLICABLE for a non-lambda resource", () => {
    const result = LambdaEdgeNoLogs({} as Parameters<typeof LambdaEdgeNoLogs>[0]);
    expect(result).toBe(NagRuleCompliance.NOT_APPLICABLE);
  });

  it("returns NOT_APPLICABLE for a regional (non-edge) Lambda function", () => {
    const app = new App();
    const stack = new Stack(app, "S", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    const fn = new lambda.Function(stack, "RegionalFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = () => {}"),
    });
    // Access the underlying CfnFunction.
    const cfnFn = fn.node.defaultChild as lambda.CfnFunction;
    const result = LambdaEdgeNoLogs(cfnFn);
    expect(result).toBe(NagRuleCompliance.NOT_APPLICABLE);
  });

  it("returns COMPLIANT for an edge Lambda with no log permissions", () => {
    const app = new App();
    const stack = new Stack(app, "S", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    // Naming the construct with 'edge' in the path triggers the edge heuristic.
    const fn = new lambda.Function(stack, "EdgeCheckAuthFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = () => {}"),
    });
    const cfnFn = fn.node.defaultChild as lambda.CfnFunction;
    const result = LambdaEdgeNoLogs(cfnFn);
    // No log permissions added — should be COMPLIANT.
    expect(result).toBe(NagRuleCompliance.COMPLIANT);
  });

  it("returns NON_COMPLIANT for an edge Lambda whose attached policy grants logs:PutLogEvents", () => {
    const app = new App();
    const stack = new Stack(app, "S", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    const fn = new lambda.Function(stack, "EdgeCheckAuthFn2", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = () => {}"),
    });
    // Add a policy to the execution role that grants PutLogEvents.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["logs:PutLogEvents"],
        resources: ["*"],
      }),
    );
    const cfnFn = fn.node.defaultChild as lambda.CfnFunction;
    const result = LambdaEdgeNoLogs(cfnFn);
    expect(result).toBe(NagRuleCompliance.NON_COMPLIANT);
  });

  it("returns NON_COMPLIANT for an edge Lambda whose role grants logs:* wildcard", () => {
    const app = new App();
    const stack = new Stack(app, "S", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    const fn = new lambda.Function(stack, "EdgeCheckAuthFnWild", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = () => {}"),
    });
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["logs:*"],
        resources: ["*"],
      }),
    );
    const cfnFn = fn.node.defaultChild as lambda.CfnFunction;
    const result = LambdaEdgeNoLogs(cfnFn);
    expect(result).toBe(NagRuleCompliance.NON_COMPLIANT);
  });

  it("returns COMPLIANT for an edge Lambda whose role has only Deny for log actions", () => {
    const app = new App();
    const stack = new Stack(app, "S", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    const fn = new lambda.Function(stack, "EdgeCheckAuthFnDeny", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = () => {}"),
    });
    // Deny statements must not count as "granting" log access.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: ["logs:PutLogEvents"],
        resources: ["*"],
      }),
    );
    const cfnFn = fn.node.defaultChild as lambda.CfnFunction;
    const result = LambdaEdgeNoLogs(cfnFn);
    expect(result).toBe(NagRuleCompliance.COMPLIANT);
  });

  it("returns COMPLIANT for an edge Lambda with a CfnRole that has no inline policies", () => {
    const app = new App();
    const stack = new Stack(app, "S", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    // Create a role with an empty inline policies list under the edge function scope.
    const role = new CfnRole(stack, "EdgeCheckAuthFnRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      },
    });
    const fn = new lambda.CfnFunction(stack, "EdgeCheckAuthCfnFn", {
      code: { zipFile: "exports.handler = () => {}" },
      handler: "index.handler",
      role: role.attrArn,
      runtime: "nodejs22.x",
    });
    const result = LambdaEdgeNoLogs(fn);
    expect(result).toBe(NagRuleCompliance.COMPLIANT);
  });

  it("returns NON_COMPLIANT for an edge Lambda with a CfnPolicy granting logs:CreateLogGroup", () => {
    const app = new App();
    const stack = new Stack(app, "S", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    const fn = new lambda.Function(stack, "EdgeCheckAuthFnPolicy", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = () => {}"),
    });
    // Create an explicit CfnPolicy under the function scope.
    new CfnPolicy(fn, "ExtraPolicy", {
      policyName: "LoggingPolicy",
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["logs:CreateLogGroup"],
            Resource: "*",
          },
        ],
      },
      roles: [fn.role!.roleName],
    });
    const cfnFn = fn.node.defaultChild as lambda.CfnFunction;
    const result = LambdaEdgeNoLogs(cfnFn);
    expect(result).toBe(NagRuleCompliance.NON_COMPLIANT);
  });
});
