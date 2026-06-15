/**
 * CDK assertion-based tests for `MagicLinkIdentity`.
 *
 * Deterministic inputs (pinned stack name, account 123456789012, region
 * eu-west-1) so synth output is stable across runs.
 */

import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as route53 from "aws-cdk-lib/aws-route53";
import { beforeAll, describe, expect, it } from "vitest";

import {
  MagicLinkIdentity,
  MagicLinkIdentityPropsError,
  type MagicLinkIdentityProps,
} from "../../lib/magic-link-identity/index.js";
import type { IMagicLinkIdentity } from "../../lib/_internal/identity-handle.js";

const TEST_ENV = { account: "123456789012", region: "eu-west-1" };

function makeStack(name: string): cdk.Stack {
  const app = new cdk.App();
  return new cdk.Stack(app, name, { env: TEST_ENV, stackName: name });
}

function makeZone(stack: cdk.Stack, id: string, name = "example.com"): route53.IHostedZone {
  return route53.HostedZone.fromHostedZoneAttributes(stack, id, {
    hostedZoneId: "Z123456789",
    zoneName: name,
  });
}

function defaultProps(stack: cdk.Stack): MagicLinkIdentityProps {
  return {
    hostedZone: makeZone(stack, "Zone"),
    allowedEmailDomains: ["example.com"],
    sesIdentitySender: "noreply@example.com",
  };
}

describe("MagicLinkIdentity — default props", () => {
  let template: Template;
  let identity: MagicLinkIdentity;

  beforeAll(() => {
    const stack = makeStack("IdentityStack");
    identity = new MagicLinkIdentity(stack, "Identity", defaultProps(stack));
    template = Template.fromStack(stack);
  });

  it("creates a Cognito user pool", () => {
    template.resourceCountIs("AWS::Cognito::UserPool", 1);
  });

  it("creates the five trigger Lambdas via Code.fromAsset (regional bundles)", () => {
    // 5 trigger Lambdas plus the CDK-generated log-retention custom-resource
    // helper Lambda (the deprecated `logRetention` prop emits one).
    template.resourceCountIs("AWS::Lambda::Function", 6);
  });

  it("pins runtime to nodejs22.x on the trigger Lambdas", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
    });
  });

  it("creates three DynamoDB tables", () => {
    template.resourceCountIs("AWS::DynamoDB::Table", 3);
  });

  it("retains the user pool on stack deletion", () => {
    template.hasResource("AWS::Cognito::UserPool", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  it("retains the token table on stack deletion", () => {
    template.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  it("creates an SES email identity", () => {
    template.resourceCountIs("AWS::SES::EmailIdentity", 1);
  });

  it("creates Route 53 records for DKIM, SPF, and DMARC", () => {
    // 3 DKIM CNAMEs + 1 SPF TXT + 1 DMARC TXT = 5 records.
    template.resourceCountIs("AWS::Route53::RecordSet", 5);
  });

  it("creates an SNS topic for SES bounces", () => {
    template.resourceCountIs("AWS::SNS::Topic", 1);
  });

  it("creates a Secrets Manager secret for HMAC hashing", () => {
    template.resourceCountIs("AWS::SecretsManager::Secret", 1);
  });

  it("does NOT attach a CfnUserPoolRiskConfigurationAttachment by default (B-H)", () => {
    template.resourceCountIs("AWS::Cognito::UserPoolRiskConfigurationAttachment", 0);
  });

  it("does NOT create a UserPoolDomain by default", () => {
    template.resourceCountIs("AWS::Cognito::UserPoolDomain", 0);
  });

  it("exposes federation flag as false by default", () => {
    expect(identity.federationEnabled).toBe(false);
  });

  it("defaults signupMode to 'open'", () => {
    expect(identity.signupMode).toBe("open");
  });

  it("injects SIGNUP_MODE env var on the PreSignUp lambda", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          VESTIBULUM_SIGNUP_MODE: "open",
        }),
      },
    });
  });

  it("sets advancedSecurity to 'off' by default", () => {
    expect(identity.advancedSecurity).toBe("off");
  });

  it("immutableAttributeSeverity defaults to 'error' (N3)", () => {
    expect(identity.immutableAttributeSeverity).toBe("error");
  });
});

