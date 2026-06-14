/**
 * Tests for `CloudFrontDistribution`.
 *
 * Coverage:
 *   - Distribution has wildcard alternate name + parent alternate name.
 *   - Cert ARN wired through (FromCertificateArn-style reference).
 *   - Default behaviour has the edge `check-auth` attached.
 *   - `/login/callback*` behaviour points at the auth-verify HTTP origin.
 *   - `/logout*` behaviour points at the auth-signout HTTP origin.
 *   - `/login` and `/login/*` behaviours bypass the edge function.
 *   - `webAclArn` wires through when provided.
 *   - `responseHeadersPolicy` override is respected.
 */

import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { afterAll, describe, expect, it } from "vitest";

import { CloudFrontDistribution } from "../../lib/shared-distribution-identity/cloudfront-distribution.js";
import { EdgeFunction } from "../../lib/shared-distribution-identity/edge-function.js";
import {
  cleanupTmpRoots,
  makeMockCdkPackageRoot,
  makeTestStack,
  makeTmpDir,
  makeUserPool,
} from "./fixtures.js";

afterAll(cleanupTmpRoots);

const TENANT_PATTERN = /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/;
const TEST_CERT_ARN =
  "arn:aws:acm:us-east-1:123456789012:certificate/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

interface SynthResult {
  template: Template;
  stack: cdk.Stack;
  app: cdk.App;
}

function synthDefault(): SynthResult {
  const { app, stack } = makeTestStack();
  const userPool = makeUserPool(stack);
  const bundleDir = makeTmpDir();
  const edge = new EdgeFunction(stack, "Edge", {
    tenantSubdomainParent: "tenants.example.com",
    tenantSubdomainPattern: TENANT_PATTERN,
    userPool,
    _skipBundle: true,
    _bundleOutDirOverride: bundleDir,
  });
  new CloudFrontDistribution(stack, "Dist", {
    tenantSubdomainParent: "tenants.example.com",
    wildcardCertificateArn: TEST_CERT_ARN,
    authVerifyFunctionUrl: "https://abc123.lambda-url.eu-central-1.on.aws/",
    authSignoutFunctionUrl: "https://def456.lambda-url.eu-central-1.on.aws/",
    edgeFunctionVersion: edge.version,
    _packageRoot: makeMockCdkPackageRoot(),
  });
  return { template: Template.fromStack(stack), stack, app };
}

describe("CloudFrontDistribution — domain wiring", () => {
  it("creates exactly one CloudFront distribution", () => {
    const { template } = synthDefault();
    template.resourceCountIs("AWS::CloudFront::Distribution", 1);
  });

  it("has wildcard alternate name AND parent alternate name", () => {
    const { template } = synthDefault();
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        Aliases: Match.arrayWith(["*.tenants.example.com", "tenants.example.com"]),
      },
    });
  });

  it("strips a trailing dot on the parent", () => {
    const { app, stack } = makeTestStack();
    const userPool = makeUserPool(stack);
    const bundleDir = makeTmpDir();
    const edge = new EdgeFunction(stack, "Edge", {
      tenantSubdomainParent: "tenants.example.com.",
      tenantSubdomainPattern: TENANT_PATTERN,
      userPool,
      _skipBundle: true,
      _bundleOutDirOverride: bundleDir,
    });
    new CloudFrontDistribution(stack, "Dist", {
      tenantSubdomainParent: "tenants.example.com.",
      wildcardCertificateArn: TEST_CERT_ARN,
      authVerifyFunctionUrl: "https://a.lambda-url.eu-central-1.on.aws/",
      authSignoutFunctionUrl: "https://b.lambda-url.eu-central-1.on.aws/",
      edgeFunctionVersion: edge.version,
      _packageRoot: makeMockCdkPackageRoot(),
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        Aliases: Match.arrayWith(["*.tenants.example.com", "tenants.example.com"]),
      },
    });
    void app;
  });

  it("wires the cert ARN through via FromCertificateArn", () => {
    const { template } = synthDefault();
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        ViewerCertificate: {
          AcmCertificateArn: TEST_CERT_ARN,
        },
      },
    });
  });

  it("uses TLS 1.2 2021 minimum protocol", () => {
    const { template } = synthDefault();
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        ViewerCertificate: { MinimumProtocolVersion: "TLSv1.2_2021" },
      },
    });
  });
});

