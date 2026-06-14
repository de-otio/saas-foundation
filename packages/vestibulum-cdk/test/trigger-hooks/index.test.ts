import { describe, it, expect } from "vitest";
import { App, Stack } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import {
  validateTriggerLambdaLocality,
  attachTriggerHooks,
} from "../../lib/trigger-hooks/index.js";

describe("trigger-hooks", () => {
  describe("validateTriggerLambdaLocality", () => {
    it("passes for a Lambda in the same account and region", () => {
      const app = new App();
      const stack = new Stack(app, "TestStack", {
        env: { account: "123456789012", region: "eu-west-1" },
      });
      const fn = lambda.Function.fromFunctionArn(
        stack,
        "Fn",
        "arn:aws:lambda:eu-west-1:123456789012:function:my-fn",
      );
      expect(() => validateTriggerLambdaLocality(fn, stack)).not.toThrow();
    });

    it("throws for a Lambda in a different region", () => {
      const app = new App();
      const stack = new Stack(app, "TestStack", {
        env: { account: "123456789012", region: "eu-west-1" },
      });
      const fn = lambda.Function.fromFunctionArn(
        stack,
        "Fn",
        "arn:aws:lambda:us-east-1:123456789012:function:my-fn",
      );
      expect(() => validateTriggerLambdaLocality(fn, stack)).toThrow(/region/i);
    });

    it("throws for a Lambda in a different account", () => {
      const app = new App();
      const stack = new Stack(app, "TestStack", {
        env: { account: "123456789012", region: "eu-west-1" },
      });
      const fn = lambda.Function.fromFunctionArn(
        stack,
        "Fn",
        "arn:aws:lambda:eu-west-1:999999999999:function:my-fn",
      );
      expect(() => validateTriggerLambdaLocality(fn, stack)).toThrow(/account/i);
    });

    it("skips validation for unresolved CDK tokens", () => {
      const app = new App();
      const stack = new Stack(app, "TestStack", {
        env: { account: "123456789012", region: "eu-west-1" },
      });
      // Token-based ARN contains '${'.
      const fn = lambda.Function.fromFunctionArn(
        stack,
        "Fn",
        "arn:aws:lambda:${Token[AWS.Region.0]}:${Token[AWS.AccountId.0]}:function:my-fn",
      );
      expect(() => validateTriggerLambdaLocality(fn, stack)).not.toThrow();
    });
  });

  describe("attachTriggerHooks", () => {
    it("attaches no triggers when props are empty", () => {
      const app = new App();
      const stack = new Stack(app, "TestStack", {
        env: { account: "123456789012", region: "eu-west-1" },
      });
      const pool = new cognito.UserPool(stack, "Pool");
      // Should not throw with empty props.
      expect(() => attachTriggerHooks(pool, {})).not.toThrow();
    });

    it("attaches preTokenGeneration trigger", () => {
      const app = new App();
      const stack = new Stack(app, "TestStack", {
        env: { account: "123456789012", region: "eu-west-1" },
      });
      const pool = new cognito.UserPool(stack, "Pool");
      const fn = new lambda.Function(stack, "PreTokenFn", {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: "index.handler",
        code: lambda.Code.fromInline("exports.handler = () => {}"),
      });
      expect(() => attachTriggerHooks(pool, { preTokenGeneration: fn })).not.toThrow();
      expect(() => app.synth()).not.toThrow();
    });

    it("attaches postConfirmation trigger", () => {
      const app = new App();
      const stack = new Stack(app, "TestStack", {
        env: { account: "123456789012", region: "eu-west-1" },
      });
      const pool = new cognito.UserPool(stack, "Pool");
      const fn = new lambda.Function(stack, "PostConfirmFn", {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: "index.handler",
        code: lambda.Code.fromInline("exports.handler = () => {}"),
      });
      expect(() => attachTriggerHooks(pool, { postConfirmation: fn })).not.toThrow();
      expect(() => app.synth()).not.toThrow();
    });
  });
});
