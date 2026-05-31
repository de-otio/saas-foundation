import { describe, it, expect } from "vitest";
import { App, Aspects, Stack, Token } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { CfnDistribution } from "aws-cdk-lib/aws-cloudfront";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";
import { WafRequiredAspect } from "../../lib/aspects/waf-required.js";
import { markVestibulumSubtreeRoot } from "../../lib/aspects/subtree-marker.js";

function makeApp(markedAsVestibulum: boolean, webAclId?: string): App {
  const app = new App();
  // WAF must be in us-east-1 for CloudFront.
  const usEast1Stack = new Stack(app, "WafStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });

  const webAcl = new wafv2.CfnWebACL(usEast1Stack, "WebAcl", {
    defaultAction: { allow: {} },
    scope: "CLOUDFRONT",
    visibilityConfig: {
      cloudWatchMetricsEnabled: true,
      metricName: "TestWaf",
      sampledRequestsEnabled: false,
    },
    rules: [],
  });

  const stack = new Stack(app, "TestStack", {
    env: { account: "123456789012", region: "eu-west-1" },
  });

  let root: Construct = stack;
  if (markedAsVestibulum) {
    root = new Construct(stack, "VestibulumRoot");
    markVestibulumSubtreeRoot(root);
  }

  const bucket = new s3.Bucket(root, "Bucket");
  new cloudfront.CloudFrontWebDistribution(root, "Dist", {
    originConfigs: [
      {
        s3OriginSource: { s3BucketSource: bucket },
        behaviors: [{ isDefaultBehavior: true }],
      },
    ],
    webACLId: webAclId ?? webAcl.attrArn,
  });

  Aspects.of(app).add(new WafRequiredAspect());
  return app;
}

describe("WafRequiredAspect", () => {
  it("passes when distribution has a WAF ACL", () => {
    const app = makeApp(true, "arn:aws:wafv2:us-east-1:123456789012:global/webacl/TestAcl/abc");
    expect(() => app.synth()).not.toThrow();
  });

  it("is inert for distributions outside a Vestibulum subtree", () => {
    const app = makeApp(false, undefined);
    // Not marked as Vestibulum — aspect should be inert.
    expect(() => app.synth()).not.toThrow();
  });

  it("throws for a Vestibulum distribution with no webAclId (undefined)", () => {
    const app = new App();
    const stack = new Stack(app, "TestStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    const root = new Construct(stack, "VestibulumRoot");
    markVestibulumSubtreeRoot(root);

    new CfnDistribution(root, "Dist", {
      distributionConfig: {
        enabled: true,
        defaultCacheBehavior: {
          viewerProtocolPolicy: "redirect-to-https",
          targetOriginId: "origin",
          forwardedValues: { queryString: false },
        },
        origins: [
          {
            id: "origin",
            domainName: "example.com",
            s3OriginConfig: {},
          },
        ],
        // webAclId intentionally omitted
      },
    });

    Aspects.of(app).add(new WafRequiredAspect());
    expect(() => app.synth()).toThrow(/WafRequiredAspect/);
  });

  it("throws for a Vestibulum distribution with an empty webAclId string", () => {
    const app = new App();
    const stack = new Stack(app, "TestStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    const root = new Construct(stack, "VestibulumRoot");
    markVestibulumSubtreeRoot(root);

    new CfnDistribution(root, "Dist", {
      distributionConfig: {
        enabled: true,
        defaultCacheBehavior: {
          viewerProtocolPolicy: "redirect-to-https",
          targetOriginId: "origin",
          forwardedValues: { queryString: false },
        },
        origins: [
          {
            id: "origin",
            domainName: "example.com",
            s3OriginConfig: {},
          },
        ],
        webAclId: "",
      },
    });

    Aspects.of(app).add(new WafRequiredAspect());
    expect(() => app.synth()).toThrow(/WafRequiredAspect/);
  });

  it("is inert when distributionConfig is a Token (unresolved cross-stack ref)", () => {
    const app = new App();
    const refStack = new Stack(app, "RefStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    const stack = new Stack(app, "TestStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    const root = new Construct(stack, "VestibulumRoot");
    markVestibulumSubtreeRoot(root);

    // Use a Token as the distributionConfig to trigger the isUnresolved path.
    const tokenValue = Token.asAny(refStack.toJsonString({ key: "value" }));
    const _dist = new CfnDistribution(root, "Dist", {
      distributionConfig: tokenValue,
    });

    // The aspect should skip (not throw) because config is a Token.
    Aspects.of(app).add(new WafRequiredAspect());
    // Synth may throw for other reasons (malformed template) but not our aspect error.
    let caught: unknown;
    try {
      app.synth();
    } catch (e) {
      caught = e;
    }
    if (caught !== undefined) {
      expect((caught as Error).message).not.toMatch(/WafRequiredAspect/);
    }
  });
});
