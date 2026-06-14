/**
 * cdk-nag snapshot test for MagicLinkAuthSite.
 *
 * Intentional violations (documented; surfaced in the snapshot so a
 * regression that introduces a new finding fails the test):
 *
 * - AwsSolutions-CFR1: CloudFront viewer-protocol policy is
 *   `REDIRECT_TO_HTTPS`, not `HTTPS_ONLY`. Rationale: redirect-to-HTTPS
 *   from HTTP keeps mistyped `http://` URLs reachable. Acknowledged.
 * - AwsSolutions-CFR3: access logging is not configured by default.
 *   The consumer enables it via `site.distribution` escape hatch when
 *   they want it; defaulting it on imposes an S3 bucket the construct
 *   doesn't otherwise need. Acknowledged.
 * - AwsSolutions-CFR4: viewer cert TLSv1.2_2021 is the AWS recommended
 *   minimum (not TLSv1.2_2021_BIDI). Acknowledged.
 * - AwsSolutions-L1: the Lambda runtimes (NODEJS_22_X, NODEJS_20_X for
 *   L@E) match the documented bundle pipeline. Acknowledged.
 * - AwsSolutions-IAM5: the regional auth Lambdas hold `dynamodb:*` on
 *   the test stack's mock tables — the wildcard is scoped to the
 *   specific table ARNs by the CDK grant helpers.
 */

import * as fs from "node:fs";

import * as cdk from "aws-cdk-lib";
import { Aspects } from "aws-cdk-lib";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as s3 from "aws-cdk-lib/aws-s3";
import { AwsSolutionsChecks } from "cdk-nag";
import { afterAll, describe, expect, it } from "vitest";

import { EdgeResources } from "../../lib/edge-resources/index.js";
import { MagicLinkAuthSite } from "../../lib/magic-link-auth-site/index.js";
import { MOCK_BUNDLE_MANIFEST, makeMockPackageRoot } from "../fixtures/mock-bundle-manifest.js";
import { MockIdentity } from "../fixtures/mock-identity.js";

const TEST_ENV = { account: "123456789012", region: "us-east-1" };
const tmpRoots: string[] = [];

describe("MagicLinkAuthSite cdk-nag snapshot", () => {
  afterAll(() => {
    for (const root of tmpRoots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("produces the expected nag findings for a default MagicLinkAuthSite", () => {
    const root = makeMockPackageRoot();
    tmpRoots.push(root);

    const app = new cdk.App();
    const stack = new cdk.Stack(app, "AuthSiteNagStack", {
      env: TEST_ENV,
      stackName: "AuthSiteNagStack",
      crossRegionReferences: true,
    });

    const zone = route53.HostedZone.fromHostedZoneAttributes(stack, "Zone", {
      hostedZoneId: "Z123456789EXAMPLE",
      zoneName: "example.com",
    });
    const identity = new MockIdentity(stack, "Identity");
    const edge = new EdgeResources(stack, "Edge", {
      domain: "app.example.com",
      hostedZone: zone,
    });
    const originBucket = new s3.Bucket(stack, "OriginBucket") as unknown as s3.IBucket;
    new MagicLinkAuthSite(stack, "Site", {
      domain: "app.example.com",
      origin: origins.S3BucketOrigin.withOriginAccessControl(originBucket),
      edge,
      identity,
      _packageRoot: root,
      _bundleManifest: MOCK_BUNDLE_MANIFEST,
    });

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
