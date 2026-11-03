/**
 * MagicLinkIdentity — enrolment mode (dot-notes
 * doc/topics/passwordless-sign-in-aws/02-spec.md):
 *
 *   signin_no_self_signup (I9, U6)   admin-only is the default: the pool allows only administrator-created users,
 *                                    the app client allows only CUSTOM_AUTH + REFRESH_TOKEN, and the Create and
 *                                    Verify triggers may read exactly the pool's users (AdminGetUser)
 *   (trigger <-> pool cycle)         the pool names the triggers, so a trigger's env and role policy must not
 *                                    be something the function itself depends on
 *   (U19)                            IAM-versus-SDK-command agreement for the Create and Verify triggers
 *
 * Synth checks prove the template says the right thing; they cannot prove
 * Cognito accepts it. The live checks (`describe-user-pool` reads back
 * AllowAdminCreateUserOnly, a direct SignUp is refused) are listed in the PR
 * notes and are NOT claimed here.
 */

import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as route53 from "aws-cdk-lib/aws-route53";
import { describe, expect, it } from "vitest";

import {
  MagicLinkIdentity,
  MagicLinkIdentityPropsError,
  type MagicLinkIdentityProps,
} from "../../lib/magic-link-identity/index.js";
import {
  actionsForFunction,
  sdkActionsUsedBy,
  sdkActionsUsedByFile,
  sharedModule,
  statementsForFunction,
} from "./helpers.js";

const ENV = { account: "123456789012", region: "eu-west-1" };

function build(extra: Partial<MagicLinkIdentityProps> = {}) {
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
  identity.addAppClient("Client", {});
  // `Template.fromStack` synthesises, so a dependency cycle throws HERE.
  return { identity, template: Template.fromStack(stack) };
}

const fnId = (t: Template, re: RegExp): string => {
  const ids = Object.keys(t.findResources("AWS::Lambda::Function")).filter((id) => re.test(id));
  if (ids.length !== 1) throw new Error(`expected one function matching ${String(re)}, got ${ids.length}`);
  return ids[0]!;
};
const env = (t: Template, id: string) =>
  (t.findResources("AWS::Lambda::Function")[id]!.Properties as {
    Environment: { Variables: Record<string, unknown> };
  }).Environment.Variables;
const asArray = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

describe("signin_no_self_signup — the pool", () => {
  it("defaults to admin-only: AllowAdminCreateUserOnly is true", () => {
    const { identity, template } = build();
    expect(identity.enrollment).toBe("admin-only");
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
  });

  it("an explicit admin-only is the same", () => {
    const { template } = build({ enrollment: "admin-only" });
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
  });

  it("self-signup (legacy, opt-in) lets users sign themselves up", () => {
    const { identity, template } = build({ enrollment: "self-signup" });
    expect(identity.enrollment).toBe("self-signup");
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
    });
  });

  it.each(["open", "ADMIN-ONLY", "", "none", 3])(
    "rejects an unknown enrollment (%j) at synth time (a JS caller cannot open self-signup by typo)",
    (bad) => {
      expect(() => build({ enrollment: bad as never })).toThrow(MagicLinkIdentityPropsError);
    },
  );

  it("the app client allows only CUSTOM_AUTH and REFRESH_TOKEN_AUTH (no password, no SRP, no admin password flow)", () => {
    for (const enrollment of ["admin-only", "self-signup"] as const) {
      const { template } = build({ enrollment });
      const clients = Object.values(template.findResources("AWS::Cognito::UserPoolClient"));
      expect(clients).toHaveLength(1);
      const flows = (clients[0]!.Properties as { ExplicitAuthFlows: string[] }).ExplicitAuthFlows;
      expect([...flows].sort()).toEqual(["ALLOW_CUSTOM_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]);
    }
  });
});

describe("the Create and Verify triggers — environment", () => {
  it.each(["admin-only", "self-signup"] as const)("%s: both are told the enrolment mode", (enrollment) => {
    const { template } = build({ enrollment });
    for (const re of [/CreateAuthFn/, /VerifyAuthFn/]) {
      expect(env(template, fnId(template, re))["VESTIBULUM_ENROLLMENT"]).toBe(enrollment);
    }
  });

  it("neither trigger's environment references the pool (the pool already references the trigger: a cycle)", () => {
    const { template } = build();
    for (const re of [/CreateAuthFn/, /VerifyAuthFn/, /DefineAuthFn/, /PreSignUpFn/]) {
      const vars = env(template, fnId(template, re));
      expect(JSON.stringify(vars)).not.toContain("Pool");
      expect(vars).not.toHaveProperty("VESTIBULUM_USER_POOL_ID");
    }
  });

  it("the enrolment mode is on the two triggers that decide on it, not on the others", () => {
    const { template } = build();
    for (const re of [/DefineAuthFn/, /PreSignUpFn/, /BounceHandlerFn/]) {
      expect(env(template, fnId(template, re))).not.toHaveProperty("VESTIBULUM_ENROLLMENT");
    }
  });
});

