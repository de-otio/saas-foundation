/**
 * cdk-nag snapshot test for EdgeResources.
 *
 * Applies AwsSolutionsChecks to a stack containing a default
 * EdgeResources and snapshots the resulting warnings/errors.
 *
 * Intentional violations (suppressed in snapshot context but documented):
 *   - none at the EdgeResources level by default. WAF default action
 *     is `Allow` with a managed-rule allowlist, which cdk-nag is
 *     comfortable with.
 *
 * Things this snapshot guards against:
 *   - Accidental regression in default WAF rule shape that introduces
 *     a new nag finding.
 *   - Cert without DNS validation (would surface a different finding).
 */

import * as cdk from "aws-cdk-lib";
import { Aspects } from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";
import { AwsSolutionsChecks } from "cdk-nag";
import { describe, expect, it } from "vitest";

import { EdgeResources } from "../../lib/edge-resources/index.js";

const TEST_ENV = { account: "123456789012", region: "us-east-1" };

describe("EdgeResources cdk-nag snapshot", () => {
  it("produces the expected nag findings for a default EdgeResources", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "EdgeResourcesNagStack", {
      env: TEST_ENV,
      stackName: "EdgeResourcesNagStack",
    });

    const zone = route53.HostedZone.fromHostedZoneAttributes(stack, "Zone", {
      hostedZoneId: "Z123456789EXAMPLE",
      zoneName: "example.com",
    });

    new EdgeResources(stack, "Edge", {
      domain: "app.example.com",
      hostedZone: zone,
    });

    Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: false }));
    const synth = app.synth({ force: true });
    const messages = synth.getStackArtifact(stack.artifactId).messages;

    expect(messages).toMatchSnapshot();
  });
});
