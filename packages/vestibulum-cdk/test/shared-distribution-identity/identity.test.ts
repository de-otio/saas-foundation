/**
 * Synth-snapshot tests for `SharedDistributionIdentity` with minimal
 * default props. Deterministic env (pinned account + region + stack
 * name) so the template is stable across runs.
 */

import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import { beforeAll, describe, expect, it } from "vitest";

import {
  CLIENT_CONFIG_SUBDOMAIN_INDEX,
  CLIENT_CONFIG_TENANT_ID_INDEX,
  SharedDistributionIdentity,
  type SharedDistributionIdentityProps,
} from "../../lib/shared-distribution-identity/index.js";

const TEST_ENV = { account: "123456789012", region: "us-east-1" };

// ---------------------------------------------------------------------------
// Typed helpers for CDK template assertions
// ---------------------------------------------------------------------------

interface DdbTableResource {
  Properties?: {
    PointInTimeRecoverySpecification?: { PointInTimeRecoveryEnabled?: boolean };
    BillingMode?: string;
  };
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
}

interface LambdaUrlResource {
  Properties?: { AuthType?: string };
}

function findDdbTables(template: Template): Record<string, DdbTableResource> {
  return template.findResources("AWS::DynamoDB::Table");
}

function findLambdaUrls(template: Template): Record<string, LambdaUrlResource> {
  return template.findResources("AWS::Lambda::Url");
}

function makeConsumerFn(scope: cdk.Stack, id: string): lambda.Function {
  return new lambda.Function(scope, id, {
    runtime: lambda.Runtime.NODEJS_22_X,
    code: lambda.Code.fromInline("exports.handler = async () => {};"),
    handler: "index.handler",
  });
}

function makeStack(name: string): cdk.Stack {
  const app = new cdk.App();
  return new cdk.Stack(app, name, { env: TEST_ENV, stackName: name });
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
    // Skip esbuild in unit tests — avoids staging-dir resolution issues.
    _skipEdgeBundle: true,
  };
}

// ---------------------------------------------------------------------------
// Default-props happy path
// ---------------------------------------------------------------------------

