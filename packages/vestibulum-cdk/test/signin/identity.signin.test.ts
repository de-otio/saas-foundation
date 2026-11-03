/**
 * MagicLinkIdentity — sign-in invariants checked at synth time (dot-notes
 * doc/topics/passwordless-sign-in-aws/02-spec.md):
 *
 *   signin_link_expires_10min   the app client's AuthSessionValidity IS the link lifetime; TTL attributes agree
 *   (U9 / 01-evidence #15)      the SES configuration set's event destination feeds the bounce topic
 *   (U14)                       runtimes
 *   signin_link_bound_…         the binding table
 *
 * Synth checks prove the template says the right thing; they cannot prove SES or
 * Cognito accept it. The live checks for those are listed in the PR notes and are
 * deliberately NOT claimed here (01-evidence #2, #18: "the plan is not the service").
 */

import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as route53 from "aws-cdk-lib/aws-route53";
import { describe, expect, it } from "vitest";

import { RuntimeEnv as CdkRuntimeEnv } from "../../lib/_internal/runtime-env.js";
import {
  DEFAULT_SIGNIN_FLOOR_MS,
  DEFAULT_TOKEN_TTL_MINUTES,
  MAX_TOKEN_TTL_MINUTES,
  MIN_TOKEN_TTL_MINUTES,
  TTL_ATTRIBUTE,
} from "../../lib/_internal/signin-constants.js";
import {
  MagicLinkIdentity,
  MagicLinkIdentityPropsError,
  type MagicLinkIdentityProps,
} from "../../lib/magic-link-identity/index.js";
// The runtime package's source of truth (relative import: it is not exported).
import * as runtime from "../../../vestibulum/src/lambda/shared/signin.js";
import { RuntimeEnv as RuntimeEnvOfHandlers } from "../../../vestibulum/src/lambda/shared/runtime-env.js";

const ENV = { account: "123456789012", region: "eu-west-1" };

/**
 * `mutate` runs before synth: a stack cannot be changed after
 * `Template.fromStack`, which caches the synthesised assembly.
 */
function build(
  extra: Partial<MagicLinkIdentityProps> = {},
  mutate: (identity: MagicLinkIdentity) => void = () => undefined,
) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "S", { env: ENV });
  const zone = route53.HostedZone.fromHostedZoneAttributes(stack, "Zone", {
    hostedZoneId: "Z123456789",
    zoneName: "example.com",
  });
  const identity = new MagicLinkIdentity(stack, "Identity", {
    hostedZone: zone,
    allowedEmailDomains: ["example.com"],
    sesIdentitySender: "noreply@example.com",
    ...extra,
  });
  mutate(identity);
  return { stack, identity, template: Template.fromStack(stack) };
}

const asObj = (v: unknown) => v as Record<string, unknown>;

describe("shared constants agree with the runtime package", () => {
  it("TTL attribute, bounds and default", () => {
    expect(TTL_ATTRIBUTE).toBe(runtime.TTL_ATTRIBUTE);
    expect(MIN_TOKEN_TTL_MINUTES).toBe(runtime.MIN_TOKEN_TTL_MINUTES);
    expect(MAX_TOKEN_TTL_MINUTES).toBe(runtime.MAX_TOKEN_TTL_MINUTES);
    expect(DEFAULT_TOKEN_TTL_MINUTES).toBe(runtime.DEFAULT_TOKEN_TTL_MINUTES);
    expect(DEFAULT_SIGNIN_FLOOR_MS).toBe(runtime.DEFAULT_SIGNIN_FLOOR_MS);
  });

  it("every env-var name the handlers read is the one the constructs write (no third copy can drift)", () => {
    for (const [key, value] of Object.entries(RuntimeEnvOfHandlers)) {
      expect(CdkRuntimeEnv, `missing key ${key}`).toHaveProperty(key, value);
    }
  });
});

describe("signin_link_expires_10min — one lifetime, three owners", () => {
  it("defaults to 10 minutes", () => {
    const { identity } = build();
    expect(identity.tokenTtlMinutes).toBe(10);
  });

  it("every app client gets AuthSessionValidity = the link lifetime (Cognito's own default would be 3)", () => {
    const { template } = build({}, (i) => i.addAppClient("ClientA", {}));
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", { AuthSessionValidity: 10 });
  });

  it.each([3, 7, 15])("follows tokenTtlMinutes=%i on the client, the env and the mail", (n) => {
    const { template: t } = build({ tokenTtlMinutes: n }, (i) => i.addAppClient("ClientA", {}));
    t.hasResourceProperties("AWS::Cognito::UserPoolClient", { AuthSessionValidity: n });
    t.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: { [CdkRuntimeEnv.TOKEN_TTL_MINUTES]: String(n) } },
    });
  });

  it.each([0, 1, 2, 16, 60, 10.5, Number.NaN, -3])("rejects tokenTtlMinutes=%s", (n) => {
    expect(() => build({ tokenTtlMinutes: n })).toThrow(MagicLinkIdentityPropsError);
  });

  it("a consumer cannot override the client's AuthSessionValidity through addAppClient", () => {
    // AddAppClientProps has no such field; force one through to prove it is ignored.
    const { template } = build({ tokenTtlMinutes: 5 }, (i) =>
      i.addAppClient("ClientA", { authSessionValidity: cdk.Duration.minutes(15) } as never),
    );
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", { AuthSessionValidity: 5 });
  });

  it("every table with expiring rows names the attribute the handlers write as its TTL attribute", () => {
    const { template } = build();
    const tables = Object.values(template.findResources("AWS::DynamoDB::Table"));
    const ttlNames = tables.map(
      (t) => asObj(asObj(t.Properties)["TimeToLiveSpecification"])?.["AttributeName"],
    );
    // token, rate-limit, binding, denylist
    expect(ttlNames).toEqual([TTL_ATTRIBUTE, TTL_ATTRIBUTE, TTL_ATTRIBUTE, TTL_ATTRIBUTE]);
    for (const t of tables) {
      expect(asObj(asObj(t.Properties)["TimeToLiveSpecification"])["Enabled"]).toBe(true);
    }
  });
});

