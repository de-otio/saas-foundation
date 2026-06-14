import { describe, it, expect } from "vitest";
import {
  detectPreTokenEventVersion,
  parseFederatedGroups,
  parseIdentityFromUserAttributes,
  type PreTokenGenerationV1Event,
  type PreTokenGenerationV2Event,
} from "../../src/lambda/cognito-events.js";

function v1Event(overrides: Partial<PreTokenGenerationV1Event> = {}): PreTokenGenerationV1Event {
  return {
    version: "1",
    region: "eu-central-1",
    userPoolId: "eu-central-1_test",
    triggerSource: "TokenGeneration_Authentication",
    userName: "user-1",
    callerContext: { awsSdkVersion: "1", clientId: "client-1" },
    request: {
      userAttributes: {},
      groupConfiguration: {},
    },
    response: {},
    ...overrides,
  };
}

function v2Event(overrides: Partial<PreTokenGenerationV2Event> = {}): PreTokenGenerationV2Event {
  return {
    version: "2",
    region: "eu-central-1",
    userPoolId: "eu-central-1_test",
    triggerSource: "TokenGeneration_Authentication",
    userName: "user-1",
    callerContext: { awsSdkVersion: "1", clientId: "client-1" },
    request: {
      userAttributes: {},
      groupConfiguration: {},
      scopes: ["aws.cognito.signin.user.admin"],
    },
    response: { claimsAndScopeOverrideDetails: {} },
    ...overrides,
  };
}

describe("detectPreTokenEventVersion", () => {
  it("returns v2 when response carries claimsAndScopeOverrideDetails", () => {
    const event = v2Event();
    expect(detectPreTokenEventVersion(event)).toBe("v2");
  });

  it("returns v2 when request carries scopes even without response marker", () => {
    const event = v2Event({ response: {} });
    expect(detectPreTokenEventVersion(event)).toBe("v2");
  });

  it("returns v1 when neither V2 marker is present", () => {
    expect(detectPreTokenEventVersion(v1Event())).toBe("v1");
  });

  it("does not trust the unreliable version string field", () => {
    // Even if version says '2', without the structural markers we
    // treat it as V1.
    const event = v1Event({ version: "2" });
    expect(detectPreTokenEventVersion(event)).toBe("v1");
  });
});

describe("parseIdentityFromUserAttributes", () => {
  it("returns cognito kind when identities attribute is absent", () => {
    expect(parseIdentityFromUserAttributes({})).toEqual({ kind: "cognito" });
  });

  it("returns cognito kind on empty string", () => {
    expect(parseIdentityFromUserAttributes({ identities: "" })).toEqual({
      kind: "cognito",
    });
  });

  it("returns cognito kind when JSON is malformed", () => {
    expect(parseIdentityFromUserAttributes({ identities: "not-json" })).toEqual({
      kind: "cognito",
    });
  });

  it("returns cognito kind when identities array is empty", () => {
    expect(parseIdentityFromUserAttributes({ identities: "[]" })).toEqual({
      kind: "cognito",
    });
  });

  it("returns federated kind for an OIDC provider", () => {
    const identities = JSON.stringify([{ providerName: "tenant-acme", providerType: "OIDC" }]);
    expect(parseIdentityFromUserAttributes({ identities })).toEqual({
      kind: "federated",
      providerName: "tenant-acme",
      providerType: "OIDC",
    });
  });

  it("returns federated kind for a SAML provider", () => {
    const identities = JSON.stringify([{ providerName: "tenant-corp", providerType: "SAML" }]);
    expect(parseIdentityFromUserAttributes({ identities })).toEqual({
      kind: "federated",
      providerName: "tenant-corp",
      providerType: "SAML",
    });
  });

  it("coerces unknown providerType to OIDC", () => {
    const identities = JSON.stringify([
      { providerName: "facebook-provider", providerType: "Facebook" },
    ]);
    expect(parseIdentityFromUserAttributes({ identities })).toEqual({
      kind: "federated",
      providerName: "facebook-provider",
      providerType: "OIDC",
    });
  });

  it("returns cognito kind when providerName is missing", () => {
    const identities = JSON.stringify([{ providerType: "OIDC" }]);
    expect(parseIdentityFromUserAttributes({ identities })).toEqual({
      kind: "cognito",
    });
  });
});

describe("parseFederatedGroups", () => {
  it("returns empty array when attribute is absent", () => {
    expect(parseFederatedGroups({})).toEqual([]);
  });

  it("returns empty array when attribute is empty", () => {
    expect(parseFederatedGroups({ "custom:idpGroups": "" })).toEqual([]);
  });

  it("splits comma-separated groups", () => {
    expect(parseFederatedGroups({ "custom:idpGroups": "admins,users,editors" })).toEqual([
      "admins",
      "users",
      "editors",
    ]);
  });

  it("splits semicolon-separated groups", () => {
    expect(parseFederatedGroups({ "custom:idpGroups": "admins;users" })).toEqual([
      "admins",
      "users",
    ]);
  });

  it("trims whitespace around group names", () => {
    expect(parseFederatedGroups({ "custom:idpGroups": " admins , users " })).toEqual([
      "admins",
      "users",
    ]);
  });

  it("drops empty segments", () => {
    expect(parseFederatedGroups({ "custom:idpGroups": "admins,,users" })).toEqual([
      "admins",
      "users",
    ]);
  });
});
