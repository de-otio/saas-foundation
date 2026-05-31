import { describe, it, expect } from "vitest";
import { App, Aspects, Stack } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as s3 from "aws-cdk-lib/aws-s3";
import { VestibulumChecks } from "../../lib/cdk-nag-rules/vestibulum-checks.js";

describe("VestibulumChecks", () => {
  it("is instantiable", () => {
    const checks = new VestibulumChecks();
    expect(checks).toBeDefined();
  });

  it("has packName set to Vestibulum", () => {
    const checks = new VestibulumChecks();
    expect((checks as unknown as { packName: string }).packName).toBe("Vestibulum");
  });

  it("can be applied to an app without throwing on empty stacks", () => {
    const app = new App();
    new Stack(app, "TestStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    Aspects.of(app).add(new VestibulumChecks());
    // Should synth without error on an empty stack.
    expect(() => app.synth()).not.toThrow();
  });

  it("fires on a CloudFront distribution with incorrect viewer protocol", () => {
    const app = new App();
    const stack = new Stack(app, "TestStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });

    const bucket = new s3.Bucket(stack, "Bucket");
    new cloudfront.CloudFrontWebDistribution(stack, "Dist", {
      originConfigs: [
        {
          s3OriginSource: { s3BucketSource: bucket },
          behaviors: [
            {
              isDefaultBehavior: true,
              viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.ALLOW_ALL, // non-compliant
            },
          ],
        },
      ],
    });

    Aspects.of(app).add(new VestibulumChecks());
    // NagPack errors manifest as Annotations; they don't throw during synth
    // but appear in the cloud assembly metadata.
    const assembly = app.synth();
    const messages = assembly.stacks[0]?.messages ?? [];
    const nagMessages = messages.filter((m) => m.entry.data?.toString().includes("VST2"));
    expect(nagMessages.length).toBeGreaterThan(0);
  });
});