describe("MagicLinkIdentity — federation enabled", () => {
  let template: Template;
  let identity: MagicLinkIdentity;

  beforeAll(() => {
    const stack = makeStack("FederationStack");
    identity = new MagicLinkIdentity(stack, "Identity", {
      ...defaultProps(stack),
      federationEnabled: true,
      featureTier: "Essentials",
      signupMode: "admin-invite-only",
      hostedUiDomain: { kind: "cognito", prefix: "test-auth" },
      customAttributes: [
        { name: "tenantId", dataType: "String", maxLength: 36 },
        { name: "tenantRole", dataType: "String", maxLength: 32 },
      ],
    });
    template = Template.fromStack(stack);
  });

  it("exposes federationEnabled: true", () => {
    expect(identity.federationEnabled).toBe(true);
  });

  it("creates a Cognito hosted UI domain", () => {
    template.resourceCountIs("AWS::Cognito::UserPoolDomain", 1);
  });

  it("declares the configured custom attributes on the pool", () => {
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      Schema: Match.arrayWith([
        Match.objectLike({ Name: "tenantId" }),
        Match.objectLike({ Name: "tenantRole" }),
      ]),
    });
  });

  it("injects SIGNUP_MODE='admin-invite-only' env on PreSignUp Lambda", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          VESTIBULUM_SIGNUP_MODE: "admin-invite-only",
        }),
      },
    });
  });
});

