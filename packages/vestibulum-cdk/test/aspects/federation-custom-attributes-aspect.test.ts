import { describe, it, expect } from "vitest";
import { App, Aspects, Stack } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";
import {
  FederationCustomAttributesAspect,
  BASE_CLAIMS_OVERHEAD_BYTES,
  TOKEN_SIZE_WARNING_THRESHOLD_BYTES,
  TOKEN_SIZE_ERROR_THRESHOLD_BYTES,
  TOO_MANY_ATTRIBUTES_WARNING_THRESHOLD,
} from "../../lib/aspects/federation-custom-attributes-aspect.js";
import { markVestibulumSubtreeRoot } from "../../lib/aspects/subtree-marker.js";

function makeStackWithCustomAttrs(
  customAttributes: Record<string, cognito.ICustomAttribute>,
  aspectProps: ConstructorParameters<typeof FederationCustomAttributesAspect>[0],
): App {
  const app = new App();
  const stack = new Stack(app, "TestStack", {
    env: { account: "123456789012", region: "eu-west-1" },
  });
  const root = new Construct(stack, "VestibulumRoot");
  markVestibulumSubtreeRoot(root);

  new cognito.UserPool(root, "Pool", {
    customAttributes,
  });

  Aspects.of(app).add(new FederationCustomAttributesAspect(aspectProps));
  return app;
}

describe("FederationCustomAttributesAspect", () => {
  describe("constants", () => {
    it("BASE_CLAIMS_OVERHEAD_BYTES is 2560 (raised per S-C3)", () => {
      expect(BASE_CLAIMS_OVERHEAD_BYTES).toBe(2560);
    });

    it("TOKEN_SIZE_WARNING_THRESHOLD_BYTES is 5120", () => {
      expect(TOKEN_SIZE_WARNING_THRESHOLD_BYTES).toBe(5 * 1024);
    });

    it("TOKEN_SIZE_ERROR_THRESHOLD_BYTES is 6144", () => {
      expect(TOKEN_SIZE_ERROR_THRESHOLD_BYTES).toBe(6 * 1024);
    });

    it("TOO_MANY_ATTRIBUTES_WARNING_THRESHOLD is 10", () => {
      expect(TOO_MANY_ATTRIBUTES_WARNING_THRESHOLD).toBe(10);
    });
  });

  describe("federationEnabled: false", () => {
    it("passes with zero custom attributes", () => {
      const app = makeStackWithCustomAttrs({}, { federationEnabled: false });
      expect(() => app.synth()).not.toThrow();
    });

    it("passes with a mutable: false attribute", () => {
      const app = makeStackWithCustomAttrs(
        { tenantId: new cognito.StringAttribute({ mutable: false }) },
        { federationEnabled: false },
      );
      // No error when federation is off.
      expect(() => app.synth()).not.toThrow();
    });
  });

  describe("federationEnabled: true", () => {
    it("throws when a custom attribute has mutable: false (default error severity)", () => {
      const app = makeStackWithCustomAttrs(
        { tenantId: new cognito.StringAttribute({ mutable: false }) },
        { federationEnabled: true },
      );
      expect(() => app.synth()).toThrow(/mutable.*false|Mutable.*false/i);
    });

    it("warns (not throws) for mutable: false when immutableAttributeSeverity: warning", () => {
      const app = makeStackWithCustomAttrs(
        { tenantId: new cognito.StringAttribute({ mutable: false }) },
        { federationEnabled: true, immutableAttributeSeverity: "warning" },
      );
      // Should synthesise without throwing.
      expect(() => app.synth()).not.toThrow();
    });

    it("passes with all-mutable attributes", () => {
      const app = makeStackWithCustomAttrs(
        {
          tenantId: new cognito.StringAttribute({ mutable: true, maxLen: 64 }),
          role: new cognito.StringAttribute({ mutable: true, maxLen: 32 }),
        },
        { federationEnabled: true },
      );
      expect(() => app.synth()).not.toThrow();
    });
  });

  it("is inert outside a Vestibulum subtree", () => {
    const app = new App();
    const stack = new Stack(app, "TestStack", {
      env: { account: "123456789012", region: "eu-west-1" },
    });
    // Pool NOT under a marked root.
    new cognito.UserPool(stack, "Pool", {
      customAttributes: {
        tenantId: new cognito.StringAttribute({ mutable: false }),
      },
    });
    Aspects.of(app).add(new FederationCustomAttributesAspect({ federationEnabled: true }));
    // Should pass — aspect is inert outside Vestibulum subtree.
    expect(() => app.synth()).not.toThrow();
  });
});
