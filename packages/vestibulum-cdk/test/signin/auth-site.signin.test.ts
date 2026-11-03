/**
 * MagicLinkAuthSite — sign-in wiring invariants (dot-notes
 * doc/topics/passwordless-sign-in-aws/02-spec.md):
 *
 *   disable_ends_sessions / 01-evidence #14   the IAM action granted to auth-signout is the SDK command the code sends
 *   (U19)                                      IAM-versus-SDK-command agreement, both directions, per function
 *   (U21)                                      least privilege: auth-verify no longer holds the token table or denylist
 *   signin_link_bound_to_requesting_browser    the binding cookie actually reaches auth-verify (origin request policy)
 *   (U14)                                      runtimes
 */

import * as fs from "node:fs";

import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EdgeResources } from "../../lib/edge-resources/index.js";
import { MagicLinkAuthSite } from "../../lib/magic-link-auth-site/index.js";
import { MOCK_BUNDLE_MANIFEST, makeMockPackageRoot } from "../fixtures/mock-bundle-manifest.js";
import { MockIdentity } from "../fixtures/mock-identity.js";
import {
  actionsForFunction,
  functionIdByDescription,
  sdkActionsUsedBy,
  statementsForFunction,
} from "./helpers.js";

/** CloudFront managed origin request policy "AllViewerExceptHostHeader". */
const ALL_VIEWER_EXCEPT_HOST = "b689b0a8-53d0-40ab-baf2-68738e2966ac";

const tmpRoots: string[] = [];
let template: Template;

/** Builds a site stack (the real construct, mock identity) and returns its template. */
function buildSite(extra: { signInFloorMs?: number } = {}): Template {
  const root = makeMockPackageRoot();
  tmpRoots.push(root);
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "SigninSite", {
    env: { account: "123456789012", region: "us-east-1" },
    crossRegionReferences: true,
  });
  const identity = new MockIdentity(stack, "Identity");
  const zone = cdk.aws_route53.HostedZone.fromHostedZoneAttributes(stack, "Zone", {
    hostedZoneId: "Z123456789EXAMPLE",
    zoneName: "example.com",
  });
  const edge = new EdgeResources(stack, "Edge", { domain: "app.example.com", hostedZone: zone });
  const bucket = new s3.Bucket(stack, "OriginBucket") as unknown as s3.IBucket;
  new MagicLinkAuthSite(stack, "Site", {
    domain: "app.example.com",
    origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
    edge,
    identity,
    _packageRoot: root,
    _bundleManifest: MOCK_BUNDLE_MANIFEST,
    ...(extra.signInFloorMs !== undefined && { signInFloorMs: extra.signInFloorMs }),
  });
  return Template.fromStack(stack);
}

beforeAll(() => {
  template = buildSite();
});