describe("the Create and Verify triggers — allow-list IAM (admin-only)", () => {
  const poolStatements = (t: Template, id: string) =>
    statementsForFunction(t, id).filter((s) => JSON.stringify(s.Action).includes("cognito-idp:"));

  it("each may AdminGetUser on THIS pool and nothing else on Cognito", () => {
    const { template } = build();
    for (const re of [/CreateAuthFn/, /VerifyAuthFn/]) {
      const id = fnId(template, re);
      const stmts = poolStatements(template, id);
      expect(stmts).toHaveLength(1);
      expect(stmts[0]!.Effect).toBe("Allow");
      expect(asArray(stmts[0]!.Action)).toEqual(["cognito-idp:AdminGetUser"]);
      // Scoped to the pool ARN, never *.
      expect(JSON.stringify(stmts[0]!.Resource)).not.toBe('"*"');
      expect(stmts[0]!.Resource).toEqual({ "Fn::GetAtt": [expect.stringMatching(/^Identity.*Pool/), "Arn"] });
    }
  });

  it("neither is granted ListUsers (that lookup is auth-login's)", () => {
    const { template } = build();
    for (const re of [/CreateAuthFn/, /VerifyAuthFn/]) {
      expect(actionsForFunction(template, fnId(template, re)).has("cognito-idp:ListUsers")).toBe(false);
    }
  });

  it("no other trigger is granted AdminGetUser", () => {
    const { template } = build();
    for (const re of [/DefineAuthFn/, /PreSignUpFn/]) {
      expect(actionsForFunction(template, fnId(template, re)).has("cognito-idp:AdminGetUser")).toBe(false);
    }
  });

  it("self-signup: no allow-list, so no AdminGetUser anywhere", () => {
    const { template } = build({ enrollment: "self-signup" });
    expect(JSON.stringify(template.toJSON())).not.toContain("cognito-idp:AdminGetUser");
  });

  it("the grant is a standalone policy attached to the role, which no function depends on", () => {
    const { template } = build();
    const policies = Object.entries(template.findResources("AWS::IAM::Policy")).filter(([, p]) =>
      JSON.stringify(p.Properties).includes("cognito-idp:AdminGetUser"),
    );
    expect(policies).toHaveLength(2);
    for (const [policyId] of policies) {
      expect(policyId).toMatch(/AllowListPolicy/);
      // CDK makes a Lambda function depend on its OWN role's default policy. This
      // one is not that: no function lists it in DependsOn.
      for (const fn of Object.values(template.findResources("AWS::Lambda::Function"))) {
        expect(fn.DependsOn ?? []).not.toContain(policyId);
      }
    }
  });

  it("synthesises with no dependency cycle: the pool names the triggers and the triggers are granted the pool", () => {
    // `build()` already synthesised; assert the two edges that would form the cycle both exist
    // and point the safe way round.
    const { template } = build();
    const pool = Object.values(template.findResources("AWS::Cognito::UserPool"))[0]!;
    const lambdaConfig = (pool.Properties as { LambdaConfig: Record<string, unknown> }).LambdaConfig;
    expect(JSON.stringify(lambdaConfig)).toContain("CreateAuthFn"); // pool -> trigger
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "cognito-idp:AdminGetUser",
            Resource: { "Fn::GetAtt": [Match.stringLikeRegexp("Pool"), "Arn"] },
          }),
        ]),
      },
    }); // policy -> pool, hanging off the role, not the function
  });
});

describe("IAM ↔ SDK command agreement for the triggers (U19)", () => {
  it("each trigger is granted every DynamoDB / SES action its source sends", () => {
    const { template } = build();
    for (const [re, dir] of [
      [/CreateAuthFn/, "create-auth-challenge"],
      [/VerifyAuthFn/, "verify-auth-challenge"],
    ] as const) {
      const granted = actionsForFunction(template, fnId(template, re));
      const used = sdkActionsUsedBy(dir);
      expect(used.size).toBeGreaterThan(0);
      expect([...used].filter((a) => !granted.has(a))).toEqual([]);
    }
  });

  it("the Cognito action the triggers hold is exactly the allow-list adapter's `get` command", () => {
    const { template } = build();
    const adapterGet = [...sdkActionsUsedByFile(sharedModule("allow-list.ts"))].filter((a) =>
      a.endsWith("AdminGetUser"),
    );
    for (const re of [/CreateAuthFn/, /VerifyAuthFn/]) {
      const cognito = [...actionsForFunction(template, fnId(template, re))].filter((a) =>
        a.startsWith("cognito-idp:"),
      );
      expect(cognito).toEqual(adapterGet);
    }
  });

  it("the trigger sources themselves send no Cognito command (it goes through the adapter)", () => {
    for (const dir of ["create-auth-challenge", "verify-auth-challenge"]) {
      expect([...sdkActionsUsedBy(dir)].filter((a) => a.startsWith("cognito-idp:"))).toEqual([]);
    }
  });
});
