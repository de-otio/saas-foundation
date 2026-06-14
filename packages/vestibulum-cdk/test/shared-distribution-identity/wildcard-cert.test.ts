/**
 * Targeted tests for `WildcardCert` covering edge branches not
 * exercised by `identity-props.test.ts`.
 */

import * as cdk from "aws-cdk-lib";
import { Annotations as AssertAnnotations, Match } from "aws-cdk-lib/assertions";
import * as route53 from "aws-cdk-lib/aws-route53";
import { describe, expect, it } from "vitest";

import {
  WildcardCert,
  WildcardCertConfigError,
} from "../../lib/shared-distribution-identity/index.js";

function makeStack(name: string, region = "us-east-1"): cdk.Stack {
  const app = new cdk.App();
  return new cdk.Stack(app, name, {
    env: { account: "123456789012", region },
    stackName: name,
    crossRegionReferences: true,
  });
}

describe("WildcardCert — error paths", () => {
  it("throws when neither hostedZone nor existingWildcardCertificateArn is set", () => {
    const stack = makeStack("NoCertCfgStack");
    expect(
      () =>
        new WildcardCert(stack, "Wildcard", {
          tenantSubdomainParent: "tenants.example.com",
        }),
    ).toThrowError(WildcardCertConfigError);
  });

  it("throws when both hostedZone AND existingWildcardCertificateArn are set", () => {
    const stack = makeStack("BothCertCfgStack");
    const zone = route53.HostedZone.fromHostedZoneAttributes(stack, "Zone", {
      hostedZoneId: "Z123456789",
      zoneName: "tenants.example.com",
    });
    expect(
      () =>
        new WildcardCert(stack, "Wildcard", {
          tenantSubdomainParent: "tenants.example.com",
          hostedZone: zone,
          existingWildcardCertificateArn:
            "arn:aws:acm:us-east-1:123456789012:certificate/abcd-1234",
        }),
    ).toThrowError(WildcardCertConfigError);
  });
});

describe("WildcardCert — cross-region annotation", () => {
  it("emits an info annotation when stack is not us-east-1", () => {
    const stack = makeStack("CrossRegionAnnotationStack", "eu-central-1");
    const zone = route53.HostedZone.fromHostedZoneAttributes(stack, "Zone", {
      hostedZoneId: "Z123456789",
      zoneName: "tenants.example.com",
    });
    new WildcardCert(stack, "Wildcard", {
      tenantSubdomainParent: "tenants.example.com",
      hostedZone: zone,
    });

    const info = AssertAnnotations.fromStack(stack).findInfo(
      "/CrossRegionAnnotationStack/Wildcard",
      Match.stringLikeRegexp("CloudFront requires us-east-1"),
    );
    expect(Array.isArray(info)).toBe(true);
    expect(info.length).toBeGreaterThan(0);
  });

  it("does NOT emit the cross-region annotation when stack is us-east-1", () => {
    const stack = makeStack("UsEast1Stack", "us-east-1");
    const zone = route53.HostedZone.fromHostedZoneAttributes(stack, "Zone", {
      hostedZoneId: "Z123456789",
      zoneName: "tenants.example.com",
    });
    new WildcardCert(stack, "Wildcard", {
      tenantSubdomainParent: "tenants.example.com",
      hostedZone: zone,
    });

    const info = AssertAnnotations.fromStack(stack).findInfo(
      "/UsEast1Stack/Wildcard",
      Match.stringLikeRegexp("CloudFront requires us-east-1"),
    );
    expect(info.length).toBe(0);
  });
});

describe("WildcardCert — exposed fields", () => {
  it("exposes subjectAlternativeNames as an empty array when importing an existing cert", () => {
    const stack = makeStack("ImportSansStack");
    const cert = new WildcardCert(stack, "Wildcard", {
      tenantSubdomainParent: "tenants.example.com",
      existingWildcardCertificateArn:
        "arn:aws:acm:us-east-1:123456789012:certificate/abcd-1234",
    });
    expect([...cert.subjectAlternativeNames]).toEqual([]);
  });

  it("exposes subjectAlternativeNames including the parent by default when creating", () => {
    const stack = makeStack("CreateSansStack");
    const zone = route53.HostedZone.fromHostedZoneAttributes(stack, "Zone", {
      hostedZoneId: "Z123456789",
      zoneName: "tenants.example.com",
    });
    const cert = new WildcardCert(stack, "Wildcard", {
      tenantSubdomainParent: "tenants.example.com",
      hostedZone: zone,
    });
    expect([...cert.subjectAlternativeNames]).toEqual(["tenants.example.com"]);
  });
});
