import { describe, it, expect } from "vitest";
import {
  SAML_PROFILES,
  samlProfileAdfs,
  samlProfileEntra,
  samlProfileGeneric,
  samlProfileOktaSaml,
  samlProfileShibboleth,
} from "../../src/profiles/saml.js";

describe("SAML profiles", () => {
  describe("shape", () => {
    it.each([
      ["generic", samlProfileGeneric],
      ["entra", samlProfileEntra],
      ["adfs", samlProfileAdfs],
      ["oktaSaml", samlProfileOktaSaml],
      ["shibboleth", samlProfileShibboleth],
    ])("%s is frozen", (_name, profile) => {
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.attributeMapping)).toBe(true);
    });

    it.each([
      ["generic", samlProfileGeneric],
      ["entra", samlProfileEntra],
      ["adfs", samlProfileAdfs],
      ["oktaSaml", samlProfileOktaSaml],
      ["shibboleth", samlProfileShibboleth],
    ])("%s defines an email mapping", (_name, profile) => {
      expect(profile.attributeMapping["email"]).toBeDefined();
    });

    it.each([
      ["generic", samlProfileGeneric],
      ["entra", samlProfileEntra],
      ["adfs", samlProfileAdfs],
      ["oktaSaml", samlProfileOktaSaml],
      ["shibboleth", samlProfileShibboleth],
    ])("%s defines an idpGroups mapping", (_name, profile) => {
      expect(profile.attributeMapping["custom:idpGroups"]).toBeDefined();
    });
  });

  describe("generic", () => {
    it("uses the schemas.xmlsoap.org email URI", () => {
      expect(samlProfileGeneric.attributeMapping["email"]).toBe(
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
      );
    });
  });

  describe("entra", () => {
    it("maps idpGroups to the Microsoft role claim", () => {
      expect(samlProfileEntra.attributeMapping["custom:idpGroups"]).toBe(
        "http://schemas.microsoft.com/ws/2008/06/identity/claims/role",
      );
    });
  });

  describe("adfs", () => {
    it("maps idpGroups to the schemas.xmlsoap.org Group claim", () => {
      expect(samlProfileAdfs.attributeMapping["custom:idpGroups"]).toBe(
        "http://schemas.xmlsoap.org/claims/Group",
      );
    });
  });

  describe("oktaSaml", () => {
    it("uses Okta user.* naming convention", () => {
      expect(samlProfileOktaSaml.attributeMapping["email"]).toBe("user.email");
      expect(samlProfileOktaSaml.attributeMapping["custom:idpGroups"]).toBe("user.groups");
    });
  });

  describe("shibboleth", () => {
    it("uses LDAP OIDs (eduPerson schema)", () => {
      expect(samlProfileShibboleth.attributeMapping["email"]).toBe(
        "urn:oid:0.9.2342.19200300.100.1.3",
      );
      expect(samlProfileShibboleth.attributeMapping["custom:idpGroups"]).toBe(
        "urn:oid:1.3.6.1.4.1.5923.1.5.1.1",
      );
    });
  });

  describe("SAML_PROFILES registry", () => {
    it("is frozen", () => {
      expect(Object.isFrozen(SAML_PROFILES)).toBe(true);
    });

    it("contains every documented profile", () => {
      expect(SAML_PROFILES["generic"]).toBe(samlProfileGeneric);
      expect(SAML_PROFILES["entra"]).toBe(samlProfileEntra);
      expect(SAML_PROFILES["adfs"]).toBe(samlProfileAdfs);
      expect(SAML_PROFILES["oktaSaml"]).toBe(samlProfileOktaSaml);
      expect(SAML_PROFILES["shibboleth"]).toBe(samlProfileShibboleth);
    });
  });
});