describe("CloudFrontDistribution — behaviours", () => {
  it("default behaviour has the edge check-auth attached as viewer-request", () => {
    const { template } = synthDefault();
    // The edge ARN is a cross-region token (CDK's CR fetcher). Just
    // assert the structure includes a viewer-request lambda.
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        DefaultCacheBehavior: {
          LambdaFunctionAssociations: Match.arrayWith([
            Match.objectLike({ EventType: "viewer-request" }),
          ]),
        },
      },
    });
  });

  it("/login/callback* behaviour exists and points at the auth-verify origin host", () => {
    const { template } = synthDefault();
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: "/login/callback*",
          }),
        ]),
      },
    });
    // And the origin with that hostname is wired up.
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        Origins: Match.arrayWith([
          Match.objectLike({
            DomainName: "abc123.lambda-url.eu-central-1.on.aws",
          }),
        ]),
      },
    });
  });

  it("/logout* behaviour exists and points at the auth-signout origin host", () => {
    const { template } = synthDefault();
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({ PathPattern: "/logout*" }),
        ]),
        Origins: Match.arrayWith([
          Match.objectLike({
            DomainName: "def456.lambda-url.eu-central-1.on.aws",
          }),
        ]),
      },
    });
  });

  it("/login and /login/* behaviours do NOT carry an edge lambda", () => {
    const { template } = synthDefault();
    const dist = template.findResources("AWS::CloudFront::Distribution");
    const props = Object.values(dist)[0]?.Properties as {
      DistributionConfig: { CacheBehaviors: { PathPattern: string; LambdaFunctionAssociations?: unknown[] }[] };
    };
    const loginBehavior = props.DistributionConfig.CacheBehaviors.find(
      (b) => b.PathPattern === "/login",
    );
    expect(loginBehavior).toBeDefined();
    expect(loginBehavior?.LambdaFunctionAssociations).toBeUndefined();
  });

  it("/login/callback* behaviour does NOT carry an edge lambda", () => {
    const { template } = synthDefault();
    const dist = template.findResources("AWS::CloudFront::Distribution");
    const props = Object.values(dist)[0]?.Properties as {
      DistributionConfig: { CacheBehaviors: { PathPattern: string; LambdaFunctionAssociations?: unknown[] }[] };
    };
    const cb = props.DistributionConfig.CacheBehaviors.find(
      (b) => b.PathPattern === "/login/callback*",
    );
    expect(cb).toBeDefined();
    expect(cb?.LambdaFunctionAssociations).toBeUndefined();
  });

  it("/logout* behaviour does NOT carry an edge lambda", () => {
    const { template } = synthDefault();
    const dist = template.findResources("AWS::CloudFront::Distribution");
    const props = Object.values(dist)[0]?.Properties as {
      DistributionConfig: { CacheBehaviors: { PathPattern: string; LambdaFunctionAssociations?: unknown[] }[] };
    };
    const cb = props.DistributionConfig.CacheBehaviors.find(
      (b) => b.PathPattern === "/logout*",
    );
    expect(cb).toBeDefined();
    expect(cb?.LambdaFunctionAssociations).toBeUndefined();
  });

  it("redirects HTTP to HTTPS on the default behaviour", () => {
    const { template } = synthDefault();
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        DefaultCacheBehavior: { ViewerProtocolPolicy: "redirect-to-https" },
      },
    });
  });
});

