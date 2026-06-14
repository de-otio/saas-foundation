/**
 * cdk-nag snapshot test for the P2b sub-stack (CloudFront + edge + WAF +
 * security headers).
 *
 * Documented intentional violations (surfaced in the snapshot so any
 * regression introducing a NEW finding fails the test):
 *
 * - **AwsSolutions-CFR1**: viewer-protocol policy is REDIRECT_TO_HTTPS,
 *   not HTTPS_ONLY. Mistyped `http://` URLs need to redirect cleanly.
 *   Acknowledged.
 * - **AwsSolutions-CFR3**: access logging is not configured by default.
 *   Consumer can attach via the `distribution` escape hatch.
 *   Acknowledged.
 * - **AwsSolutions-CFR4**: TLS minimum is TLSv1.2_2021 (AWS recommended
 *   baseline). Acknowledged.
 * - **AwsSolutions-L1**: NODEJS_20_X for Lambda@Edge. Pinned to the
 *   highest L@E-supported runtime; bumping requires AWS to extend
 *   L@E support first. Acknowledged.
 * - **AwsSolutions-IAM4 / IAM5**: the BucketDeployment custom resource
 *   ships AWS-managed policies; outside the scope of P2b. Acknowledged.
 * - **AwsSolutions-S1 / S10**: the login-page bucket access logging
 *   defaults are addressed by enforceSSL: true, autoDeleteObjects:
 *   true; the missing server access log is consumer-decision per S-C13.
 *   Acknowledged.
 * - **AwsSolutions-WAF2**: rate-limit rules don't have request-sampling
 *   visibility config differences from the AWS-managed defaults; both
 *   carry `sampledRequestsEnabled: true`. Snapshot pins the shape.
 */

import { Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks, NagSuppressions } from "cdk-nag";
import { afterAll, describe, expect, it } from "vitest";

import { CloudFrontDistribution } from "../../lib/shared-distribution-identity/cloudfront-distribution.js";
import { EdgeFunction } from "../../lib/shared-distribution-identity/edge-function.js";
import { Waf } from "../../lib/shared-distribution-identity/waf.js";
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

describe("P2b cdk-nag snapshot", () => {
  it("snapshots the cdk-nag findings for CloudFront + Edge + WAF", () => {
    const { app, stack } = makeTestStack("P2bNagStack");
    const userPool = makeUserPool(stack);
    const bundleDir = makeTmpDir();
    const edge = new EdgeFunction(stack, "Edge", {
      tenantSubdomainParent: "tenants.example.com",
      tenantSubdomainPattern: TENANT_PATTERN,
      userPool,
      _skipBundle: true,
      _bundleOutDirOverride: bundleDir,
    });
    const waf = new Waf(stack, "Waf", { userPool });
    new CloudFrontDistribution(stack, "Dist", {
      tenantSubdomainParent: "tenants.example.com",
      wildcardCertificateArn: TEST_CERT_ARN,
      authVerifyFunctionUrl: "https://a.lambda-url.eu-central-1.on.aws/",
      authSignoutFunctionUrl: "https://b.lambda-url.eu-central-1.on.aws/",
      edgeFunctionVersion: edge.version,
      webAclArn: waf.cloudFrontWebAclArn,
      _packageRoot: makeMockCdkPackageRoot(),
    });

    // Documented suppressions for findings that are intentional in the
    // shared-distribution design. Each carries the rationale shown in
    // the file-level comment.
    NagSuppressions.addStackSuppressions(stack, [
      {
        id: "AwsSolutions-CFR1",
        reason:
          "REDIRECT_TO_HTTPS by intent — mistyped http:// URLs redirect cleanly to https://.",
      },
      {
        id: "AwsSolutions-CFR3",
        reason:
          "Access logging is a consumer-decision; the construct exposes the distribution for escape-hatch attachment.",
      },
      {
        id: "AwsSolutions-CFR4",
        reason: "TLSv1.2_2021 is the AWS recommended baseline.",
      },
      {
        id: "AwsSolutions-CFR2",
        reason:
          "WAF is wired via webAclArn; default behaviour passes through edge check-auth which provides the auth gate.",
      },
      {
        id: "AwsSolutions-L1",
        reason: "NODEJS_20_X is the highest L@E-supported Node runtime.",
      },
      {
        id: "AwsSolutions-IAM4",
        reason:
          "BucketDeployment custom resource ships AWS-managed policies; out of scope for P2b.",
      },
      {
        id: "AwsSolutions-IAM5",
        reason:
          "BucketDeployment custom resource uses '*' resources on S3 actions scoped to its own bucket; CDK-managed.",
      },
      {
        id: "AwsSolutions-S1",
        reason:
          "Login-page bucket: server access logging is consumer-decision per S-C13; bucket holds public static assets only.",
      },
      {
        id: "AwsSolutions-S10",
        reason: "enforceSSL is on; the bucket is private behind CloudFront OAC.",
      },
    ]);

    Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: false }));
    const synth = app.synth({ force: true });
    const messages = synth.getStackArtifact(stack.artifactId).messages;
    // cdk-nag findings carry an `entry.trace` of absolute-path stack frames
    // that differ per machine (local vs CI runner), making a raw snapshot
    // non-portable. Snapshot only the portable finding content.
    const portable = messages.map((m) => ({
      level: m.level,
      id: m.id,
      entry: { type: m.entry.type, data: m.entry.data },
    }));
    expect(portable).toMatchSnapshot();
  });
});