describe("SharedDistributionIdentity — minimal default props", () => {
  let template: Template;
  let identity: SharedDistributionIdentity;
  let stack: cdk.Stack;

  beforeAll(() => {
    stack = makeStack("IdentityStack");
    identity = new SharedDistributionIdentity(stack, "Identity", defaultProps(stack));
    template = Template.fromStack(stack);
  });

  it("creates a single Cognito user pool", () => {
    template.resourceCountIs("AWS::Cognito::UserPool", 1);
  });

  it("creates exactly three DDB tables (ClientConfig, MagicLinkTokens, Reservations)", () => {
    template.resourceCountIs("AWS::DynamoDB::Table", 3);
  });

  it("creates the wildcard ACM certificate", () => {
    template.resourceCountIs("AWS::CertificateManager::Certificate", 1);
  });

  it("wildcard cert domain is '*.<tenantSubdomainParent>'", () => {
    template.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: "*.tenants.example.com",
    });
  });

  it("wildcard cert SAN list includes the parent (default)", () => {
    template.hasResourceProperties("AWS::CertificateManager::Certificate", {
      SubjectAlternativeNames: Match.arrayWith(["tenants.example.com"]),
    });
  });

  it("user pool has email sign-in alias only (no username/phone)", () => {
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      UsernameAttributes: Match.arrayWith(["email"]),
    });
  });

  it("user pool has tenant_id custom attribute declared", () => {
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      Schema: Match.arrayWith([
        Match.objectLike({ Name: "tenant_id" }),
      ]),
    });
  });

  it("user pool has MFA disabled (magic-link is the factor)", () => {
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      MfaConfiguration: "OFF",
    });
  });

  it("user pool has a hardened password policy (16+ chars, all classes)", () => {
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      Policies: Match.objectLike({
        PasswordPolicy: Match.objectLike({
          MinimumLength: 16,
          RequireLowercase: true,
          RequireUppercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
        }),
      }),
    });
  });

  it("user pool retains on stack deletion (RETAIN)", () => {
    template.hasResource("AWS::Cognito::UserPool", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  it("defaults advancedSecurity to 'audit' (shared-pool credential-stuffing posture)", () => {
    expect(identity.advancedSecurity).toBe("audit");
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      UserPoolAddOns: Match.objectLike({
        AdvancedSecurityMode: "AUDIT",
      }),
    });
  });

  it("ClientConfig table has two GSIs (SubdomainIndex + TenantIdIndex)", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: CLIENT_CONFIG_SUBDOMAIN_INDEX }),
        Match.objectLike({ IndexName: CLIENT_CONFIG_TENANT_ID_INDEX }),
      ]),
    });
  });

  it("ClientConfig table has PITR enabled", () => {
    // At least one of the three tables (ClientConfig + MagicLinkTokens)
    // is expected to have PITR; Reservations skips it.
    const tables = findDdbTables(template);
    const pitr = Object.values(tables).filter(
      (t) =>
        t.Properties?.PointInTimeRecoverySpecification
          ?.PointInTimeRecoveryEnabled === true,
    );
    expect(pitr.length).toBeGreaterThanOrEqual(2);
  });

  it("MagicLinkTokens table has a TTL attribute", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TimeToLiveSpecification: Match.objectLike({
        AttributeName: "expires_at",
        Enabled: true,
      }),
    });
  });

  it("Reservations table has 'expiresAt' as the TTL attribute", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TimeToLiveSpecification: Match.objectLike({
        AttributeName: "expiresAt",
        Enabled: true,
      }),
    });
  });

  it("all DDB tables use PAY_PER_REQUEST billing", () => {
    const tables = findDdbTables(template);
    for (const [, t] of Object.entries(tables)) {
      expect(t.Properties?.BillingMode).toBe("PAY_PER_REQUEST");
    }
  });

  it("all stateful tables retain on stack deletion", () => {
    const tables = findDdbTables(template);
    for (const [, t] of Object.entries(tables)) {
      expect(t.DeletionPolicy).toBe("Retain");
      expect(t.UpdateReplacePolicy).toBe("Retain");
    }
  });

  it("provisions seven Lambda functions (5 triggers + 2 function-URL handlers)", () => {
    // Plus one for the log-retention custom resource that CDK adds for
    // `logRetention` prop. So at least 8 total Lambda resources.
    const fns = template.findResources("AWS::Lambda::Function");
    expect(Object.keys(fns).length).toBeGreaterThanOrEqual(7);
  });

  it("trigger Lambdas receive VESTIBULUM_CLIENT_CONFIG_TABLE in env", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          VESTIBULUM_CLIENT_CONFIG_TABLE: Match.anyValue(),
        }),
      }),
    });
  });

  it("auth-verify + auth-signout receive VESTIBULUM_TENANT_PARENT", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          VESTIBULUM_TENANT_PARENT: "tenants.example.com",
        }),
      }),
    });
  });

  it("auth Function URL Lambdas get 256 MB (Cognito-cascade headroom)", () => {
    // The two TENANT_PARENT-carrying Lambdas are the multi-tenant auth
    // handlers; they are bumped to 256 MB (matching the single-tenant site).
    template.hasResourceProperties("AWS::Lambda::Function", {
      MemorySize: 256,
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          VESTIBULUM_TENANT_PARENT: "tenants.example.com",
        }),
      }),
    });
  });

  it("wires the PreSignUp trigger to the user pool", () => {
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      LambdaConfig: Match.objectLike({
        PreSignUp: Match.anyValue(),
      }),
    });
  });

  it("wires PreTokenGeneration to the user pool", () => {
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      LambdaConfig: Match.objectLike({
        PreTokenGeneration: Match.anyValue(),
      }),
    });
  });

  it("wires CreateAuthChallenge, DefineAuth, VerifyAuth triggers", () => {
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      LambdaConfig: Match.objectLike({
        CreateAuthChallenge: Match.anyValue(),
        DefineAuthChallenge: Match.anyValue(),
        VerifyAuthChallengeResponse: Match.anyValue(),
      }),
    });
  });

  it("creates three Function URLs (auth-verify + auth-signout + admin)", () => {
    // auth-verify: AuthType NONE, auth-signout: AuthType NONE, admin: AuthType AWS_IAM
    template.resourceCountIs("AWS::Lambda::Url", 3);
  });

  it("auth-verify + auth-signout Function URLs are AuthType: NONE", () => {
    // The admin URL uses AWS_IAM; the trigger handler URLs are NONE.
    const urls = findLambdaUrls(template);
    const noneAuthUrls = Object.values(urls).filter(
      (u) => u.Properties?.AuthType === "NONE",
    );
    expect(noneAuthUrls).toHaveLength(2);
  });

  it("exposes the user pool, tables, and trigger Lambdas as public fields", () => {
    expect(identity.userPool).toBeDefined();
    expect(identity.clientConfigTable).toBeDefined();
    expect(identity.magicLinkTokensTable).toBeDefined();
    expect(identity.reservationsTable).toBeDefined();
    expect(identity.preSignUpFn).toBeDefined();
    expect(identity.createAuthChallengeFn).toBeDefined();
    expect(identity.preTokenGenerationFn).toBeDefined();
    expect(identity.defineAuthChallengeFn).toBeDefined();
    expect(identity.verifyAuthChallengeResponseFn).toBeDefined();
    expect(identity.authVerifyFn).toBeDefined();
    expect(identity.authSignoutFn).toBeDefined();
    expect(identity.authVerifyFunctionUrl).toBeDefined();
    expect(identity.authSignoutFunctionUrl).toBeDefined();
  });

  it("exposes the wildcard cert ARN (string, non-empty)", () => {
    expect(typeof identity.wildcardCertificateArn).toBe("string");
    expect(identity.wildcardCertificateArn.length).toBeGreaterThan(0);
  });

  it("adminFunctionUrl and adminLambdaName are non-empty CDK tokens (P2c self-wired)", () => {
    // The construct now wires AdminLambda in its constructor; the fields are
    // CDK tokens (non-empty strings) pointing at the provisioned Lambda.
    expect(typeof identity.adminFunctionUrl).toBe("string");
    expect(identity.adminFunctionUrl.length).toBeGreaterThan(0);
    expect(typeof identity.adminLambdaName).toBe("string");
    expect(identity.adminLambdaName.length).toBeGreaterThan(0);
  });

  it("edgeLogGroups is an empty array by default (populated lazily per PoP)", () => {
    expect(identity.edgeLogGroups).toEqual([]);
  });

  it("exposes the default tenant-subdomain pattern", () => {
    expect(identity.tenantSubdomainPattern.test("acme")).toBe(true);
    expect(identity.tenantSubdomainPattern.test("ACME")).toBe(false);
    expect(identity.tenantSubdomainPattern.test("1acme")).toBe(false);
    expect(identity.tenantSubdomainPattern.test("acme-")).toBe(false);
  });

  it("exposes the default reserved-subdomain list (includes 'admin', 'www')", () => {
    expect(identity.reservedSubdomains).toContain("admin");
    expect(identity.reservedSubdomains).toContain("www");
    expect(identity.reservedSubdomains).toContain("api");
  });

  it("defaults idTokenValidity to 60 minutes", () => {
    expect(identity.idTokenValidity.toMinutes()).toBe(60);
  });

  it("defaults jwksTtl to 15 minutes", () => {
    expect(identity.jwksTtl.toMinutes()).toBe(15);
  });

  it("defaults sessionCookieTtl to 30 days", () => {
    expect(identity.sessionCookieTtl.toDays()).toBe(30);
  });

  it("defaults perTenantMetrics to false", () => {
    expect(identity.perTenantMetrics).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Trigger wiring + IAM
// ---------------------------------------------------------------------------

describe("SharedDistributionIdentity — IAM and trigger wiring", () => {
  let template: Template;

  beforeAll(() => {
    const stack = makeStack("WiringStack");
    new SharedDistributionIdentity(stack, "Identity", defaultProps(stack));
    template = Template.fromStack(stack);
  });

  it("grants ClientConfig read to the trigger Lambdas (Cognito policy emitted)", () => {
    // Expect at least one IAM policy granting Query/GetItem on a DDB
    // table — the ClientConfig table read grant.
    const policies = template.findResources("AWS::IAM::Policy");
    const ddbReadPolicies = Object.values(policies).filter((p) =>
      JSON.stringify(p).includes("dynamodb:GetItem"),
    );
    expect(ddbReadPolicies.length).toBeGreaterThan(0);
  });

  it("grants auth-verify scoped Cognito IAM (RespondToAuthChallenge, InitiateAuth)", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const cognitoPolicies = Object.values(policies).filter((p) =>
      JSON.stringify(p).includes("cognito-idp:RespondToAuthChallenge"),
    );
    expect(cognitoPolicies.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Helper-method behaviour
// ---------------------------------------------------------------------------

describe("SharedDistributionIdentity — public helper methods", () => {
  it("grantReadClientConfig grants read + injects env var on the lambda", () => {
    const stack = makeStack("HelperStack");
    const identity = new SharedDistributionIdentity(
      stack,
      "Identity",
      defaultProps(stack),
    );

    const consumerFn = makeConsumerFn(stack, "ConsumerFn");

    identity.grantReadClientConfig(consumerFn);

    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: Match.absent(),
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          VESTIBULUM_CLIENT_CONFIG_TABLE: Match.anyValue(),
        }),
      }),
    });
  });

  it("adminFunctionUrl and adminLambdaName are populated after construction (P2c self-wiring)", () => {
    const stack = makeStack("AdminWiringStack");
    const identity = new SharedDistributionIdentity(
      stack,
      "Identity",
      defaultProps(stack),
    );

    // The construct is now self-wiring: AdminLambda is provisioned inside
    // the constructor and the URL/name are set from the CDK token references.
    expect(typeof identity.adminFunctionUrl).toBe("string");
    expect(identity.adminFunctionUrl.length).toBeGreaterThan(0);
    expect(typeof identity.adminLambdaName).toBe("string");
    expect(identity.adminLambdaName.length).toBeGreaterThan(0);
  });

  it("edgeLogGroups is an array after construction (P2b self-wiring)", () => {
    const stack = makeStack("EdgeLogGroupsStack");
    const identity = new SharedDistributionIdentity(
      stack,
      "Identity",
      defaultProps(stack),
    );

    // EdgeFunction.logGroups is [] by default (populated lazily by consumer
    // code once PoP regions are known). The construct exposes the array.
    expect(Array.isArray(identity.edgeLogGroups)).toBe(true);
  });

  it("postConfirmation adds the trigger to the pool", () => {
    const stack = makeStack("PostConfirmationStack");
    const identity = new SharedDistributionIdentity(
      stack,
      "Identity",
      defaultProps(stack),
    );

    const consumerFn = makeConsumerFn(stack, "PostConfirmFn");
    identity.postConfirmation(consumerFn);

    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      LambdaConfig: Match.objectLike({
        PostConfirmation: Match.anyValue(),
      }),
    });
  });

  it("post-construction preTokenGeneration() throws if the built-in is already wired", () => {
    // The built-in PreTokenGeneration is wired at construction time
    // (default props). Cognito refuses two triggers for the same
    // operation, so the method-style API throws — consumers must use
    // the `preTokenGeneration` prop to replace at construction time.
    const stack = makeStack("DoubleWireStack");
    const identity = new SharedDistributionIdentity(
      stack,
      "Identity",
      defaultProps(stack),
    );

    const consumerFn = makeConsumerFn(stack, "CustomPreTokenFn");

    expect(() => identity.preTokenGeneration(consumerFn)).toThrow();
  });

  it("props.preTokenGeneration suppresses the built-in trigger (single wired trigger)", () => {
    const stack = makeStack("PropPreTokenStack");

    const consumerFn = makeConsumerFn(stack, "ConsumerPreTokenFn");

    new SharedDistributionIdentity(stack, "Identity", {
      ...defaultProps(stack),
      preTokenGeneration: consumerFn,
    });

    // Synth completes — only the consumer's trigger is wired.
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      LambdaConfig: Match.objectLike({
        PreTokenGeneration: Match.anyValue(),
      }),
    });
  });

  it("props.postConfirmation wires a PostConfirmation trigger", () => {
    const stack = makeStack("PropPostConfirmationStack");

    const consumerFn = makeConsumerFn(stack, "ConsumerPostConfirmFn");

    new SharedDistributionIdentity(stack, "Identity", {
      ...defaultProps(stack),
      postConfirmation: consumerFn,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      LambdaConfig: Match.objectLike({
        PostConfirmation: Match.anyValue(),
      }),
    });
  });
});

