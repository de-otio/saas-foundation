import { describe, it, expect } from "vitest";
import type { Identity } from "../../src/types/identity.js";

describe("Identity type", () => {
  it("accepts the cognito kind", () => {
    const i: Identity = { kind: "cognito" };
    expect(i.kind).toBe("cognito");
  });

  it("accepts the federated kind with OIDC providerType", () => {
    const i: Identity = {
      kind: "federated",
      providerName: "tenant-acme",
      providerType: "OIDC",
    };
    expect(i.kind).toBe("federated");
    if (i.kind === "federated") {
      expect(i.providerType).toBe("OIDC");
    }
  });

  it("accepts the federated kind with SAML providerType", () => {
    const i: Identity = {
      kind: "federated",
      providerName: "tenant-acme",
      providerType: "SAML",
    };
    if (i.kind === "federated") {
      expect(i.providerType).toBe("SAML");
    }
  });
});
