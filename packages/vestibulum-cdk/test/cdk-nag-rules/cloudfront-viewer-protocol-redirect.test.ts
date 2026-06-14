import { describe, it, expect } from "vitest";
import { App, Stack } from "aws-cdk-lib";
import { CfnDistribution } from "aws-cdk-lib/aws-cloudfront";
import { NagRuleCompliance } from "cdk-nag";
import { CloudFrontViewerProtocolRedirect } from "../../lib/cdk-nag-rules/cloudfront-viewer-protocol-redirect.js";

describe("CloudFrontViewerProtocolRedirect", () => {
  it("has the correct function name", () => {
    expect(CloudFrontViewerProtocolRedirect.name).toBe("CloudFrontViewerProtocolRedirect");
  });

  it("returns NOT_APPLICABLE for non-CfnDistribution resources", () => {
    // Pass a plain object; the rule checks instanceof CfnDistribution.
    const result = CloudFrontViewerProtocolRedirect(
      {} as Parameters<typeof CloudFrontViewerProtocolRedirect>[0],
    );
    expect(result).toBe(NagRuleCompliance.NOT_APPLICABLE);
  });

  it("returns COMPLIANT for redirect-to-https default behavior", () => {
    const A = new App();
    const stack = new Stack(A, "S", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    const dist = new CfnDistribution(stack, "Dist", {
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
      },
    });
    const result = CloudFrontViewerProtocolRedirect(dist);
    expect(result).toBe(NagRuleCompliance.COMPLIANT);
  });

  it("returns COMPLIANT for https-only default behavior", () => {
    const A = new App();
    const stack = new Stack(A, "S", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    const dist = new CfnDistribution(stack, "Dist", {
      distributionConfig: {
        enabled: true,
        defaultCacheBehavior: {
          viewerProtocolPolicy: "https-only",
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
      },
    });
    const result = CloudFrontViewerProtocolRedirect(dist);
    expect(result).toBe(NagRuleCompliance.COMPLIANT);
  });

  it("returns NON_COMPLIANT for allow-all default behavior", () => {
    const A = new App();
    const stack = new Stack(A, "S", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    const dist = new CfnDistribution(stack, "Dist", {
      distributionConfig: {
        enabled: true,
        defaultCacheBehavior: {
          viewerProtocolPolicy: "allow-all",
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
      },
    });
    const result = CloudFrontViewerProtocolRedirect(dist);
    expect(result).toBe(NagRuleCompliance.NON_COMPLIANT);
  });

  it("returns NON_COMPLIANT when an extra cache behavior has allow-all", () => {
    const A = new App();
    const stack = new Stack(A, "S", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    const dist = new CfnDistribution(stack, "Dist", {
      distributionConfig: {
        enabled: true,
        defaultCacheBehavior: {
          viewerProtocolPolicy: "redirect-to-https",
          targetOriginId: "origin",
          forwardedValues: { queryString: false },
        },
        cacheBehaviors: [
          {
            pathPattern: "/api/*",
            viewerProtocolPolicy: "allow-all",
            targetOriginId: "origin",
            forwardedValues: { queryString: false },
          },
        ],
        origins: [
          {
            id: "origin",
            domainName: "example.com",
            s3OriginConfig: {},
          },
        ],
      },
    });
    const result = CloudFrontViewerProtocolRedirect(dist);
    expect(result).toBe(NagRuleCompliance.NON_COMPLIANT);
  });
});