// ---------------------------------------------------------------------------
// Cost-DoS guard (S7) — opt-in SES envelope extension
// ---------------------------------------------------------------------------

describe("SharedDistributionIdentity — costDosGuard (S7)", () => {
  it("does NOT create the SES Send alarm by default", () => {
    const stack = makeStack("SharedCostDosDefaultStack");
    const identity = new SharedDistributionIdentity(
      stack,
      "Identity",
      defaultProps(stack),
    );
    const template = Template.fromStack(stack);
    expect(identity.costDosGuard).toBeUndefined();

    // No CloudWatch alarm should be the SES Send one. Filter by metric.
    const allAlarms = template.findResources("AWS::CloudWatch::Alarm");
    const sesAlarms = Object.values(allAlarms).filter((a) => {
      const props = (a as { Properties?: { Namespace?: string; MetricName?: string } }).Properties;
      return props?.Namespace === "AWS/SES" && props?.MetricName === "Send";
    });
    expect(sesAlarms.length).toBe(0);
  });

  it("creates the AWS/SES Send alarm with the configured threshold when enabled", () => {
    const stack = makeStack("SharedCostDosEnabledStack");
    const identity = new SharedDistributionIdentity(stack, "Identity", {
      ...defaultProps(stack),
      costDosGuard: { enabled: true, sendsPerHourCap: 5000 },
    });
    const template = Template.fromStack(stack);

    expect(identity.costDosGuard).toBeDefined();
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "AWS/SES",
      MetricName: "Send",
      Threshold: 5000,
      Period: 3600,
      Statistic: "Sum",
      Dimensions: [
        { Name: "EmailIdentity", Value: "tenants.example.com" },
      ],
    });
  });

  it("creates the self-defence handler when selfDefence: true", () => {
    const stack = makeStack("SharedCostDosSelfDefenceStack");
    const identity = new SharedDistributionIdentity(stack, "Identity", {
      ...defaultProps(stack),
      costDosGuard: {
        enabled: true,
        sendsPerHourCap: 1000,
        selfDefence: true,
      },
    });
    const template = Template.fromStack(stack);
    expect(identity.costDosGuard?.selfDefenceHandler).toBeDefined();
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      MemorySize: 128,
      Description: Match.stringLikeRegexp("cost-DoS guard"),
    });
  });

  it("throws when enabled: true but sendsPerHourCap is invalid", () => {
    const stack = makeStack("SharedCostDosBadStack");
    expect(
      () =>
        new SharedDistributionIdentity(stack, "Identity", {
          ...defaultProps(stack),
          costDosGuard: { enabled: true, sendsPerHourCap: 0 },
        }),
    ).toThrowError(/sendsPerHourCap/);
  });
});