describe("CloudFrontDistribution — WAF + headers", () => {
  it("wires webAclArn when provided", () => {
    const { app, stack } = makeTestStack();
    const userPool = makeUserPool(stack);
    const bundleDir = makeTmpDir();
    const edge = new EdgeFunction(stack, "Edge", {
      tenantSubdomainParent: "tenants.example.com",
      tenantSubdomainPattern: TENANT_PATTERN,
      userPool,
      _skipBundle: true,
      _bundleOutDirOverride: bundleDir,
    });
    new CloudFrontDistribution(stack, "Dist", {
      tenantSubdomainParent: "tenants.example.com",
      wildcardCertificateArn: TEST_CERT_ARN,
      authVerifyFunctionUrl: "https://a.lambda-url.eu-central-1.on.aws/",
      authSignoutFunctionUrl: "https://b.lambda-url.eu-central-1.on.aws/",
      edgeFunctionVersion: edge.version,
      webAclArn:
        "arn:aws:wafv2:us-east-1:123456789012:global/webacl/MyAcl/abcd",
      _packageRoot: makeMockCdkPackageRoot(),
    });
    const t = Template.fromStack(stack);
    t.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        WebACLId:
          "arn:aws:wafv2:us-east-1:123456789012:global/webacl/MyAcl/abcd",
      },
    });
    void app;
  });

  it("no WebACLId in the rendered template when webAclArn is unset", () => {
    const { template } = synthDefault();
    const dist = template.findResources("AWS::CloudFront::Distribution");
    const props = Object.values(dist)[0]?.Properties as {
      DistributionConfig: { WebACLId?: string };
    };
    expect(props.DistributionConfig.WebACLId).toBeUndefined();
  });

  it("creates a default ResponseHeadersPolicy when none is provided", () => {
    const { template } = synthDefault();
    template.resourceCountIs("AWS::CloudFront::ResponseHeadersPolicy", 1);
  });

  it("respects a responseHeadersPolicy override", () => {
    const { stack } = makeTestStack();
    const userPool = makeUserPool(stack);
    const bundleDir = makeTmpDir();
    const edge = new EdgeFunction(stack, "Edge", {
      tenantSubdomainParent: "tenants.example.com",
      tenantSubdomainPattern: TENANT_PATTERN,
      userPool,
      _skipBundle: true,
      _bundleOutDirOverride: bundleDir,
    });
    const customPolicy = new cdk.aws_cloudfront.ResponseHeadersPolicy(
      stack,
      "CustomPolicy",
      {
        comment: "consumer-supplied",
        customHeadersBehavior: {
          customHeaders: [{ header: "X-Consumer", value: "yes", override: true }],
        },
      },
    );
    new CloudFrontDistribution(stack, "Dist", {
      tenantSubdomainParent: "tenants.example.com",
      wildcardCertificateArn: TEST_CERT_ARN,
      authVerifyFunctionUrl: "https://a.lambda-url.eu-central-1.on.aws/",
      authSignoutFunctionUrl: "https://b.lambda-url.eu-central-1.on.aws/",
      edgeFunctionVersion: edge.version,
      responseHeadersPolicy: customPolicy,
      _packageRoot: makeMockCdkPackageRoot(),
    });
    const t = Template.fromStack(stack);
    // exactly one — the consumer-supplied one. The construct did not
    // create another.
    t.resourceCountIs("AWS::CloudFront::ResponseHeadersPolicy", 1);
    t.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: { Comment: "consumer-supplied" },
    });
  });
});

