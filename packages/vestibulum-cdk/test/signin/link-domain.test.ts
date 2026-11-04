/**
 * The mailed link's host (found live): CreateAuthChallenge builds
 * `https://<linkDomain>/login/callback#…`. If that host is not the site that
 * serves /login/callback, every link is dead. The identity exposes the host it
 * will use and the site refuses to synth against a different one.
 */

import * as fs from "node:fs";

import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as s3 from "aws-cdk-lib/aws-s3";
import { afterAll, describe, expect, it } from "vitest";

import { RuntimeEnv } from "../../lib/_internal/runtime-env.js";
import { EdgeResources } from "../../lib/edge-resources/index.js";
import { MagicLinkAuthSite } from "../../lib/magic-link-auth-site/index.js";
import { MagicLinkIdentity, type MagicLinkIdentityProps } from "../../lib/magic-link-identity/index.js";
import { MOCK_BUNDLE_MANIFEST, makeMockPackageRoot } from "../fixtures/mock-bundle-manifest.js";
import { MockIdentity } from "../fixtures/mock-identity.js";

const tmpRoots: string[] = [];
afterAll(() => {
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

function identityTemplate(extra: Partial<MagicLinkIdentityProps> = {}) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "S", { env: { account: "123456789012", region: "eu-west-1" } });
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
  return { identity, template: Template.fromStack(stack) };
}

function createDomainEnv(template: Template): unknown {
  const fns = template.findResources("AWS::Lambda::Function");
  const create = Object.values(fns).find((f) =>
    JSON.stringify(f).includes("CreateAuth"),
  ) as { Properties: { Environment: { Variables: Record<string, unknown> } } } | undefined;
  return create?.Properties.Environment.Variables[RuntimeEnv.DOMAIN];
}

function site(identity: MockIdentity, domain: string) {
  const root = makeMockPackageRoot();
  tmpRoots.push(root);
  const stack = cdk.Stack.of(identity);
  const zone = route53.HostedZone.fromHostedZoneAttributes(stack, "SiteZone", {
    hostedZoneId: "Z123456789EXAMPLE",
    zoneName: "example.com",
  });
  const edge = new EdgeResources(stack, "Edge", { domain, hostedZone: zone });
  return new MagicLinkAuthSite(stack, "Site", {
    domain,
    origin: origins.S3BucketOrigin.withOriginAccessControl(
      new s3.Bucket(stack, "OriginBucket") as unknown as s3.IBucket,
    ),
    edge,
    identity,
    _packageRoot: root,
    _bundleManifest: MOCK_BUNDLE_MANIFEST,
  });
}

function siteStack() {
  const app = new cdk.App();
  return new cdk.Stack(app, "Site", {
    env: { account: "123456789012", region: "us-east-1" },
    crossRegionReferences: true,
  });
}

describe("MagicLinkIdentity linkDomain", () => {
  it("defaults to the sender's domain, and Create builds links from it", () => {
    const { identity, template } = identityTemplate();
    expect(identity.linkDomain).toBe("example.com");
    expect(createDomainEnv(template)).toBe("example.com");
  });

  it("follows linkDomain when set", () => {
    const { identity, template } = identityTemplate({ linkDomain: "app.example.com" });
    expect(identity.linkDomain).toBe("app.example.com");
    expect(createDomainEnv(template)).toBe("app.example.com");
  });

  it.each(["https://app.example.com", "app.example.com/login", "App.Example.com", "app.example.com:443", ""])(
    "rejects linkDomain %j",
    (bad) => {
      expect(() => identityTemplate({ linkDomain: bad })).toThrow(/linkDomain/);
    },
  );
});

describe("MagicLinkAuthSite refuses an identity whose links point elsewhere", () => {
  it("throws when the identity's linkDomain differs from the site domain", () => {
    const stack = siteStack();
    const identity = new MockIdentity(stack, "Identity", { linkDomain: "example.com" });
    expect(() => site(identity, "app.example.com")).toThrow(/linkDomain.*must equal the site domain/);
  });

  it("synthesises when they match", () => {
    const stack = siteStack();
    const identity = new MockIdentity(stack, "Identity", { linkDomain: "app.example.com" });
    expect(() => site(identity, "app.example.com")).not.toThrow();
  });

  it("does not check a hand-rolled identity that does not declare linkDomain", () => {
    const stack = siteStack();
    const identity = new MockIdentity(stack, "Identity");
    expect(() => site(identity, "app.example.com")).not.toThrow();
  });
});
