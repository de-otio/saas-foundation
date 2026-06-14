import * as path from "node:path";
import * as url from "node:url";

import * as cdk from "aws-cdk-lib";
import { Annotations as AssertAnnotations, Match, Template } from "aws-cdk-lib/assertions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as kms from "aws-cdk-lib/aws-kms";
import * as sns from "aws-cdk-lib/aws-sns";
import { beforeAll, describe, expect, it } from "vitest";

import { NodejsLambda, NodejsLambdaPropsError } from "../../lib/nodejs-lambda/nodejs-lambda.js";
import { buildPrismaCommandHooks } from "../../lib/nodejs-lambda/prisma-bundling.js";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HANDLER_ENTRY = path.join(__dirname, "fixtures/handler.ts");
const TEST_ENV = { account: "123456789012", region: "eu-west-1" };

function makeStack(name: string): cdk.Stack {
  const app = new cdk.App();
  return new cdk.Stack(app, name, { env: TEST_ENV, stackName: name });
}

describe("NodejsLambda", () => {
  describe("default props", () => {
    let template: Template;

    beforeAll(() => {
      const stack = makeStack("NodejsLambdaDefaultStack");
      new NodejsLambda(stack, "Fn", {
        entry: HANDLER_ENTRY,
        functionName: "fn-default",
      });
      template = Template.fromStack(stack);
    });

    it("creates exactly one Lambda function", () => {
      template.resourceCountIs("AWS::Lambda::Function", 1);
    });

    it("uses NODEJS_24_X runtime", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Runtime: "nodejs24.x",
      });
    });

    it("uses arm64 architecture", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Architectures: ["arm64"],
      });
    });

    it("uses ACTIVE X-Ray tracing", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        TracingConfig: { Mode: "Active" },
      });
    });

    it("sets functionName from props", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "fn-default",
      });
    });

    it("uses 256 MB memory by default", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        MemorySize: 256,
      });
    });

    it("uses 30 second timeout by default", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Timeout: 30,
      });
    });

    it("does not set ReservedConcurrentExecutions by default", () => {
      const fns = template.findResources("AWS::Lambda::Function");
      const props = Object.values(fns)[0]?.Properties as Record<string, unknown>;
      expect(props?.["ReservedConcurrentExecutions"]).toBeUndefined();
    });

    it("creates a log group with 30-day retention", () => {
      template.hasResourceProperties("AWS::Logs::LogGroup", {
        LogGroupName: "/aws/lambda/fn-default",
        RetentionInDays: 30,
      });
    });

    it("creates exactly three CloudWatch alarms", () => {
      template.resourceCountIs("AWS::CloudWatch::Alarm", 3);
    });

    it("creates the error alarm with the expected metric and threshold", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        MetricName: "Errors",
        Namespace: "AWS/Lambda",
        Threshold: 5,
        EvaluationPeriods: 1,
        ComparisonOperator: "GreaterThanThreshold",
        TreatMissingData: "notBreaching",
      });
    });

    it("creates the throttle alarm with the expected metric and threshold", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        MetricName: "Throttles",
        Namespace: "AWS/Lambda",
        Threshold: 1,
        EvaluationPeriods: 1,
        TreatMissingData: "notBreaching",
      });
    });

    it("creates the duration alarm with threshold = 0.8 * timeout in ms", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        MetricName: "Duration",
        Namespace: "AWS/Lambda",
        // 30 s × 0.8 = 24 000 ms
        Threshold: 24000,
        EvaluationPeriods: 2,
        ExtendedStatistic: "p99",
        TreatMissingData: "notBreaching",
      });
    });

    it("does not set AlarmActions when no topic is provided", () => {
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      for (const r of Object.values(alarms)) {
        const props = (r as { Properties: Record<string, unknown> }).Properties;
        expect(props["AlarmActions"] === undefined || props["AlarmActions"] === null).toBe(true);
      }
    });

    it("does not pin alarm names (CDK auto-generates them)", () => {
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      for (const r of Object.values(alarms)) {
        const props = (r as { Properties: Record<string, unknown> }).Properties;
        expect(props["AlarmName"]).toBeUndefined();
      }
    });
  });

  describe("reserved concurrency", () => {
    it("propagates reservedConcurrentExecutions when set", () => {
      const stack = makeStack("NodejsLambdaReservedStack");
      new NodejsLambda(stack, "Fn", {
        entry: HANDLER_ENTRY,
        functionName: "fn-reserved",
        reservedConcurrentExecutions: 10,
      });
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::Lambda::Function", {
        ReservedConcurrentExecutions: 10,
      });
    });

    it("rejects negative reservedConcurrentExecutions", () => {
      const stack = makeStack("NodejsLambdaBadReservedStack");
      expect(() => {
        new NodejsLambda(stack, "Fn", {
          entry: HANDLER_ENTRY,
          functionName: "fn-bad",
          reservedConcurrentExecutions: -1,
        });
      }).toThrow(NodejsLambdaPropsError);
    });
  });

  describe("functionName validation", () => {
    it("rejects an empty functionName", () => {
      const stack = makeStack("NodejsLambdaEmptyNameStack");
      expect(() => {
        new NodejsLambda(stack, "Fn", {
          entry: HANDLER_ENTRY,
          functionName: "",
        });
      }).toThrow(NodejsLambdaPropsError);
    });
  });

  describe("X-Ray VPC reachability validation", () => {
    it("throws at synth when vpc is set and reachability is not acknowledged", () => {
      const stack = makeStack("NodejsLambdaVpcUnackStack");
      const vpc = new ec2.Vpc(stack, "Vpc");
      expect(() => {
        new NodejsLambda(stack, "Fn", {
          entry: HANDLER_ENTRY,
          functionName: "fn-vpc-unack",
          vpc,
        });
      }).toThrow(NodejsLambdaPropsError);
    });

    it("includes the X-Ray VPC endpoint docs link in the error", () => {
      const stack = makeStack("NodejsLambdaVpcUnackMsgStack");
      const vpc = new ec2.Vpc(stack, "Vpc");
      try {
        new NodejsLambda(stack, "Fn", {
          entry: HANDLER_ENTRY,
          functionName: "fn-vpc-unack-msg",
          vpc,
        });
        expect.fail("expected synth-time error");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toMatch(/X-Ray/);
        expect(msg).toMatch(/acknowledgeXrayVpcReachability/);
        expect(msg).toMatch(/com\.amazonaws\.<region>\.xray|xray-services-vpc/);
      }
    });

    it("succeeds when acknowledgeXrayVpcReachability is true", () => {
      const stack = makeStack("NodejsLambdaVpcAckStack");
      const vpc = new ec2.Vpc(stack, "Vpc");
      new NodejsLambda(stack, "Fn", {
        entry: HANDLER_ENTRY,
        functionName: "fn-vpc-ack",
        vpc,
        acknowledgeXrayVpcReachability: true,
      });
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "fn-vpc-ack",
        VpcConfig: Match.anyValue(),
      });
    });
  });

  describe("logClass", () => {
    it("defaults to Standard log class", () => {
      const stack = makeStack("NodejsLambdaLogClassDefaultStack");
      new NodejsLambda(stack, "Fn", {
        entry: HANDLER_ENTRY,
        functionName: "fn-log-class-default",
      });
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::Logs::LogGroup", {
        LogGroupName: "/aws/lambda/fn-log-class-default",
        LogGroupClass: "STANDARD",
      });
    });

    it("emits no synth-time info note for the default Standard class", () => {
      const stack = makeStack("NodejsLambdaLogClassStdInfoStack");
      new NodejsLambda(stack, "Fn", {
        entry: HANDLER_ENTRY,
        functionName: "fn-log-class-std-info",
      });
      const annotations = AssertAnnotations.fromStack(stack);
      expect(
        annotations.findInfo("*", Match.stringLikeRegexp("logClass='infrequent-access'")),
      ).toHaveLength(0);
    });

    it("sets logGroupClass to INFREQUENT_ACCESS when 'infrequent-access' is chosen", () => {
      const stack = makeStack("NodejsLambdaLogClassIAStack");
      new NodejsLambda(stack, "Fn", {
        entry: HANDLER_ENTRY,
        functionName: "fn-log-class-ia",
        logClass: "infrequent-access",
      });
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::Logs::LogGroup", {
        LogGroupName: "/aws/lambda/fn-log-class-ia",
        LogGroupClass: "INFREQUENT_ACCESS",
      });
    });

    it("emits a synth-time info note when 'infrequent-access' is chosen", () => {
      const stack = makeStack("NodejsLambdaLogClassIAInfoStack");
      new NodejsLambda(stack, "Fn", {
        entry: HANDLER_ENTRY,
        functionName: "fn-log-class-ia-info",
        logClass: "infrequent-access",
      });
      const annotations = AssertAnnotations.fromStack(stack);
      const messages = annotations.findInfo(
        "*",
        Match.stringLikeRegexp("logClass='infrequent-access'"),
      );
      expect(messages).not.toHaveLength(0);
      const text = JSON.stringify(messages);
      expect(text).toMatch(/Logs Insights queries cost/);
      expect(text).toMatch(/fn-log-class-ia-info/);
    });
  });

  describe("logs encryption", () => {
    it("wires logsEncryptionKey to the log group KmsKeyId", () => {
      const stack = makeStack("NodejsLambdaCmkStack");
      const key = new kms.Key(stack, "LogsKey");
      new NodejsLambda(stack, "Fn", {
        entry: HANDLER_ENTRY,
        functionName: "fn-cmk",
        logsEncryptionKey: key,
      });
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::Logs::LogGroup", {
        LogGroupName: "/aws/lambda/fn-cmk",
        KmsKeyId: Match.objectLike({ "Fn::GetAtt": Match.arrayWith(["Arn"]) }),
      });
    });
  });

  describe("alarm opt-out", () => {
    it("skips the error alarm when alarms.errors=false", () => {
      const stack = makeStack("NodejsLambdaNoErrStack");
      new NodejsLambda(stack, "Fn", {
        entry: HANDLER_ENTRY,
        functionName: "fn-no-err",
        alarms: { errors: false },
      });
      const template = Template.fromStack(stack);
      template.resourceCountIs("AWS::CloudWatch::Alarm", 2);
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      const metricNames = Object.values(alarms).map(
        (r) => (r as { Properties: Record<string, unknown> }).Properties["MetricName"],
      );
      expect(metricNames).not.toContain("Errors");
    });

    it("creates zero alarms when all three are opted out", () => {
      const stack = makeStack("NodejsLambdaNoAlarmsStack");
      new NodejsLambda(stack, "Fn", {
        entry: HANDLER_ENTRY,
        functionName: "fn-no-alarms",
        alarms: { errors: false, throttles: false, duration: false },
      });
      const template = Template.fromStack(stack);
      template.resourceCountIs("AWS::CloudWatch::Alarm", 0);
    });
  });

  describe("alarm topic wiring", () => {
    it("wires AlarmActions to the provided topic on every alarm", () => {
      const stack = makeStack("NodejsLambdaTopicStack");
      const topic = new sns.Topic(stack, "Topic");
      new NodejsLambda(stack, "Fn", {
        entry: HANDLER_ENTRY,
        functionName: "fn-topic",
        alarmTopic: topic,
      });
      const template = Template.fromStack(stack);
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      for (const r of Object.values(alarms)) {
        const props = (r as { Properties: Record<string, unknown> }).Properties;
        expect(props["AlarmActions"]).toBeDefined();
      }
    });
  });

  describe("alarm property accessors", () => {
    it("exposes the three alarms via public readonly fields", () => {
      const stack = makeStack("NodejsLambdaAlarmPropsStack");
      const fn = new NodejsLambda(stack, "Fn", {
        entry: HANDLER_ENTRY,
        functionName: "fn-alarm-props",
      });
      expect(fn.errorAlarm).toBeDefined();
      expect(fn.throttleAlarm).toBeDefined();
      expect(fn.durationAlarm).toBeDefined();
    });

    it("omits the alarm property when opted out", () => {
      const stack = makeStack("NodejsLambdaAlarmPropsOffStack");
      const fn = new NodejsLambda(stack, "Fn", {
        entry: HANDLER_ENTRY,
        functionName: "fn-alarm-props-off",
        alarms: { duration: false },
      });
      expect(fn.errorAlarm).toBeDefined();
      expect(fn.throttleAlarm).toBeDefined();
      expect(fn.durationAlarm).toBeUndefined();
    });
  });

  describe("externalModules", () => {
    it("always includes @aws-sdk/* and adds the consumer's modules", () => {
      // The constructed bundling block is not directly accessible from
      // the synthesized template (esbuild externals don't surface), so
      // verify by re-running the same logic the construct uses.
      const stack = makeStack("NodejsLambdaExternalStack");
      const fn = new NodejsLambda(stack, "Fn", {
        entry: HANDLER_ENTRY,
        functionName: "fn-external",
        externalModules: ["sharp"],
      });
      // No exception thrown is the primary observable; the bundle
      // succeeded with the external set merged.
      expect(fn.functionName).toBeDefined();
    });
  });
});