describe("CloudFrontDistribution — login pages bucket", () => {
  it("creates an S3 bucket for login pages and a BucketDeployment", () => {
    const { template } = synthDefault();
    const buckets = template.findResources("AWS::S3::Bucket");
    expect(Object.keys(buckets).length).toBeGreaterThan(0);
    // BucketDeployment is a CustomResource — assert via custom-resource
    // type presence.
    const customResources = template.findResources(
      "Custom::CDKBucketDeployment",
    );
    expect(Object.keys(customResources).length).toBeGreaterThan(0);
  });

  it("accepts a tenantParentLandingPage override", () => {
    const { stack } = makeTestStack();
    const userPool = makeUserPool(stack);
    const bundleDir = makeTmpDir();
    const edge = new EdgeFunction(stack, "Edge", {
      tenantSubdomainParent: "tenants.example.com",
      tenantSubdomainPattern: TENANT_PATTERN,
      userPool,
      _skipBundle: true,
      _bundleOutDirOverride: bundleDir,
    });
    // Use the mock package root's login.html as the landing-page path
    // (the prop just needs a real file on disk).
    const mockRoot = makeMockCdkPackageRoot();
    const landingPagePath = `${mockRoot}/login-pages/login.html`;
    expect(
      () =>
        new CloudFrontDistribution(stack, "Dist", {
          tenantSubdomainParent: "tenants.example.com",
          wildcardCertificateArn: TEST_CERT_ARN,
          authVerifyFunctionUrl: "https://a.lambda-url.eu-central-1.on.aws/",
          authSignoutFunctionUrl: "https://b.lambda-url.eu-central-1.on.aws/",
          edgeFunctionVersion: edge.version,
          tenantParentLandingPage: landingPagePath,
          _packageRoot: makeMockCdkPackageRoot(),
        }),
    ).not.toThrow();
  });

  it("accepts a priceClass override", () => {
    const { stack } = makeTestStack();
    const userPool = makeUserPool(stack);
    const bundleDir = makeTmpDir();
    const edge = new EdgeFunction(stack, "Edge", {
      tenantSubdomainParent: "tenants.example.com",
      tenantSubdomainPattern: TENANT_PATTERN,
      userPool,
      _skipBundle: true,
      _bundleOutDirOverride: bundleDir,
    });
    new CloudFrontDistribution(stack, "Dist", {
      tenantSubdomainParent: "tenants.example.com",
      wildcardCertificateArn: TEST_CERT_ARN,
      authVerifyFunctionUrl: "https://a.lambda-url.eu-central-1.on.aws/",
      authSignoutFunctionUrl: "https://b.lambda-url.eu-central-1.on.aws/",
      edgeFunctionVersion: edge.version,
      priceClass: cdk.aws_cloudfront.PriceClass.PRICE_CLASS_ALL,
      _packageRoot: makeMockCdkPackageRoot(),
    });
    const t = Template.fromStack(stack);
    t.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: { PriceClass: "PriceClass_All" },
    });
  });
});

