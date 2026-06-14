import { describe, it, expect } from "vitest";
import { App, Aspects, Stack } from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  HostedUiDomainAspect,
  markHostedUiConfig,
  readHostedUiConfig,
  VESTIBULUM_HOSTED_UI_METADATA_TYPE,
} from "../../lib/aspects/hosted-ui-domain-aspect.js";
import { markVestibulumSubtreeRoot } from "../../lib/aspects/subtree-marker.js";

function makeApp(
  federationEnabled: boolean,
  hostedUiDomain?:
    | { kind: "cognito"; prefix: string }
    | { kind: "custom"; domainName: string; acmCertArn: string },
): App {
  const app = new App();
  const stack = new Stack(app, "TestStack", {
    env: { account: "123456789012", region: "eu-west-1" },
  });
  const root = new Construct(stack, "VestibulumRoot");
  markVestibulumSubtreeRoot(root);
  markHostedUiConfig(root, { federationEnabled, hostedUiDomain });
  Aspects.of(app).add(new HostedUiDomainAspect());
  return app;
}

describe("HostedUiDomainAspect", () => {
  it("passes when federation is false and no domain is set", () => {
    const app = makeApp(false, undefined);
    expect(() => app.synth()).not.toThrow();
  });

  it("passes when federation is false and a cognito domain is set", () => {
    const app = makeApp(false, { kind: "cognito", prefix: "my-app-auth" });
    expect(() => app.synth()).not.toThrow();
  });

  it("throws when federation is true and no domain is set", () => {
    const app = makeApp(true, undefined);
    expect(() => app.synth()).toThrow(/hostedUiDomain/);
  });

  it("passes when federation is true and a cognito domain is set", () => {
    const app = makeApp(true, { kind: "cognito", prefix: "my-app-auth" });
    expect(() => app.synth()).not.toThrow();
  });

  it("passes when federation is true and a custom domain is in us-east-1", () => {
    const app = makeApp(true, {
      kind: "custom",
      domainName: "auth.example.com",
      acmCertArn: "arn:aws:acm:us-east-1:123456789012:certificate/abc-123",
    });
    expect(() => app.synth()).not.toThrow();
  });

  it("throws when custom domain has a non-us-east-1 cert", () => {
    const app = makeApp(false, {
      kind: "custom",
      domainName: "auth.example.com",
      acmCertArn: "arn:aws:acm:eu-west-1:123456789012:certificate/abc-123",
    });
    expect(() => app.synth()).toThrow(/us-east-1/);
  });

  it("is inert for constructs outside a Vestibulum subtree", () => {
    const app = new App();
    const stack = new Stack(app, "TestStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    // NOT marking as Vestibulum subtree.
    const root = new Construct(stack, "Root");
    markHostedUiConfig(root, { federationEnabled: true, hostedUiDomain: undefined });
    Aspects.of(app).add(new HostedUiDomainAspect());
    expect(() => app.synth()).not.toThrow();
  });

  describe("markHostedUiConfig / readHostedUiConfig", () => {
    it("round-trips metadata correctly", () => {
      const app = new App();
      const stack = new Stack(app, "TestStack", {
        env: { account: "123456789012", region: "eu-west-1" },
      });
      const root = new Construct(stack, "Root");
      const metadata = {
        federationEnabled: true,
        hostedUiDomain: { kind: "cognito" as const, prefix: "test" },
      };
      markHostedUiConfig(root, metadata);
      const result = readHostedUiConfig(root);
      expect(result).toEqual(metadata);
    });

    it("returns undefined when no metadata is set", () => {
      const app = new App();
      const stack = new Stack(app, "TestStack", {
        env: { account: "123456789012", region: "eu-west-1" },
      });
      const root = new Construct(stack, "Root");
      expect(readHostedUiConfig(root)).toBeUndefined();
    });

    it("stores metadata under the correct type key", () => {
      const app = new App();
      const stack = new Stack(app, "TestStack", {
        env: { account: "123456789012", region: "eu-west-1" },
      });
      const root = new Construct(stack, "Root");
      markHostedUiConfig(root, { federationEnabled: false });
      const entry = root.node.metadata.find((m) => m.type === VESTIBULUM_HOSTED_UI_METADATA_TYPE);
      expect(entry).toBeDefined();
    });
  });
});