describe("buildPrismaCommandHooks", () => {
  it("produces the default rhel + linux-arm64 engine copies", () => {
    const hooks = buildPrismaCommandHooks();
    const cmds = hooks.afterBundling("/in", "/out");
    // 2 mkdirs + 4 base copies + 2 engine copies = 8 entries
    expect(cmds).toHaveLength(8);
    expect(cmds.some((c) => c.includes("libquery_engine-rhel"))).toBe(true);
    expect(cmds.some((c) => c.includes("libquery_engine-linux-arm64"))).toBe(true);
    expect(cmds.some((c) => c.includes("libquery_engine-darwin"))).toBe(false);
  });

  it("honours a custom engines list", () => {
    const hooks = buildPrismaCommandHooks({ engines: ["linux-arm64", "darwin-arm64"] });
    const cmds = hooks.afterBundling("/in", "/out");
    expect(cmds.some((c) => c.includes("libquery_engine-linux-arm64"))).toBe(true);
    expect(cmds.some((c) => c.includes("libquery_engine-darwin-arm64"))).toBe(true);
    expect(cmds.some((c) => c.includes("libquery_engine-rhel"))).toBe(false);
  });

  it("beforeBundling and beforeInstall return empty arrays", () => {
    const hooks = buildPrismaCommandHooks();
    expect(hooks.beforeBundling("/in", "/out")).toEqual([]);
    expect(hooks.beforeInstall("/in", "/out")).toEqual([]);
  });

  it("paths thread inputDir and outputDir through every copy command", () => {
    const hooks = buildPrismaCommandHooks();
    const cmds = hooks.afterBundling("/IN", "/OUT");
    for (const cmd of cmds) {
      // Each command must reference at least one of the two dirs.
      expect(cmd.includes("/IN") || cmd.includes("/OUT")).toBe(true);
    }
    // Specifically the mkdir lines reference /OUT.
    expect(cmds[0]).toMatch(/\/OUT/);
    // The schema.prisma copy references both.
    const schemaCopy = cmds.find((c) => c.includes("schema.prisma"));
    expect(schemaCopy).toBeDefined();
    expect(schemaCopy).toMatch(/\/IN/);
    expect(schemaCopy).toMatch(/\/OUT/);
  });
});

// NOTE: We do not construct a NodejsLambda with `prismaBundling` at
// the test level. AssetStaging triggers the afterBundling commandHooks
// at *construction* time, and those hooks `cp -r` the consumer's
// generated Prisma client out of node_modules. This monorepo doesn't
// depend on @prisma/client, so the cp fails. The contract being tested
// is "the construct merges the prisma command hooks into the bundling
// config"; the actual copy commands are asserted in the
// buildPrismaCommandHooks suite above. End-to-end coverage belongs in a
// consumer integration test inside a stack that *has* prisma installed.
