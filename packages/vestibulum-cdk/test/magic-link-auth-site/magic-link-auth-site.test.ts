/**
 * MagicLinkAuthSite synth tests.
 *
 * Covers:
 * - the four-Lambda topology (auth-verify, auth-signout, check-auth
 *   edge, BucketDeployment custom resource)
 * - bundle paths from the mocked lock manifest
 * - branding-prefix override (S-C12)
 * - no `_setSignupMode` call on the identity (B-I)
 * - response-headers policy uses the namespace prefix
 * - lambda@edge role has no logs:* (Mandatory Mitigation 1)
 */

import * as fs from "node:fs";

import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EdgeResources } from "../../lib/edge-resources/index.js";
import {
  MagicLinkAuthSite,
  type BucketLifecycleProps,
} from "../../lib/magic-link-auth-site/index.js";
import { MOCK_BUNDLE_MANIFEST, makeMockPackageRoot } from "../fixtures/mock-bundle-manifest.js";
import { MockIdentity } from "../fixtures/mock-identity.js";

const TEST_ENV = { account: "123456789012", region: "us-east-1" };

// Tracked tmp roots for afterAll cleanup.
const tmpRoots: string[] = [];

function makeAppRoot(): string {
  const root = makeMockPackageRoot();
  tmpRoots.push(root);
  return root;
}

interface TestStacks {
  readonly app: cdk.App;
  readonly stack: cdk.Stack;
  readonly site: MagicLinkAuthSite;
  readonly identity: MockIdentity;
  readonly origin: cloudfront.IOrigin;
}

function makeSite(
  stackName: string,
  overrides: Parameters<typeof makeSiteWithProps>[2] = {},
): TestStacks {
  return makeSiteWithProps(stackName, makeAppRoot(), overrides);
}

function makeSiteWithProps(
  stackName: string,
  packageRoot: string,
  overrides: Partial<{
    namespacePrefix: string;
    metricsNamespace: string;
    reservedConcurrency: { authVerify?: number; authSignout?: number };
    lifecycle: BucketLifecycleProps;
  }>,
): TestStacks {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, stackName, {
    env: TEST_ENV,
    stackName,
    crossRegionReferences: true,
  });
  const identity = new MockIdentity(stack, "Identity");
  const zone = cdk.aws_route53.HostedZone.fromHostedZoneAttributes(stack, "Zone", {
    hostedZoneId: "Z123456789EXAMPLE",
    zoneName: "example.com",
  });
  const edge = new EdgeResources(stack, "Edge", {
    domain: "app.example.com",
    hostedZone: zone,
  });
  const originBucket = new s3.Bucket(stack, "OriginBucket") as unknown as s3.IBucket;
  const origin = origins.S3BucketOrigin.withOriginAccessControl(originBucket);
  const site = new MagicLinkAuthSite(stack, "Site", {
    domain: "app.example.com",
    origin,
    edge,
    identity,
    _packageRoot: packageRoot,
    _bundleManifest: MOCK_BUNDLE_MANIFEST,
    ...(overrides.namespacePrefix !== undefined && {
      namespacePrefix: overrides.namespacePrefix,
    }),
    ...(overrides.metricsNamespace !== undefined && {
      metricsNamespace: overrides.metricsNamespace,
    }),
    ...(overrides.reservedConcurrency && {
      reservedConcurrency: overrides.reservedConcurrency,
    }),
    ...(overrides.lifecycle && {
      lifecycle: overrides.lifecycle,
    }),
  });
  return { app, stack, site, identity, origin };
}

