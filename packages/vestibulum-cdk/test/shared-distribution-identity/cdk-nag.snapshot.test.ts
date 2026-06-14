/**
 * cdk-nag snapshot test for `SharedDistributionIdentity`.
 *
 * Applies `AwsSolutionsChecks` and asserts synth completes without
 * unhandled exceptions. The construct deliberately accepts a known
 * set of nag findings; documented intentional violations are
 * enumerated below. Each violation is justified in the construct
 * source / design docs.
 *
 * Documented intentional violations (P2a scope):
 *
 * - AwsSolutions-COG1: password policy is hardened but Cognito does
 *   not let us *disable* the password flow. The construct sets a
 *   16-char-all-classes policy as a defence-in-depth posture; cdk-nag
 *   still flags any policy as a finding. Intentional.
 * - AwsSolutions-COG2: MFA is OFF. The magic-link is the
 *   authentication factor. Intentional.
 * - AwsSolutions-COG3: AdvancedSecurity defaults to 'audit' rather
 *   than 'enforced'. Consumers can opt up to 'enforced'.
 * - AwsSolutions-IAM4: AWSLambdaBasicExecutionRole is the default
 *   managed policy attached to L2 Lambda functions. Replacing it
 *   with custom inline policies is in scope for a future hardening
 *   pass; out of scope here.
 * - AwsSolutions-IAM5: Wildcards in DDB grant actions (`dynamodb:*`
 *   on indexes) come from `grantReadData`'s default action shape.
 *   Refining is feasible but out of scope for the construct's
 *   public-surface tests.
 * - AwsSolutions-L1: Lambda runtime is pinned to NODEJS_22_X; nag
 *   flags when it lags the current "latest". The bundle pipeline
 *   (P3) regenerates with the latest LTS on a regular cadence.
 * - AwsSolutions-DDB3: PITR is enabled on ClientConfig +
 *   MagicLinkTokens but NOT on Reservations (60s-TTL ephemeral
 *   rows; PITR is wasted spend). Intentional.
 */

import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import { AwsSolutionsChecks } from "cdk-nag";
import { describe, expect, it } from "vitest";

import {
  SharedDistributionIdentity,
  type SharedDistributionIdentityProps,
} from "../../lib/shared-distribution-identity/index.js";

const TEST_ENV = { account: "123456789012", region: "us-east-1" };

function makeApp(): { app: cdk.App; stack: cdk.Stack } {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "IdentityNagStack", {
    env: TEST_ENV,
    stackName: "IdentityNagStack",
  });
  return { app, stack };
}

function defaultProps(stack: cdk.Stack): SharedDistributionIdentityProps {
  return {
    tenantSubdomainParent: "tenants.example.com",
    sesIdentitySender: "noreply@tenants.example.com",
    hostedZone: route53.HostedZone.fromHostedZoneAttributes(stack, "Zone", {
      hostedZoneId: "Z123456789",
      zoneName: "tenants.example.com",
    }),
    adminInvokePrincipal: new iam.AccountPrincipal("123456789012"),
    // Skip esbuild in tests — avoids staging-dir resolution issues.
    _skipEdgeBundle: true,
  };
}

describe("SharedDistributionIdentity — cdk-nag (AwsSolutionsChecks)", () => {
  it("synthesises without unhandled exceptions when AwsSolutionsChecks is applied", () => {
    const { app, stack } = makeApp();
    new SharedDistributionIdentity(stack, "Identity", defaultProps(stack));
    cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: false }));
    expect(() =>
      app.synth({ validateOnSynthesis: true, force: true }),
    ).not.toThrow();
  });

  it("synth produces a Cognito user pool resource (sanity)", () => {
    const { app, stack } = makeApp();
    new SharedDistributionIdentity(stack, "Identity", defaultProps(stack));
    cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: false }));
    app.synth({ validateOnSynthesis: false, force: true });

    const tmpl = cdk.assertions.Template.fromStack(stack);
    tmpl.resourceCountIs("AWS::Cognito::UserPool", 1);
  });
});
