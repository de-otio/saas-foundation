import { describe, it, expect } from "vitest";
import {
  OIDC_PROFILES,
  oidcProfileAuth0,
  oidcProfileEntra,
  oidcProfileGeneric,
  oidcProfileGoogleWorkspace,
  oidcProfileOkta,
} from "../../src/profiles/oidc.js";

describe("OIDC profiles", () => {
  describe("shape", () => {
    it.each([
      ["generic", oidcProfileGeneric],
      ["entra", oidcProfileEntra],
      ["okta", oidcProfileOkta],
      ["auth0", oidcProfileAuth0],
      ["google", oidcProfileGoogleWorkspace],
    ])("%s is frozen", (_name, profile) => {
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.scopes)).toBe(true);
      expect(Object.isFrozen(profile.attributeMapping)).toBe(true);
    });

    it.each([
      ["generic", oidcProfileGeneric],
      ["entra", oidcProfileEntra],
      ["okta", oidcProfileOkta],
      ["auth0", oidcProfileAuth0],
      ["google", oidcProfileGoogleWorkspace],
    ])("%s includes openid scope", (_name, profile) => {
      expect(profile.scopes).toContain("openid");
    });

    it.each([
      ["generic", oidcProfileGeneric],
      ["entra", oidcProfileEntra],
      ["okta", oidcProfileOkta],
      ["auth0", oidcProfileAuth0],
      ["google", oidcProfileGoogleWorkspace],
    ])("%s maps email to email claim", (_name, profile) => {
      expect(profile.attributeMapping["email"]).toBe("email");
    });
  });

  describe("generic", () => {
    it("maps idpGroups to the conventional groups claim", () => {
      expect(oidcProfileGeneric.attributeMapping["custom:idpGroups"]).toBe("groups");
    });

    it("requests email and profile scopes", () => {
      expect(oidcProfileGeneric.scopes).toEqual(["openid", "email", "profile"]);
    });
  });

  describe("entra", () => {
    it("maps idpGroups to the Entra roles claim, not groups", () => {
      expect(oidcProfileEntra.attributeMapping["custom:idpGroups"]).toBe("roles");
    });

    it("has the entra-tenant-id issuer normalisation hint", () => {
      expect(oidcProfileEntra.issuerNormalisation).toBe("entra-tenant-id");
    });
  });

  describe("okta", () => {
    it("includes the groups scope explicitly (Okta requires it)", () => {
      expect(oidcProfileOkta.scopes).toContain("groups");
    });
  });

  describe("auth0", () => {
    it("maps idpGroups to a namespaced claim (Auth0 strips non-namespaced)", () => {
      expect(oidcProfileAuth0.attributeMapping["custom:idpGroups"]).toMatch(/^https?:\/\//);
    });
  });

  describe("google", () => {
    it("maps hostedDomain to the hd claim", () => {
      expect(oidcProfileGoogleWorkspace.attributeMapping["custom:hostedDomain"]).toBe("hd");
    });

    it("does not map a groups claim (Google does not emit one by default)", () => {
      expect(oidcProfileGoogleWorkspace.attributeMapping).not.toHaveProperty("custom:idpGroups");
    });
  });

  describe("OIDC_PROFILES registry", () => {
    it("is frozen", () => {
      expect(Object.isFrozen(OIDC_PROFILES)).toBe(true);
    });

    it("contains every documented profile", () => {
      expect(OIDC_PROFILES["generic"]).toBe(oidcProfileGeneric);
      expect(OIDC_PROFILES["entra"]).toBe(oidcProfileEntra);
      expect(OIDC_PROFILES["okta"]).toBe(oidcProfileOkta);
      expect(OIDC_PROFILES["auth0"]).toBe(oidcProfileAuth0);
      expect(OIDC_PROFILES["google"]).toBe(oidcProfileGoogleWorkspace);
    });
  });
});