describe("MagicLinkIdentity — advancedSecurity (B-H opt-in)", () => {
  it("attaches the risk configuration when 'audit'", () => {
    const stack = makeStack("AuditStack");
    new MagicLinkIdentity(stack, "Identity", {
      ...defaultProps(stack),
      advancedSecurity: "audit",
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::Cognito::UserPoolRiskConfigurationAttachment", 1);
    template.hasResourceProperties("AWS::Cognito::UserPoolRiskConfigurationAttachment", {
      AccountTakeoverRiskConfiguration: {
        Actions: Match.objectLike({
          HighAction: Match.objectLike({ EventAction: "NO_ACTION" }),
        }),
      },
    });
  });

  it("attaches BLOCK actions when 'enforced'", () => {
    const stack = makeStack("EnforcedStack");
    new MagicLinkIdentity(stack, "Identity", {
      ...defaultProps(stack),
      advancedSecurity: "enforced",
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::Cognito::UserPoolRiskConfigurationAttachment", {
      AccountTakeoverRiskConfiguration: {
        Actions: Match.objectLike({
          HighAction: Match.objectLike({ EventAction: "BLOCK" }),
        }),
      },
    });
  });
});

describe("MagicLinkIdentity — synth-time errors (B-I, hosted UI)", () => {
  it("synth-errors when federation is enabled without signupMode (B-I)", () => {
    const stack = makeStack("NoSignupModeStack");
    expect(
      () =>
        new MagicLinkIdentity(stack, "Identity", {
          ...defaultProps(stack),
          federationEnabled: true,
          hostedUiDomain: { kind: "cognito", prefix: "x" },
        }),
    ).toThrowError(MagicLinkIdentityPropsError);
  });

  it("synth-errors when federation is enabled without hostedUiDomain", () => {
    const stack = makeStack("NoHostedUiStack");
    expect(
      () =>
        new MagicLinkIdentity(stack, "Identity", {
          ...defaultProps(stack),
          federationEnabled: true,
          signupMode: "admin-invite-only",
        }),
    ).toThrowError(/hostedUiDomain/);
  });

  it("synth-errors when custom-domain ACM cert is not in us-east-1", () => {
    const stack = makeStack("BadCertStack");
    expect(
      () =>
        new MagicLinkIdentity(stack, "Identity", {
          ...defaultProps(stack),
          federationEnabled: true,
          signupMode: "open",
          hostedUiDomain: {
            kind: "custom",
            domainName: "auth.example.com",
            acmCertArn: "arn:aws:acm:eu-west-1:123456789012:certificate/abcd-1234",
          },
        }),
    ).toThrowError(/us-east-1/);
  });

  it("synth-errors when sesIdentitySender domain does not match hosted zone", () => {
    const stack = makeStack("MismatchZoneStack");
    expect(
      () =>
        new MagicLinkIdentity(stack, "Identity", {
          hostedZone: makeZone(stack, "Zone", "different.test"),
          allowedEmailDomains: ["example.com"],
          sesIdentitySender: "noreply@example.com",
        }),
    ).toThrowError(/must match or be a subdomain/);
  });
});

// ---------------------------------------------------------------------------
// Cost-DoS guard (S7) — opt-in SES envelope extension
// ---------------------------------------------------------------------------

describe("MagicLinkIdentity — costDosGuard (S7)", () => {
  it("creates no SES Send alarm by default (current behaviour preserved)", () => {
    const stack = makeStack("CostDosDefaultStack");
    const identity = new MagicLinkIdentity(stack, "Identity", defaultProps(stack));
    const template = Template.fromStack(stack);

    expect(identity.costDosGuard).toBeUndefined();

    // Default ML identity already creates a bounce SNS topic — assert
    // exactly one topic exists (no extra cost-DoS topic).
    template.resourceCountIs("AWS::SNS::Topic", 1);

    // No CloudWatch alarms at all when the guard is off.
    template.resourceCountIs("AWS::CloudWatch::Alarm", 0);
  });

  it("creates no SES Send alarm when costDosGuard.enabled is false", () => {
    const stack = makeStack("CostDosDisabledStack");
    const identity = new MagicLinkIdentity(stack, "Identity", {
      ...defaultProps(stack),
      costDosGuard: { enabled: false, sendsPerHourCap: 1000 },
    });
    const template = Template.fromStack(stack);

    expect(identity.costDosGuard).toBeUndefined();
    template.resourceCountIs("AWS::CloudWatch::Alarm", 0);
  });

  it("creates the AWS/SES Send alarm with the configured threshold when enabled", () => {
    const stack = makeStack("CostDosEnabledStack");
    const identity = new MagicLinkIdentity(stack, "Identity", {
      ...defaultProps(stack),
      costDosGuard: { enabled: true, sendsPerHourCap: 2500 },
    });
    const template = Template.fromStack(stack);

    expect(identity.costDosGuard).toBeDefined();
    expect(identity.costDosGuard?.alarm).toBeDefined();
    expect(identity.costDosGuard?.alarmTopic).toBeDefined();

    template.resourceCountIs("AWS::CloudWatch::Alarm", 1);
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "AWS/SES",
      MetricName: "Send",
      Threshold: 2500,
      // 1-hour period
      Period: 3600,
      Statistic: "Sum",
      Dimensions: [
        {
          Name: "EmailIdentity",
          Value: "example.com",
        },
      ],
      ComparisonOperator: "GreaterThanThreshold",
      EvaluationPeriods: 1,
    });
  });

  it("auto-creates a dedicated SNS topic when none is supplied", () => {
    const stack = makeStack("CostDosTopicStack");
    new MagicLinkIdentity(stack, "Identity", {
      ...defaultProps(stack),
      costDosGuard: { enabled: true, sendsPerHourCap: 100 },
    });
    const template = Template.fromStack(stack);
    // Bounce topic + cost-DoS topic = 2.
    template.resourceCountIs("AWS::SNS::Topic", 2);
  });

  it("does NOT create the self-defence handler by default", () => {
    const stack = makeStack("CostDosNoSelfDefenceStack");
    const identity = new MagicLinkIdentity(stack, "Identity", {
      ...defaultProps(stack),
      costDosGuard: { enabled: true, sendsPerHourCap: 100 },
    });
    expect(identity.costDosGuard?.selfDefenceHandler).toBeUndefined();
    // 5 trigger Lambdas + log-retention helper = 6. No extra
    // self-defence Lambda.
    Template.fromStack(stack).resourceCountIs("AWS::Lambda::Function", 6);
  });

  it("creates the self-defence handler when selfDefence: true", () => {
    const stack = makeStack("CostDosSelfDefenceStack");
    const identity = new MagicLinkIdentity(stack, "Identity", {
      ...defaultProps(stack),
      costDosGuard: { enabled: true, sendsPerHourCap: 500, selfDefence: true },
    });
    const template = Template.fromStack(stack);

    expect(identity.costDosGuard?.selfDefenceHandler).toBeDefined();

    // 5 trigger Lambdas + log-retention helper + self-defence handler = 7.
    template.resourceCountIs("AWS::Lambda::Function", 7);

    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      MemorySize: 128,
      ReservedConcurrentExecutions: 1,
      Description: Match.stringLikeRegexp("cost-DoS guard"),
      Environment: {
        Variables: Match.objectLike({
          VESTIBULUM_USER_POOL_ID: Match.anyValue(),
        }),
      },
    });
  });

  it("subscribes the self-defence handler to the alarm's SNS topic", () => {
    const stack = makeStack("CostDosSubscribeStack");
    new MagicLinkIdentity(stack, "Identity", {
      ...defaultProps(stack),
      costDosGuard: { enabled: true, sendsPerHourCap: 100, selfDefence: true },
    });
    const template = Template.fromStack(stack);

    // Two subscriptions exist: bounce-handler -> bounce topic, and
    // self-defence -> cost-DoS topic.
    template.resourceCountIs("AWS::SNS::Subscription", 2);
    template.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "lambda",
    });
  });

  it("scopes the self-defence handler IAM to the pool ARN only", () => {
    const stack = makeStack("CostDosIamStack");
    new MagicLinkIdentity(stack, "Identity", {
      ...defaultProps(stack),
      costDosGuard: { enabled: true, sendsPerHourCap: 100, selfDefence: true },
    });
    const template = Template.fromStack(stack);

    // The handler's inline policy must grant the two Cognito admin
    // actions, scoped to a single resource (the pool ARN).
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              "cognito-idp:DescribeUserPool",
              "cognito-idp:UpdateUserPool",
            ]),
            Effect: "Allow",
          }),
        ]),
      }),
    });
  });

  it("throws when enabled: true but sendsPerHourCap is zero", () => {
    const stack = makeStack("CostDosBadThresholdStack");
    expect(
      () =>
        new MagicLinkIdentity(stack, "Identity", {
          ...defaultProps(stack),
          costDosGuard: { enabled: true, sendsPerHourCap: 0 },
        }),
    ).toThrowError(/sendsPerHourCap/);
  });

  it("throws when enabled: true but sendsPerHourCap is negative", () => {
    const stack = makeStack("CostDosNegThresholdStack");
    expect(
      () =>
        new MagicLinkIdentity(stack, "Identity", {
          ...defaultProps(stack),
          costDosGuard: { enabled: true, sendsPerHourCap: -1 },
        }),
    ).toThrowError(/sendsPerHourCap/);
  });

  it("throws when enabled: true but sendsPerHourCap is NaN", () => {
    const stack = makeStack("CostDosNanThresholdStack");
    expect(
      () =>
        new MagicLinkIdentity(stack, "Identity", {
          ...defaultProps(stack),
          costDosGuard: { enabled: true, sendsPerHourCap: Number.NaN },
        }),
    ).toThrowError(/sendsPerHourCap/);
  });
});