afterAll(() => {
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

const FUNCTIONS = [
  { name: "auth-verify", dir: "auth-verify" },
  { name: "auth-signout", dir: "auth-signout" },
  { name: "auth-login", dir: "auth-login" },
] as const;

describe("IAM ↔ SDK command agreement (01-evidence #6, #14)", () => {
  describe.each(FUNCTIONS)("$name", ({ name, dir }) => {
    it("is granted every Cognito and DynamoDB action its source sends", () => {
      const granted = actionsForFunction(template, functionIdByDescription(template, `${name} endpoint`));
      const used = sdkActionsUsedBy(dir);
      expect(used.size).toBeGreaterThan(0); // guard: the scan found the commands
      const missing = [...used].filter((a) => !granted.has(a));
      expect(missing).toEqual([]);
    });

    it("is granted no Cognito action its source does not send (no dead or wrong-named grants)", () => {
      const granted = actionsForFunction(template, functionIdByDescription(template, `${name} endpoint`));
      const used = sdkActionsUsedBy(dir);
      const unused = [...granted].filter((a) => a.startsWith("cognito-idp:") && !used.has(a));
      expect(unused).toEqual([]);
    });
  });

  it("auth-signout is granted AdminUserGlobalSignOut and NOT the access-token GlobalSignOut", () => {
    const granted = actionsForFunction(template, functionIdByDescription(template, "auth-signout endpoint"));
    expect(granted.has("cognito-idp:AdminUserGlobalSignOut")).toBe(true);
    expect(granted.has("cognito-idp:GlobalSignOut")).toBe(false);
  });

  it("the signout grant is scoped to the user pool, not *", () => {
    const stmts = statementsForFunction(template, functionIdByDescription(template, "auth-signout endpoint"));
    const s = stmts.find((x) => JSON.stringify(x.Action).includes("AdminUserGlobalSignOut"))!;
    expect(JSON.stringify(s.Resource)).not.toBe('"*"');
    expect(JSON.stringify(s.Resource)).toContain("Arn");
  });
});

describe("least privilege (U21) and the binding table", () => {
  it("auth-verify can only DELETE from the binding table; it holds no token-table or denylist access", () => {
    const id = functionIdByDescription(template, "auth-verify endpoint");
    const ddb = statementsForFunction(template, id).filter((s) =>
      JSON.stringify(s.Action).includes("dynamodb:"),
    );
    const actions = ddb.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(new Set(actions)).toEqual(new Set(["dynamodb:DeleteItem"]));
    const resources = JSON.stringify(ddb.map((s) => s.Resource));
    expect(resources).toContain("BindingTable");
    expect(resources).not.toContain("TokenTable");
    expect(resources).not.toContain("DenylistTable");
  });

  it("auth-login can only PUT binding rows (plus its existing rate-limit table access)", () => {
    const id = functionIdByDescription(template, "auth-login endpoint");
    const binding = statementsForFunction(template, id).filter((s) =>
      JSON.stringify(s.Resource).includes("BindingTable"),
    );
    const actions = binding.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(new Set(actions)).toEqual(new Set(["dynamodb:PutItem"]));
  });

  it("both functions are told the binding table name; auth-login also the lifetime", () => {
    const fns = template.findResources("AWS::Lambda::Function");
    const env = (needle: string) =>
      (fns[functionIdByDescription(template, needle)]!.Properties as {
        Environment: { Variables: Record<string, unknown> };
      }).Environment.Variables;
    expect(env("auth-verify endpoint")).toHaveProperty("VESTIBULUM_BINDING_TABLE");
    expect(env("auth-login endpoint")).toHaveProperty("VESTIBULUM_BINDING_TABLE");
    expect(env("auth-login endpoint")["VESTIBULUM_TOKEN_TTL_MINUTES"]).toBe("10");
  });
});

describe("signin_link_bound_to_requesting_browser — the cookie must reach the endpoints", () => {
  const behaviour = (pattern: string) => {
    const dist = Object.values(template.findResources("AWS::CloudFront::Distribution"))[0]!;
    const cfg = (dist.Properties as { DistributionConfig: { CacheBehaviors: Array<Record<string, unknown>> } })
      .DistributionConfig;
    return cfg.CacheBehaviors.find((b) => b["PathPattern"] === pattern)!;
  };

  it.each(["/auth-login*", "/auth-verify*"])(
    "%s forwards viewer cookies to the origin (and Set-Cookie back) without caching",
    (pattern) => {
      const b = behaviour(pattern);
      expect(b["OriginRequestPolicyId"]).toBe(ALL_VIEWER_EXCEPT_HOST);
      // CachingDisabled managed policy.
      expect(b["CachePolicyId"]).toBe("4135ea2d-6df8-44a3-9df3-4b5a84be39ad");
    },
  );

  it("/auth-verify* allows POST (redemption is a POST)", () => {
    const methods = behaviour("/auth-verify*")["AllowedMethods"] as string[];
    expect(methods).toContain("POST");
  });
});

describe("runtimes (U14)", () => {
  it.each(["auth-verify endpoint", "auth-signout endpoint", "auth-login endpoint"])(
    "%s runs nodejs24.x",
    (needle) => {
      const fns = template.findResources("AWS::Lambda::Function");
      expect(
        (fns[functionIdByDescription(template, needle)]!.Properties as { Runtime: string }).Runtime,
      ).toBe("nodejs24.x");
    },
  );

  it("the Lambda@Edge check-auth function stays on a runtime Lambda@Edge is known to accept (nodejs22.x)", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Handler: "index.handler",
      Code: Match.anyValue(),
    });
  });

  it("no regional function is on a runtime older than nodejs22.x", () => {
    for (const r of Object.values(template.findResources("AWS::Lambda::Function"))) {
      const runtime = (r.Properties as { Runtime?: string }).Runtime;
      if (runtime !== undefined) expect(runtime).not.toMatch(/^nodejs(1\d|20)\./);
    }
  });
});

describe("signin_request_indistinguishable — the response floor is configured, and sized from measurement", () => {
  const loginEnv = (t: Template) =>
    (t.findResources("AWS::Lambda::Function")[functionIdByDescription(t, "auth-login endpoint")]!
      .Properties as { Environment: { Variables: Record<string, unknown> } }).Environment.Variables;

  it("defaults to 2500 ms (live measurement: the eligible path exceeded 1500 ms in a third of requests)", () => {
    expect(loginEnv(template)["VESTIBULUM_SIGNIN_FLOOR_MS"]).toBe("2500");
  });

  it("follows signInFloorMs", () => {
    expect(loginEnv(buildSite({ signInFloorMs: 4000 }))["VESTIBULUM_SIGNIN_FLOOR_MS"]).toBe("4000");
  });

  it.each([0, 499, 6001, 2500.5, Number.NaN, -1])("rejects signInFloorMs=%s", (bad) => {
    expect(() => buildSite({ signInFloorMs: bad })).toThrow(/signInFloorMs/);
  });

  it("the auth-login timeout leaves headroom above the largest allowed floor", () => {
    const fns = template.findResources("AWS::Lambda::Function");
    const timeout = (fns[functionIdByDescription(template, "auth-login endpoint")]!.Properties as {
      Timeout: number;
    }).Timeout;
    expect(timeout * 1000).toBeGreaterThan(6000);
  });
});