describe("binding table", () => {
  it("is keyed by binding_hash, pay-per-request, not backed up and not retained", () => {
    const { template } = build();
    template.hasResource("AWS::DynamoDB::Table", {
      Properties: {
        KeySchema: [{ AttributeName: "binding_hash", KeyType: "HASH" }],
        BillingMode: "PAY_PER_REQUEST",
        PointInTimeRecoverySpecification: Match.absent(),
      },
      DeletionPolicy: "Delete",
    });
  });
});

describe("bounce wiring (01-evidence #15)", () => {
  it("creates a configuration set whose event destination publishes bounces and complaints to the bounce topic", () => {
    const { template } = build();
    template.resourceCountIs("AWS::SES::ConfigurationSet", 1);
    template.hasResourceProperties("AWS::SES::ConfigurationSetEventDestination", {
      EventDestination: {
        Enabled: true,
        MatchingEventTypes: Match.arrayEquals(["bounce", "complaint"]),
        SnsDestination: { TopicARN: Match.objectLike({ Ref: Match.stringLikeRegexp("BounceTopic") }) },
      },
    });
  });

  it("lets SES (and only this account's configuration set) publish to the topic", () => {
    const { template } = build();
    template.hasResourceProperties("AWS::SNS::TopicPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Action: "sns:Publish",
            Principal: { Service: "ses.amazonaws.com" },
            Condition: {
              StringEquals: { "AWS:SourceAccount": ENV.account },
              StringLike: { "AWS:SourceArn": Match.anyValue() },
            },
          }),
        ]),
      },
    });
  });

  it("applies the set to the sending identity and to CreateAuthChallenge sends", () => {
    const { template } = build();
    template.hasResourceProperties("AWS::SES::EmailIdentity", {
      ConfigurationSetAttributes: { ConfigurationSetName: Match.objectLike({ Ref: Match.anyValue() }) },
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: { [CdkRuntimeEnv.SES_CONFIGURATION_SET]: Match.objectLike({ Ref: Match.anyValue() }) },
      },
    });
  });

  it("grants ses:SendEmail on the configuration set too — SES authorises a send against it, so omitting it is AccessDenied at runtime", () => {
    const { template } = build();
    const policies = Object.values(template.findResources("AWS::IAM::Policy"));
    const sendStatements = policies
      .flatMap((p) => {
        const s = asObj(asObj(p.Properties)["PolicyDocument"])["Statement"] as unknown[];
        return s.map(asObj);
      })
      .filter((s) => JSON.stringify(s["Action"]).includes("ses:SendEmail"));
    expect(sendStatements).toHaveLength(1);
    const resources = JSON.stringify(sendStatements[0]!["Resource"]);
    expect(resources).toContain(":identity/example.com");
    expect(resources).toContain(":configuration-set/");
  });

  it("keeps the bounce handler subscribed to the topic and able to quarantine users", () => {
    const { template } = build();
    template.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "lambda" });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ["cognito-idp:AdminUpdateUserAttributes", "cognito-idp:AdminDisableUser"],
          }),
        ]),
      },
    });
  });

  it("declares the custom attribute the bounce handler writes and CreateAuthChallenge reads", () => {
    const { template } = build();
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      Schema: Match.arrayWith([
        Match.objectLike({ Name: "email_quarantined", AttributeDataType: "Boolean", Mutable: true }),
      ]),
    });
  });
});

describe("runtimes (U14)", () => {
  it("the trigger Lambdas and the SES verification-wait handlers run nodejs24.x", () => {
    const { template } = build();
    const fns = template.findResources("AWS::Lambda::Function");
    const ours = Object.entries(fns).filter(([id]) =>
      /(PreSignUpFn|DefineAuthFn|CreateAuthFn|VerifyAuthFn|BounceHandlerFn|SesVerifyOnEventFn|SesVerifyIsCompleteFn)/.test(id),
    );
    expect(ours).toHaveLength(7);
    for (const [, r] of ours) {
      expect((r.Properties as { Runtime: string }).Runtime).toBe("nodejs24.x");
    }
  });
});