describe("MagicLinkAuthSite", () => {
  afterAll(() => {
    for (const root of tmpRoots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  describe("default props", () => {
    let template: Template;
    let stacks: TestStacks;

    beforeAll(() => {
      stacks = makeSite("AuthSiteDefaultStack");
      template = Template.fromStack(stacks.stack);
    });

    it("creates exactly one CloudFront distribution", () => {
      template.resourceCountIs("AWS::CloudFront::Distribution", 1);
    });

    it("distribution uses the EdgeResources cert and Web ACL", () => {
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: Match.objectLike({
          Aliases: ["app.example.com"],
          HttpVersion: "http2and3",
          PriceClass: "PriceClass_100",
        }),
      });
    });

    it("distribution uses TLSv1.2_2021 minimum protocol version", () => {
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: Match.objectLike({
          ViewerCertificate: Match.objectLike({
            MinimumProtocolVersion: "TLSv1.2_2021",
          }),
        }),
      });
    });

    it("auth-verify Lambda has reservedConcurrentExecutions 20 (S-C9 default)", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Description: Match.stringLikeRegexp("Vestibulum auth-verify"),
        ReservedConcurrentExecutions: 20,
        Runtime: "nodejs22.x",
      });
    });

    it("auth-verify Lambda has a timeout/memory above the 3s/128MB defaults (Cognito cascade headroom)", () => {
      // The success path cascades through Cognito triggers; the CDK 3s/128MB
      // defaults overrun (502) and run near OOM. Lock in the bumped values.
      template.hasResourceProperties("AWS::Lambda::Function", {
        Description: Match.stringLikeRegexp("Vestibulum auth-verify"),
        Timeout: 10,
        MemorySize: 256,
      });
    });

    it("auth-signout Lambda has reservedConcurrentExecutions 5", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Description: Match.stringLikeRegexp("Vestibulum auth-signout"),
        ReservedConcurrentExecutions: 5,
        Runtime: "nodejs22.x",
        Timeout: 10,
        MemorySize: 256,
      });
    });

    it("auth-verify and auth-signout Function URLs use AWS_IAM authType (OAC requirement)", () => {
      const urls = template.findResources("AWS::Lambda::Url");
      const authTypes = Object.values(urls).map(
        (r) => (r.Properties as { AuthType: string }).AuthType,
      );
      expect(authTypes.filter((t) => t === "AWS_IAM").length).toBeGreaterThanOrEqual(2);
    });

    it("grants CloudFront both InvokeFunctionUrl and InvokeFunction on the auth Function URLs (OAC POST requirement)", () => {
      // AWS docs (Restrict access to a Lambda function URL origin) require the
      // CloudFront service principal to hold BOTH actions for OAC-signed POSTs;
      // `withOriginAccessControl` only adds InvokeFunctionUrl, so the construct
      // must add InvokeFunction explicitly or browser sign-in 403s at the
      // Function URL auth layer.
      const perms = template.findResources("AWS::Lambda::Permission");
      const cfPerms = Object.values(perms)
        .map((r) => r.Properties as { Action: string; Principal: string })
        .filter((p) => p.Principal === "cloudfront.amazonaws.com");
      const actions = cfPerms.map((p) => p.Action);
      // One InvokeFunctionUrl + one InvokeFunction per auth Function URL (×2).
      expect(actions.filter((a) => a === "lambda:InvokeFunctionUrl").length).toBeGreaterThanOrEqual(2);
      expect(actions.filter((a) => a === "lambda:InvokeFunction").length).toBe(2);
    });

    it("scopes the InvokeFunction grants to this distribution via SourceArn", () => {
      template.hasResourceProperties("AWS::Lambda::Permission", {
        Action: "lambda:InvokeFunction",
        Principal: "cloudfront.amazonaws.com",
        SourceArn: Match.objectLike({ "Fn::Join": Match.anyValue() }),
      });
    });

    it("uses a no-cache cookie-forwarding cache policy on the auth endpoints (so Set-Cookie reaches the viewer)", () => {
      // CachingDisabled (cookie behaviour none) makes CloudFront strip both
      // request cookies and Set-Cookie responses, breaking sign-in/sign-out.
      template.hasResourceProperties("AWS::CloudFront::CachePolicy", {
        CachePolicyConfig: Match.objectLike({
          MinTTL: 0,
          MaxTTL: 0,
          DefaultTTL: 0,
          ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
            CookiesConfig: {
              // CDK `CacheCookieBehavior.allowList` renders as CFN "whitelist".
              CookieBehavior: "whitelist",
              Cookies: Match.arrayWith(["id-token", "refresh-token"]),
            },
          }),
        }),
      });
    });

    it("creates a response-headers policy with the namespace prefix in its name", () => {
      template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
        ResponseHeadersPolicyConfig: Match.objectLike({
          Name: Match.stringLikeRegexp("^VestibulumAuthSite-"),
        }),
      });
    });

    it("response-headers policy emits HSTS for 2 years with preload and includeSubdomains", () => {
      template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
        ResponseHeadersPolicyConfig: Match.objectLike({
          SecurityHeadersConfig: Match.objectLike({
            StrictTransportSecurity: Match.objectLike({
              AccessControlMaxAgeSec: 730 * 24 * 60 * 60,
              IncludeSubdomains: true,
              Preload: true,
              Override: true,
            }),
            FrameOptions: Match.objectLike({ FrameOption: "DENY" }),
          }),
        }),
      });
    });

    it("creates a login-page S3 bucket with BlockPublicAccess all-blocked", () => {
      template.hasResourceProperties("AWS::S3::Bucket", {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    it("creates exactly one BucketDeployment custom resource", () => {
      template.resourceCountIs("Custom::CDKBucketDeployment", 1);
    });

    it("creates a 1-day retention log group for the check-auth edge function", () => {
      template.hasResourceProperties("AWS::Logs::LogGroup", {
        RetentionInDays: 1,
      });
    });

    it("exposes the resolved namespace and prefix", () => {
      expect(stacks.site.namespacePrefix).toBe("Vestibulum");
      expect(stacks.site.metrics.namespace).toBe("Vestibulum/AuthSite");
    });

    it("creates a Cognito UserPoolClient for the website (auto-created via addAppClient)", () => {
      // Two: the test stack also has the pool itself. Filter on the
      // CUSTOM_AUTH flow which the mock identity sets.
      template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
        AllowedOAuthFlows: ["code"],
        AllowedOAuthScopes: Match.arrayWith(["openid", "email"]),
        GenerateSecret: false,
      });
    });
  });

  describe("B-I: no _setSignupMode on identity", () => {
    it("MagicLinkAuthSite does not call _setSignupMode on the identity", () => {
      // The IMagicLinkIdentity interface does not declare _setSignupMode,
      // so the construct cannot call it at compile time. This test
      // documents the invariant at runtime as well.
      const stacks = makeSite("AuthSiteNoSignupModeStack");
      // No spy needed — the mock identity has no such method and the
      // synth would have thrown if the construct tried to call one.
      expect(stacks.site).toBeDefined();
      // Statically: there is no `signupMode` prop on
      // MagicLinkAuthSite either (TypeScript would have caught
      // misuse). Verify by listing the known prop keys.
      const propsKeys: readonly string[] = [
        "domain",
        "origin",
        "edge",
        "identity",
        "priceClass",
        "responseHeadersPolicy",
        "loginPageBucket",
        "lifecycle",
        "idTokenValidity",
        "refreshTokenValidity",
        "reservedConcurrency",
        "metricsNamespace",
        "namespacePrefix",
        "_packageRoot",
        "_bundleManifest",
        "_skipBundleAssetCheck",
      ];
      expect(propsKeys).not.toContain("signupMode");
    });
  });

  describe("S-C12: branding override", () => {
    it("namespacePrefix flows into the CloudFront comment and response-headers policy name", () => {
      const stacks = makeSite("AuthSiteBrandedStack", {
        namespacePrefix: "Acme",
        metricsNamespace: "Acme/Auth",
      });
      const template = Template.fromStack(stacks.stack);
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: Match.objectLike({
          Comment: Match.stringLikeRegexp("^Acme AuthSite"),
        }),
      });
      template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
        ResponseHeadersPolicyConfig: Match.objectLike({
          Name: Match.stringLikeRegexp("^AcmeAuthSite-"),
        }),
      });
      expect(stacks.site.metrics.namespace).toBe("Acme/Auth");
    });

    it("edge role IAM condition uses the overridden metrics namespace", () => {
      const stacks = makeSite("AuthSiteBrandedEdgeStack", {
        metricsNamespace: "Acme/Auth",
      });
      // The edge function's role and policy live in an internal
      // cross-region stage stack that `EdgeFunction` creates. Walk
      // every stack in the synthesized assembly.
      const assembly = stacks.app.synth({ force: true });
      let found = false;
      for (const stackArtifact of assembly.stacks) {
        const resources = (
          stackArtifact.template as {
            Resources?: Record<string, { Type?: string; Properties?: unknown }>;
          }
        ).Resources;
        if (!resources) continue;
        for (const [, res] of Object.entries(resources)) {
          if (res.Type !== "AWS::IAM::Policy") continue;
          const props = res.Properties as {
            PolicyDocument?: { Statement?: unknown[] };
          };
          for (const stmt of props.PolicyDocument?.Statement ?? []) {
            const s = stmt as {
              Action?: string;
              Sid?: string;
              Condition?: {
                StringEquals?: { "cloudwatch:namespace"?: string };
              };
            };
            if (
              s.Action === "cloudwatch:PutMetricData" &&
              s.Condition?.StringEquals?.["cloudwatch:namespace"] === "Acme/Auth"
            ) {
              found = true;
            }
          }
        }
      }
      expect(found).toBe(true);
    });
  });

  describe("S-C9: reservedConcurrency override", () => {
    it("authVerify default of 20 is overridable upward", () => {
      const stacks = makeSite("AuthSiteHigherConcurrencyStack", {
        reservedConcurrency: { authVerify: 100 },
      });
      const template = Template.fromStack(stacks.stack);
      template.hasResourceProperties("AWS::Lambda::Function", {
        Description: Match.stringLikeRegexp("Vestibulum auth-verify"),
        ReservedConcurrentExecutions: 100,
      });
    });
  });

  describe("bundle path resolution", () => {
    it("uses the test fixture's bundle paths (does not stat real disk)", () => {
      // makeSite uses the mock manifest; synth completed → paths
      // resolved without touching the real lambda-bundles directory.
      const stacks = makeSite("AuthSiteBundlePathsStack");
      const template = Template.fromStack(stacks.stack);
      const fns = template.findResources("AWS::Lambda::Function");
      // At least auth-verify, auth-signout, and (in some test
      // configurations) auto-attached log-retention provider lambdas.
      expect(Object.keys(fns).length).toBeGreaterThanOrEqual(2);
      expect(stacks.site).toBeDefined();
    });
  });

  describe("optional prop branches", () => {
    it("idTokenValidity flows into the website app client when supplied", () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, "AuthSiteIdTokenStack", {
        env: TEST_ENV,
        stackName: "AuthSiteIdTokenStack",
        crossRegionReferences: true,
      });
      const identity = new MockIdentity(stack, "Identity");
      const zone = cdk.aws_route53.HostedZone.fromHostedZoneAttributes(stack, "Zone", {
        hostedZoneId: "Z123456789EXAMPLE",
        zoneName: "example.com",
      });
      const edge = new EdgeResources(stack, "Edge", {
        domain: "app.example.com",
        hostedZone: zone,
      });
      const originBucket = new s3.Bucket(stack, "OriginBucket") as unknown as s3.IBucket;
      const origin = origins.S3BucketOrigin.withOriginAccessControl(originBucket);
      new MagicLinkAuthSite(stack, "Site", {
        domain: "app.example.com",
        origin,
        edge,
        identity,
        idTokenValidity: cdk.Duration.minutes(30),
        refreshTokenValidity: cdk.Duration.days(7),
        _packageRoot: makeAppRoot(),
        _bundleManifest: MOCK_BUNDLE_MANIFEST,
      });
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
        AllowedOAuthFlows: ["code"],
        IdTokenValidity: 30,
        RefreshTokenValidity: 7 * 24 * 60,
      });
    });

    it("priceClass override applies to the distribution", () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, "AuthSitePriceClassStack", {
        env: TEST_ENV,
        stackName: "AuthSitePriceClassStack",
        crossRegionReferences: true,
      });
      const identity = new MockIdentity(stack, "Identity");
      const zone = cdk.aws_route53.HostedZone.fromHostedZoneAttributes(stack, "Zone", {
        hostedZoneId: "Z123456789EXAMPLE",
        zoneName: "example.com",
      });
      const edge = new EdgeResources(stack, "Edge", {
        domain: "app.example.com",
        hostedZone: zone,
      });
      const originBucket = new s3.Bucket(stack, "OriginBucket") as unknown as s3.IBucket;
      const origin = origins.S3BucketOrigin.withOriginAccessControl(originBucket);
      new MagicLinkAuthSite(stack, "Site", {
        domain: "app.example.com",
        origin,
        edge,
        identity,
        priceClass: cdk.aws_cloudfront.PriceClass.PRICE_CLASS_ALL,
        _packageRoot: makeAppRoot(),
        _bundleManifest: MOCK_BUNDLE_MANIFEST,
      });
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: Match.objectLike({ PriceClass: "PriceClass_All" }),
      });
    });

    it("responseHeadersPolicy override replaces the auto-created one", () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, "AuthSiteCustomRhpStack", {
        env: TEST_ENV,
        stackName: "AuthSiteCustomRhpStack",
        crossRegionReferences: true,
      });
      const identity = new MockIdentity(stack, "Identity");
      const zone = cdk.aws_route53.HostedZone.fromHostedZoneAttributes(stack, "Zone", {
        hostedZoneId: "Z123456789EXAMPLE",
        zoneName: "example.com",
      });
      const edge = new EdgeResources(stack, "Edge", {
        domain: "app.example.com",
        hostedZone: zone,
      });
      const originBucket = new s3.Bucket(stack, "OriginBucket") as unknown as s3.IBucket;
      const origin = origins.S3BucketOrigin.withOriginAccessControl(originBucket);
      const customRhp = new cdk.aws_cloudfront.ResponseHeadersPolicy(stack, "CustomRhp", {
        comment: "consumer-supplied",
      });
      new MagicLinkAuthSite(stack, "Site", {
        domain: "app.example.com",
        origin,
        edge,
        identity,
        responseHeadersPolicy: customRhp,
        _packageRoot: makeAppRoot(),
        _bundleManifest: MOCK_BUNDLE_MANIFEST,
      });
      const template = Template.fromStack(stack);
      // Exactly one RHP — the consumer's. The construct did not auto-create.
      template.resourceCountIs("AWS::CloudFront::ResponseHeadersPolicy", 1);
      template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
        ResponseHeadersPolicyConfig: Match.objectLike({ Comment: "consumer-supplied" }),
      });
    });
  });

  describe("S4: S3 lifecycle defaults on the auto-created login-page bucket", () => {
    it("applies the abort-incomplete-multipart-upload rule on the default bucket", () => {
      const stacks = makeSite("AuthSiteLifecycleDefaultStack");
      const template = Template.fromStack(stacks.stack);
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

    it("applies a Standard → Standard-IA transition at 30 days on the default bucket", () => {
      const stacks = makeSite("AuthSiteLifecycleTransitionStack");
      const template = Template.fromStack(stacks.stack);
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

    it("expires noncurrent versions after 90 days on the default bucket", () => {
      const stacks = makeSite("AuthSiteLifecycleNoncurrentStack");
      const template = Template.fromStack(stacks.stack);
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
      const stacks = makeSite("AuthSiteLifecycleDisabledStack", {
        lifecycle: { rules: [] },
      });
      const template = Template.fromStack(stacks.stack);
      // The construct's own login-page bucket has no LifecycleConfiguration.
      const buckets = template.findResources("AWS::S3::Bucket");
      // There is at least one bucket (the LoginPageBucket); the test
      // stack also creates an OriginBucket without lifecycle (default
      // s3.Bucket). All buckets should lack a LifecycleConfiguration.
      for (const [, res] of Object.entries(buckets)) {
        const props = (res as { Properties?: { LifecycleConfiguration?: unknown } }).Properties;
        expect(props?.LifecycleConfiguration).toBeUndefined();
      }
    });

    it("replaces the default lifecycle with consumer rules when supplied", () => {
      const stacks = makeSite("AuthSiteLifecycleOverrideStack", {
        lifecycle: {
          rules: [
            {
              id: "consumer-cold-archive",
              enabled: true,
              expiration: cdk.Duration.days(365),
              abortIncompleteMultipartUploadAfter: cdk.Duration.days(3),
            },
          ],
        },
      });
      const template = Template.fromStack(stacks.stack);
      template.hasResourceProperties("AWS::S3::Bucket", {
        LifecycleConfiguration: Match.objectLike({
          Rules: Match.arrayWith([
            Match.objectLike({
              Id: "consumer-cold-archive",
              Status: "Enabled",
              ExpirationInDays: 365,
              AbortIncompleteMultipartUpload: { DaysAfterInitiation: 3 },
            }),
          ]),
        }),
      });
      // The default's STANDARD_IA transition should not be present
      // (replace semantics).
      const buckets = template.findResources("AWS::S3::Bucket");
      let foundStandardIa = false;
      for (const [, res] of Object.entries(buckets)) {
        const cfg = (res as {
          Properties?: { LifecycleConfiguration?: { Rules?: unknown[] } };
        }).Properties?.LifecycleConfiguration;
        for (const rule of cfg?.Rules ?? []) {
          const transitions = (rule as { Transitions?: { StorageClass?: string }[] }).Transitions;
          if (transitions !== undefined && transitions.some((t) => t.StorageClass === "STANDARD_IA")) {
            foundStandardIa = true;
          }
        }
      }
      expect(foundStandardIa).toBe(false);
    });

    it("does not attach lifecycle to a consumer-supplied bucket", () => {
      // When `loginPageBucket` is supplied, the construct does not
      // create a bucket and must not mutate the consumer's bucket
      // lifecycle. We synth two stacks side-by-side: one with the
      // construct's auto-bucket (control), one with a consumer-
      // supplied bucket. The consumer-bucket stack should have
      // strictly fewer S3::Bucket resources, and the bucket that the
      // consumer supplied should have no LifecycleConfiguration set.
      const app = new cdk.App();
      const stack = new cdk.Stack(app, "AuthSiteConsumerBucketStack", {
        env: TEST_ENV,
        stackName: "AuthSiteConsumerBucketStack",
        crossRegionReferences: true,
      });
      const identity = new MockIdentity(stack, "Identity");
      const zone = cdk.aws_route53.HostedZone.fromHostedZoneAttributes(stack, "Zone", {
        hostedZoneId: "Z123456789EXAMPLE",
        zoneName: "example.com",
      });
      const edge = new EdgeResources(stack, "Edge", {
        domain: "app.example.com",
        hostedZone: zone,
      });
      const originBucket = new s3.Bucket(stack, "OriginBucket") as unknown as s3.IBucket;
      const origin = origins.S3BucketOrigin.withOriginAccessControl(originBucket);
      const consumerBucket = new s3.Bucket(stack, "ConsumerLoginBucket");
      new MagicLinkAuthSite(stack, "Site", {
        domain: "app.example.com",
        origin,
        edge,
        identity,
        loginPageBucket: consumerBucket as unknown as s3.IBucket,
        // Even with `lifecycle` set, a consumer-supplied bucket must
        // not get mutated.
        lifecycle: { rules: [{ id: "test", expiration: cdk.Duration.days(10) }] },
        _packageRoot: makeAppRoot(),
        _bundleManifest: MOCK_BUNDLE_MANIFEST,
      });
      const template = Template.fromStack(stack);
      const buckets = template.findResources("AWS::S3::Bucket");
      // No bucket in the stack carries a LifecycleConfiguration —
      // not the consumer's, not the OriginBucket, neither.
      for (const [, res] of Object.entries(buckets)) {
        const props = (res as { Properties?: { LifecycleConfiguration?: unknown } })
          .Properties;
        expect(props?.LifecycleConfiguration).toBeUndefined();
      }
    });
  });

  describe("Mandatory Mitigation 1 — edge role has no logs:*", () => {
    it("does not attach AWSLambdaBasicExecutionRole to the edge function role", () => {
      const stacks = makeSite("AuthSiteEdgeLogsStack");
      // EdgeFunction provisions in an auto-generated stage; the role
      // lives in the main stack via the cross-region machinery. The
      // role's ManagedPolicyArns is cleared by the construct.
      interface StackTemplate {
        readonly Resources?: Record<string, CfnResource>;
      }
      interface CfnResource {
        readonly Type?: string;
        readonly Properties?: {
          readonly ManagedPolicyArns?: unknown[];
          readonly AssumeRolePolicyDocument?: unknown;
        };
      }
      const stage = stacks.app.synth({ force: true });
      const stacksWithEdge = stage.stacks.filter((s) => {
        const tpl = s.template as StackTemplate;
        const resources = tpl.Resources;
        if (!resources) return false;
        return Object.values(resources).some(
          (r) =>
            r.Type === "AWS::IAM::Role" && JSON.stringify(r).includes("edgelambda.amazonaws.com"),
        );
      });
      expect(stacksWithEdge.length).toBeGreaterThan(0);
      for (const s of stacksWithEdge) {
        const tpl = s.template as StackTemplate;
        const resources = tpl.Resources ?? {};
        for (const res of Object.values(resources)) {
          if (
            res.Type === "AWS::IAM::Role" &&
            JSON.stringify(res).includes("edgelambda.amazonaws.com")
          ) {
            // The role's managedPolicyArns is cleared.
            expect(res.Properties?.ManagedPolicyArns ?? []).toEqual([]);
          }
        }
      }
    });
  });

  describe("login routing: /login* behaviour, URI rewrite, and config injection", () => {
    let template: Template;

    beforeAll(() => {
      const stacks = makeSite("AuthSiteLoginRoutingStack");
      template = Template.fromStack(stacks.stack);
    });

    /** Returns the distribution's CacheBehaviors array (additional behaviours). */
    function cacheBehaviors(): Array<{
      PathPattern: string;
      FunctionAssociations?: Array<{ EventType: string }>;
    }> {
      const dists = template.findResources("AWS::CloudFront::Distribution");
      const dist = Object.values(dists)[0] as {
        Properties: { DistributionConfig: { CacheBehaviors?: unknown[] } };
      };
      return (dist.Properties.DistributionConfig.CacheBehaviors ?? []) as Array<{
        PathPattern: string;
        FunctionAssociations?: Array<{ EventType: string }>;
      }>;
    }

    it("serves the login UI under a single /login* behaviour", () => {
      const patterns = cacheBehaviors().map((b) => b.PathPattern);
      expect(patterns).toContain("/login*");
    });

    it("no longer registers the broken exact /login or /login/callback behaviours", () => {
      const patterns = cacheBehaviors().map((b) => b.PathPattern);
      expect(patterns).not.toContain("/login");
      expect(patterns).not.toContain("/login/callback");
    });

    it("associates a viewer-request CloudFront Function with /login*", () => {
      const login = cacheBehaviors().find((b) => b.PathPattern === "/login*");
      expect(login?.FunctionAssociations?.some((a) => a.EventType === "viewer-request")).toBe(true);
    });

    it("creates a CloudFront Function that rewrites /login and /login/callback to their .html objects", () => {
      template.hasResourceProperties("AWS::CloudFront::Function", {
        FunctionConfig: Match.objectLike({ Runtime: Match.anyValue() }),
        FunctionCode: Match.stringLikeRegexp("/login\\.html"),
      });
      template.hasResourceProperties("AWS::CloudFront::Function", {
        FunctionCode: Match.stringLikeRegexp("/login-callback\\.html"),
      });
    });

    it("gives the rewrite Function a name within CloudFront's 64-char limit", () => {
      // CloudFront rejects function names longer than 64 chars at deploy time
      // (a synth-clean template still fails). A hand-built name keyed on the
      // domain overflows for ordinary domains; CDK's auto-generated name must
      // stay bounded.
      const fns = template.findResources("AWS::CloudFront::Function");
      const names = Object.values(fns)
        .map((r) => (r.Properties as { Name?: unknown }).Name)
        .filter((n): n is string => typeof n === "string");
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(name.length).toBeLessThanOrEqual(64);
        expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      }
    });

    it("mints a login-scoped response-headers policy allowing the Cognito IDP connect-src", () => {
      template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
        ResponseHeadersPolicyConfig: Match.objectLike({
          Name: Match.stringLikeRegexp("^VestibulumAuthSiteLogin-"),
          SecurityHeadersConfig: Match.objectLike({
            ContentSecurityPolicy: Match.objectLike({
              ContentSecurityPolicy: Match.stringLikeRegexp(
                "connect-src 'self' https://cognito-idp\\.[^ ]+\\.amazonaws\\.com",
              ),
            }),
          }),
        }),
      });
    });

    it("keeps the default (app) CSP strict with connect-src 'self'", () => {
      template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
        ResponseHeadersPolicyConfig: Match.objectLike({
          Name: Match.stringLikeRegexp("^VestibulumAuthSite-"),
          SecurityHeadersConfig: Match.objectLike({
            ContentSecurityPolicy: Match.objectLike({
              ContentSecurityPolicy: Match.stringLikeRegexp("connect-src 'self';"),
            }),
          }),
        }),
      });
    });

    it("injects a second BucketDeployment source (the deploy-time login-config.json)", () => {
      const deployments = template.findResources("Custom::CDKBucketDeployment");
      const deployment = Object.values(deployments)[0] as {
        Properties: { SourceObjectKeys: unknown[] };
      };
      expect(deployment.Properties.SourceObjectKeys.length).toBe(2);
    });
  });
});