describe("MagicLinkIdentity — addAppClient (regression: method shipped missing in 0.3.3)", () => {
  it("creates a public app client with CUSTOM_AUTH on and password flows off", () => {
    const stack = makeStack("AddAppClientStack");
    const identity = new MagicLinkIdentity(stack, "Identity", defaultProps(stack));
    identity.addAppClient("WebsiteClient", {
      oauth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: ["https://app.example.com/login/callback"],
      },
      generateSecret: false,
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      ExplicitAuthFlows: Match.arrayWith(["ALLOW_CUSTOM_AUTH"]),
      GenerateSecret: false,
      AllowedOAuthFlows: ["code"],
    });
    // Password / SRP flows must be off — this is a public magic-link client.
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      ExplicitAuthFlows: Match.not(Match.arrayWith(["ALLOW_USER_PASSWORD_AUTH"])),
    });
  });

  it("rejects generateSecret: true (vestibulum app clients are public)", () => {
    const stack = makeStack("AddAppClientSecretStack");
    const identity = new MagicLinkIdentity(stack, "Identity", defaultProps(stack));
    expect(() => identity.addAppClient("ConfidentialClient", { generateSecret: true })).toThrowError(
      /generateSecret/,
    );
  });

  it("matches the IMagicLinkIdentity.addAppClient signature (compile-time guard)", () => {
    // 0.3.3 shipped this method missing; exactOptionalPropertyTypes prevents a
    // full `implements IMagicLinkIdentity` (Table vs ITable), so this guards
    // the one member that regressed. `.bind` keeps the type check while
    // avoiding the unbound-method lint.
    const stack = makeStack("AddAppClientGuardStack");
    const identity = new MagicLinkIdentity(stack, "Identity", defaultProps(stack));
    const guard: IMagicLinkIdentity["addAppClient"] = identity.addAppClient.bind(identity);
    expect(typeof guard).toBe("function");
  });
});