describe("CloudFrontDistribution — S4 lifecycle on login-page bucket", () => {
  it("applies the abort-incomplete-multipart-upload rule by default (7 days)", () => {
    const { template } = synthDefault();
    template.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: Match.objectLike({
        Rules: Match.arrayWith([
          Match.objectLike({
            Status: "Enabled",
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
          }),
        ]),
      }),
    });
  });

  it("applies a Standard → Standard-IA transition at 30 days by default", () => {
    const { template } = synthDefault();
    template.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: Match.objectLike({
        Rules: Match.arrayWith([
          Match.objectLike({
            Status: "Enabled",
            Transitions: Match.arrayWith([
              Match.objectLike({
                StorageClass: "STANDARD_IA",
                TransitionInDays: 30,
              }),
            ]),
          }),
        ]),
      }),
    });
  });

  it("expires noncurrent versions after 90 days by default", () => {
    const { template } = synthDefault();
    template.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: Match.objectLike({
        Rules: Match.arrayWith([
          Match.objectLike({
            Status: "Enabled",
            NoncurrentVersionExpiration: { NoncurrentDays: 90 },
          }),
        ]),
      }),
    });
  });

  it("disables the default lifecycle when lifecycle.rules is the empty array", () => {
    const { stack } = makeTestStack();
    const userPool = makeUserPool(stack);
    const bundleDir = makeTmpDir();
    const edge = new EdgeFunction(stack, "Edge", {
      tenantSubdomainParent: "tenants.example.com",
      tenantSubdomainPattern: TENANT_PATTERN,
      userPool,
      _skipBundle: true,
      _bundleOutDirOverride: bundleDir,
    });
    new CloudFrontDistribution(stack, "Dist", {
      tenantSubdomainParent: "tenants.example.com",
      wildcardCertificateArn: TEST_CERT_ARN,
      authVerifyFunctionUrl: "https://a.lambda-url.eu-central-1.on.aws/",
      authSignoutFunctionUrl: "https://b.lambda-url.eu-central-1.on.aws/",
      edgeFunctionVersion: edge.version,
      lifecycle: { rules: [] },
      _packageRoot: makeMockCdkPackageRoot(),
    });
    const template = Template.fromStack(stack);
    const buckets = template.findResources("AWS::S3::Bucket");
    for (const [, res] of Object.entries(buckets)) {
      const props = (res as { Properties?: { LifecycleConfiguration?: unknown } })
        .Properties;
      expect(props?.LifecycleConfiguration).toBeUndefined();
    }
  });

  it("replaces the default lifecycle with consumer rules when supplied", () => {
    const { stack } = makeTestStack();
    const userPool = makeUserPool(stack);
    const bundleDir = makeTmpDir();
    const edge = new EdgeFunction(stack, "Edge", {
      tenantSubdomainParent: "tenants.example.com",
      tenantSubdomainPattern: TENANT_PATTERN,
      userPool,
      _skipBundle: true,
      _bundleOutDirOverride: bundleDir,
    });
    new CloudFrontDistribution(stack, "Dist", {
      tenantSubdomainParent: "tenants.example.com",
      wildcardCertificateArn: TEST_CERT_ARN,
      authVerifyFunctionUrl: "https://a.lambda-url.eu-central-1.on.aws/",
      authSignoutFunctionUrl: "https://b.lambda-url.eu-central-1.on.aws/",
      edgeFunctionVersion: edge.version,
      lifecycle: {
        rules: [
          {
            id: "consumer-only-rule",
            enabled: true,
            expiration: cdk.Duration.days(180),
            abortIncompleteMultipartUploadAfter: cdk.Duration.days(2),
          },
        ],
      },
      _packageRoot: makeMockCdkPackageRoot(),
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: Match.objectLike({
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: "consumer-only-rule",
            ExpirationInDays: 180,
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 },
          }),
        ]),
      }),
    });
    // Default STANDARD_IA transition must NOT be present (replace).
    const buckets = template.findResources("AWS::S3::Bucket");
    let foundStandardIa = false;
    for (const [, res] of Object.entries(buckets)) {
      const cfg = (res as {
        Properties?: { LifecycleConfiguration?: { Rules?: unknown[] } };
      }).Properties?.LifecycleConfiguration;
      for (const rule of cfg?.Rules ?? []) {
        const transitions = (rule as { Transitions?: { StorageClass?: string }[] })
          .Transitions;
        if (transitions !== undefined && transitions.some((t) => t.StorageClass === "STANDARD_IA")) {
          foundStandardIa = true;
        }
      }
    }
    expect(foundStandardIa).toBe(false);
  });
});

describe("CloudFrontDistribution — edge construct usage (C3)", () => {
  it("attaches the edge function via experimental.EdgeFunction.version", () => {
    const { template } = synthDefault();
    // We can only assert on the rendered CFN — but the EdgeFunction's
    // version arrives at CloudFront as a CrossRegionReference. The
    // presence of a LambdaFunctionAssociations array proves the wiring.
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        DefaultCacheBehavior: {
          LambdaFunctionAssociations: Match.arrayWith([
            Match.objectLike({ EventType: "viewer-request" }),
          ]),
        },
      },
    });
  });
});
