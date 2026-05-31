import { describe, it, expect } from "vitest";
import { App, Aspects, Stack } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";
import { DisabledAuthFlowsAspect } from "../../lib/aspects/disabled-auth-flows.js";
import { markVestibulumSubtreeRoot } from "../../lib/aspects/subtree-marker.js";

/**
 * Creates a minimal Vestibulum-marked stack with a user pool and one app
 * client. Returns the stack with the aspect applied, ready for
 * `app.synth()`.
 */
function makeStackWithClient(
  authFlows: cognito.AuthFlow,
  generateSecret = false,
  aspectProps: ConstructorParameters<typeof DisabledAuthFlowsAspect>[0] = {},
): App {
  const app = new App();
  const stack = new Stack(app, "TestStack", {
    env: { account: "123456789012", region: "eu-west-1" },
  });
  const root = new Construct(stack, "VestibulumRoot");
  markVestibulumSubtreeRoot(root);

  const pool = new cognito.UserPool(root, "Pool");
  pool.addClient("Client", {
    authFlows,
    generateSecret,
  });

  Aspects.of(app).add(new DisabledAuthFlowsAspect(aspectProps));
  return app;
}

describe("DisabledAuthFlowsAspect", () => {
  it("permits CUSTOM_AUTH + REFRESH_TOKEN only (magic-link-only baseline)", () => {
    const app = makeStackWithClient({
      custom: true,
      userPassword: false,
      adminUserPassword: false,
      userSrp: false,
    });
    // Should synthesise without throwing.
    expect(() => app.synth()).not.toThrow();
  });

  it("throws on ALLOW_USER_PASSWORD_AUTH", () => {
    const app = makeStackWithClient({ custom: true, userPassword: true });
    expect(() => app.synth()).toThrow(/ALLOW_USER_PASSWORD_AUTH/);
  });

  it("throws on ALLOW_ADMIN_USER_PASSWORD_AUTH", () => {
    const app = makeStackWithClient({
      custom: true,
      adminUserPassword: true,
    });
    expect(() => app.synth()).toThrow(/ALLOW_ADMIN_USER_PASSWORD_AUTH/);
  });

  it("throws on ALLOW_USER_SRP_AUTH without allowSrpAuth", () => {
    const app = makeStackWithClient({ custom: true, userSrp: true });
    expect(() => app.synth()).toThrow(/ALLOW_USER_SRP_AUTH/);
  });

  it("permits ALLOW_USER_SRP_AUTH with allowSrpAuth: true", () => {
    const app = makeStackWithClient({ custom: true, userSrp: true }, false, { allowSrpAuth: true });
    expect(() => app.synth()).not.toThrow();
  });

  it("throws on generateSecret: true", () => {
    const app = makeStackWithClient({ custom: true }, true);
    expect(() => app.synth()).toThrow(/GenerateSecret/);
  });

  it("is inert outside a Vestibulum subtree", () => {
    const app = new App();
    const stack = new Stack(app, "TestStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    // Pool NOT under a marked root.
    const pool = new cognito.UserPool(stack, "Pool");
    pool.addClient("Client", {
      authFlows: { userPassword: true },
      generateSecret: true,
    });
    Aspects.of(app).add(new DisabledAuthFlowsAspect());
    // Should pass — aspect is inert outside Vestibulum subtree.
    expect(() => app.synth()).not.toThrow();
  });

  it("exposes federationEnabled on the instance", () => {
    const aspect = new DisabledAuthFlowsAspect({ federationEnabled: true });
    expect(aspect.federationEnabled).toBe(true);
  });
});
