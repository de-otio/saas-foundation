/**
 * Tests for `parseSamlMetadata`.
 *
 * Coverage strategy: the parser is a security-critical surface, so each
 * documented failure mode gets a dedicated test.
 *
 * The signed fixtures are produced by `test/fixtures/saml/build-fixtures.ts`
 * (vitest `globalSetup`); the unsigned/expired/XXE/oversized fixtures are
 * static. See that file for the deterministic key + cert mint.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { Agent } from "undici";

import {
  parseSamlMetadata,
  parseSamlMetadataXml,
  makePinnedLookup,
} from "../../src/discovery/saml-metadata.js";
import { SamlMetadataError } from "../../src/errors.js";

const FIX = path.join(import.meta.dirname, "..", "fixtures", "saml");
const readFixture = (name: string): string => fs.readFileSync(path.join(FIX, name), "utf8");

describe("parseSamlMetadata — kind: xml", () => {
  it("parses well-formed signed metadata with isSigned: true", async () => {
    const xml = readFixture("signed-valid.xml");
    const md = await parseSamlMetadata({ kind: "xml", xml });

    expect(md.isSigned).toBe(true);
    // S-V7: discriminated union — signed metadata reports
    // `signatureStatus.kind === 'signed'`.
    expect(md.signatureStatus.kind).toBe("signed");
    expect(md.entityId).toBe("https://idp.example.com/saml");
    expect(md.ssoEndpoint.binding).toBe("HTTP-Redirect");
    expect(md.ssoEndpoint.location).toBe("https://idp.example.com/sso/redirect");
    expect(md.signingCertificates).toHaveLength(1);
    expect(md.signingCertificates[0]!.pem).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(md.signingCertificates[0]!.notAfter.getUTCFullYear()).toBeGreaterThan(2090);
    expect(md.signingCertificates[0]!.subjectCommonName).toBe("vestibulum-test-idp");
    expect(md.signingCertificates[0]!.fingerprintSha256).toMatch(/^[0-9A-F]{64}$/);
    expect(md.nameIdFormats).toEqual(["urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"]);
    expect(md.validUntil?.toISOString()).toBe("2099-01-01T00:00:00.000Z");
    expect(md.cacheDurationMs).toBe(6 * 60 * 60 * 1000);
  });

  it("parses well-formed unsigned metadata with isSigned: false", async () => {
    const xml = readFixture("unsigned-valid.xml");
    const md = await parseSamlMetadata({ kind: "xml", xml });

    expect(md.isSigned).toBe(false);
    // S-V7: unsigned metadata surfaces as `missing_signature`.
    expect(md.signatureStatus.kind).toBe("missing_signature");
    expect(md.entityId).toBe("https://unsigned.example.com/saml");
    expect(md.signingCertificates.length).toBeGreaterThan(0);
  });

  it("rejects tampered signed metadata (signature mismatch -> isSigned: false)", async () => {
    const xml = readFixture("signed-tampered.xml");
    const md = await parseSamlMetadata({ kind: "xml", xml });
    // Tampered SSO location -> the signed reference's digest no longer
    // matches the canonicalized EntityDescriptor; the parser returns
    // isSigned: false so the manager layer's default-reject path fires.
    expect(md.isSigned).toBe(false);
    // S-V7: tampered signature surfaces as `invalid_signature`,
    // distinct from "no signature at all" (S-V7 discriminated union).
    expect(md.signatureStatus.kind).toBe("invalid_signature");
    expect(md.ssoEndpoint.location).toBe("https://idp.example.com/sso/redirec_");
  });

  it("rejects XML signature wrapping attack (isSigned: false for attacker payload)", async () => {
    const xml = readFixture("signed-wrapped.xml");
    const md = await parseSamlMetadata({ kind: "xml", xml });
    // The parser picks the *first* EntityDescriptor in document order
    // (the attacker payload). The signature exists in the document, but
    // covers a different EntityDescriptor. parseSamlMetadata must mark
    // this as unsigned so the manager refuses it.
    expect(md.isSigned).toBe(false);
    // S-V7: wrapping attack surfaces with its own kind so admin UIs
    // can show the more specific diagnostic ("the metadata you pasted
    // contains a signature, but it doesn't cover the EntityDescriptor
    // we parsed — possible XML signature wrapping attack").
    expect(md.signatureStatus.kind).toBe("wrapping_attack_blocked");
    expect(md.entityId).toBe("https://attacker.example/saml");
  });

  it("throws SamlMetadataError(invalid_xml) on DOCTYPE / XXE input", async () => {
    const xml = readFixture("xxe-laden.xml");
    await expect(parseSamlMetadata({ kind: "xml", xml })).rejects.toMatchObject({
      name: "SamlMetadataError",
      reason: "invalid_xml",
    });
  });

  it("throws SamlMetadataError(too_large) on oversized input", async () => {
    const xml = readFixture("oversized.xml");
    await expect(parseSamlMetadata({ kind: "xml", xml })).rejects.toMatchObject({
      reason: "too_large",
    });
  });

  it("throws SamlMetadataError(expired) when every signing cert is past notAfter", async () => {
    const xml = readFixture("expired.xml");
    await expect(parseSamlMetadata({ kind: "xml", xml })).rejects.toMatchObject({
      reason: "expired",
    });
  });

  it("respects an explicit maxBytes override", async () => {
    const xml = readFixture("signed-valid.xml");
    await expect(parseSamlMetadata({ kind: "xml", xml }, { maxBytes: 16 })).rejects.toMatchObject({
      reason: "too_large",
    });
  });
});

describe("parseSamlMetadataXml — direct-XML helper", () => {
  it("throws SamlMetadataError(invalid_xml) on syntactically broken XML", () => {
    expect(() => parseSamlMetadataXml("<not-saml")).toThrow(SamlMetadataError);
  });

  it("throws SamlMetadataError(invalid_xml) on XML with a parse warning (unclosed element)", () => {
    // xmldom emits warnings for things like `</a>` with no opener; the parser
    // surfaces those as invalid_xml so the manager doesn't accept partially-
    // recovered metadata.
    expect(() => parseSamlMetadataXml("<a></b>")).toThrow(SamlMetadataError);
  });

  it("throws SamlMetadataError(invalid_xml) on XML with a fatal parse error (mismatched quotes)", () => {
    expect(() => parseSamlMetadataXml('<a attr="unterminated>x</a>')).toThrow(SamlMetadataError);
  });

  it("throws SamlMetadataError(invalid_xml) on XML with stray characters after root", () => {
    // Trailing text after the root close-tag triggers xmldom's fatalError
    // handler in some versions; even when it doesn't, the parse simply
    // succeeds but the subsequent validation rejects.
    expect(() => parseSamlMetadataXml("<a/>garbage<b")).toThrow(SamlMetadataError);
  });

  it("throws SamlMetadataError(invalid_xml) on XML with a malformed PI / non-XML payload", () => {
    expect(() => parseSamlMetadataXml("<?xml ??><<<")).toThrow(SamlMetadataError);
  });

  it("throws SamlMetadataError(invalid_xml) when EntityDescriptor is absent", () => {
    const xml = `<?xml version="1.0"?><root xmlns="urn:other"/>`;
    expect(() => parseSamlMetadataXml(xml)).toThrow(/EntityDescriptor/);
  });

  it("throws SamlMetadataError(invalid_xml) on missing entityID", () => {
    const xml = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata">
      <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
        <md:KeyDescriptor use="signing"/>
        <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.com/sso"/>
      </md:IDPSSODescriptor>
    </md:EntityDescriptor>`;
    expect(() => parseSamlMetadataXml(xml)).toThrow(/entityID/);
  });

  it("throws SamlMetadataError(invalid_xml) when IDPSSODescriptor is missing", () => {
    const xml = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="x"/>`;
    expect(() => parseSamlMetadataXml(xml)).toThrow(SamlMetadataError);
  });

  it("throws SamlMetadataError(unsupported_binding) when no HTTP-Redirect / HTTP-POST is present", () => {
    const xml = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="x">
      <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
        <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:SOAP" Location="https://idp.example.com/sso"/>
      </md:IDPSSODescriptor>
    </md:EntityDescriptor>`;
    try {
      parseSamlMetadataXml(xml);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SamlMetadataError);
      expect((err as SamlMetadataError).reason).toBe("unsupported_binding");
    }
  });

  it("throws SamlMetadataError(no_signing_cert) when no usable cert is present", () => {
    const xml = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="x">
      <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
        <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.com/sso"/>
      </md:IDPSSODescriptor>
    </md:EntityDescriptor>`;
    try {
      parseSamlMetadataXml(xml);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SamlMetadataError);
      expect((err as SamlMetadataError).reason).toBe("no_signing_cert");
    }
  });

  it("falls back to HTTP-POST binding when HTTP-Redirect is absent", () => {
    const cert = readFixture("test-cert.pem")
      .replace(/-----[A-Z ]+-----/g, "")
      .replace(/\s+/g, "");
    const xml = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="x">
      <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
        <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
        <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.com/sso/post"/>
      </md:IDPSSODescriptor>
    </md:EntityDescriptor>`;
    const md = parseSamlMetadataXml(xml);
    expect(md.ssoEndpoint.binding).toBe("HTTP-POST");
  });

  it('extracts a KeyDescriptor with use="encryption" into encryptionCertificates only', () => {
    const cert = readFixture("test-cert.pem")
      .replace(/-----[A-Z ]+-----/g, "")
      .replace(/\s+/g, "");
    const xml = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="x">
      <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
        <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
        <md:KeyDescriptor use="encryption"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
        <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso"/>
      </md:IDPSSODescriptor>
    </md:EntityDescriptor>`;
    const md = parseSamlMetadataXml(xml);
    expect(md.signingCertificates).toHaveLength(1);
    expect(md.encryptionCertificates).toHaveLength(1);
  });

  it("treats a KeyDescriptor without a use attribute as both signing and encryption", () => {
    const cert = readFixture("test-cert.pem")
      .replace(/-----[A-Z ]+-----/g, "")
      .replace(/\s+/g, "");
    const xml = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="x">
      <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
        <md:KeyDescriptor><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
        <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso"/>
      </md:IDPSSODescriptor>
    </md:EntityDescriptor>`;
    const md = parseSamlMetadataXml(xml);
    expect(md.signingCertificates).toHaveLength(1);
    expect(md.encryptionCertificates).toHaveLength(1);
  });

  it("skips KeyDescriptor entries with missing or empty X509Certificate text", () => {
    const cert = readFixture("test-cert.pem")
      .replace(/-----[A-Z ]+-----/g, "")
      .replace(/\s+/g, "");
    const xml = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="x">
      <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
        <md:KeyDescriptor use="signing"/>
        <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate></ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
        <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>not-base64-decodable!!!</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
        <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
        <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso"/>
      </md:IDPSSODescriptor>
    </md:EntityDescriptor>`;
    const md = parseSamlMetadataXml(xml);
    expect(md.signingCertificates).toHaveLength(1);
  });

  it("rejects malformed cacheDuration", () => {
    const cert = readFixture("test-cert.pem")
      .replace(/-----[A-Z ]+-----/g, "")
      .replace(/\s+/g, "");
    const xml = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="x" cacheDuration="not-a-duration">
      <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
        <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
        <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso"/>
      </md:IDPSSODescriptor>
    </md:EntityDescriptor>`;
    expect(() => parseSamlMetadataXml(xml)).toThrow(/cacheDuration/);
  });

  it("parses cacheDuration with days, hours, minutes, and fractional seconds", () => {
    const cert = readFixture("test-cert.pem")
      .replace(/-----[A-Z ]+-----/g, "")
      .replace(/\s+/g, "");
    const xml = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="x" cacheDuration="P1DT2H3M4.5S">
      <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
        <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
        <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso"/>
      </md:IDPSSODescriptor>
    </md:EntityDescriptor>`;
    const md = parseSamlMetadataXml(xml);
    // 1d + 2h + 3m + 4.5s = 86_400_000 + 7_200_000 + 180_000 + 4500 ms.
    expect(md.cacheDurationMs).toBe(86_400_000 + 7_200_000 + 180_000 + 4500);
  });

  it("rejects an empty PT0 cacheDuration", () => {
    const cert = readFixture("test-cert.pem")
      .replace(/-----[A-Z ]+-----/g, "")
      .replace(/\s+/g, "");
    const xml = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="x" cacheDuration="PT0S">
      <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
        <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
        <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso"/>
      </md:IDPSSODescriptor>
    </md:EntityDescriptor>`;
    expect(() => parseSamlMetadataXml(xml)).toThrow(/cacheDuration/);
  });

  it("rejects a malformed validUntil", () => {
    const cert = readFixture("test-cert.pem")
      .replace(/-----[A-Z ]+-----/g, "")
      .replace(/\s+/g, "");
    const xml = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="x" validUntil="not-a-date">
      <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
        <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
        <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso"/>
      </md:IDPSSODescriptor>
    </md:EntityDescriptor>`;
    expect(() => parseSamlMetadataXml(xml)).toThrow(/Invalid date/);
  });

  it("extracts supportedAttributes from AttributeAuthorityDescriptor", () => {
    const cert = readFixture("test-cert.pem")
      .replace(/-----[A-Z ]+-----/g, "")
      .replace(/\s+/g, "");
    const xml = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" entityID="x">
      <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
        <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
        <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso"/>
      </md:IDPSSODescriptor>
      <md:AttributeAuthorityDescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
        <saml:Attribute Name="urn:oid:0.9.2342.19200300.100.1.3" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:uri" FriendlyName="mail"/>
        <saml:Attribute Name="urn:oid:2.5.4.42"/>
      </md:AttributeAuthorityDescriptor>
    </md:EntityDescriptor>`;
    const md = parseSamlMetadataXml(xml);
    expect(md.supportedAttributes).toEqual([
      {
        name: "urn:oid:0.9.2342.19200300.100.1.3",
        nameFormat: "urn:oasis:names:tc:SAML:2.0:attrname-format:uri",
        friendlyName: "mail",
      },
      { name: "urn:oid:2.5.4.42" },
    ]);
  });

  it("parses an EntitiesDescriptor root by picking the first inner EntityDescriptor", () => {
    const cert = readFixture("test-cert.pem")
      .replace(/-----[A-Z ]+-----/g, "")
      .replace(/\s+/g, "");
    const xml = `<md:EntitiesDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata">
      <md:EntityDescriptor entityID="https://first.example/saml">
        <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
          <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
          <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://first.example/sso"/>
        </md:IDPSSODescriptor>
      </md:EntityDescriptor>
    </md:EntitiesDescriptor>`;
    const md = parseSamlMetadataXml(xml);
    expect(md.entityId).toBe("https://first.example/saml");
  });

  it("returns isSigned: false when the metadata Signature element is malformed (no SignedInfo / refs)", () => {
    // A direct-child <ds:Signature> with no SignedInfo trips xml-crypto's
    // `loadSignature` error path; the catch in verifyDocumentSignature
    // turns it into "not signed" rather than propagating.
    const cert = readFixture("test-cert.pem")
      .replace(/-----[A-Z ]+-----/g, "")
      .replace(/\s+/g, "");
    const xml = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="x">
      <ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignatureValue>x</ds:SignatureValue></ds:Signature>
      <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
        <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
        <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso"/>
      </md:IDPSSODescriptor>
    </md:EntityDescriptor>`;
    const md = parseSamlMetadataXml(xml);
    expect(md.isSigned).toBe(false);
  });

  it("returns isSigned: false when a Signature is nested inside KeyDescriptor (not the metadata signature)", () => {
    // ds:Signature deep inside the document but NOT a direct child of the
    // EntityDescriptor is not a metadata signature. The parser must not
    // mistakenly treat it as signed metadata.
    const cert = readFixture("test-cert.pem")
      .replace(/-----[A-Z ]+-----/g, "")
      .replace(/\s+/g, "");
    const xml = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="x">
      <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
        <md:KeyDescriptor use="signing">
          <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
            <ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data>
            <ds:Signature><ds:SignedInfo/></ds:Signature>
          </ds:KeyInfo>
        </md:KeyDescriptor>
        <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso"/>
      </md:IDPSSODescriptor>
    </md:EntityDescriptor>`;
    const md = parseSamlMetadataXml(xml);
    expect(md.isSigned).toBe(false);
  });
});

describe("makePinnedLookup — DNS-rebinding TOCTOU defense", () => {
  it("returns the pre-validated IP regardless of the requested hostname", () => {
    return new Promise<void>((resolve) => {
      const lookup = makePinnedLookup("203.0.113.10", 4);
      lookup("attacker.example", {}, (err, address, family) => {
        expect(err).toBeNull();
        expect(address).toBe("203.0.113.10");
        expect(family).toBe(4);
        resolve();
      });
    });
  });
});

describe("parseSamlMetadata — kind: url", () => {
  // For each URL test we build a minimal Response on the fly via a
  // stub fetch + stub resolver. The pinned-dispatcher factory is also
  // stubbed (production would mint an undici Agent -- the dispatcher is
  // never actually used here because the stub fetch ignores it).

  const PUBLIC_IP = "93.184.216.34"; // example.com
  const makeOkResponse = (body: string): Response =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "application/samlmetadata+xml" },
    });

  const stubResolveTo = (ips: string[]) => vi.fn(async () => ips);
  const stubFetch = (resp: Response | (() => Response | Promise<Response>)) =>
    vi.fn(async () => (typeof resp === "function" ? resp() : resp));

  it("fetches and parses metadata over https:// with a stubbed dispatcher", async () => {
    const xml = readFixture("signed-valid.xml");
    const md = await parseSamlMetadata(
      { kind: "url", url: "https://idp.example.com/metadata" },
      {
        resolveHostname: stubResolveTo([PUBLIC_IP]),
        fetchImpl: stubFetch(makeOkResponse(xml)) as unknown as typeof fetch,
        dispatcherFactory: () => undefined,
      },
    );
    expect(md.entityId).toBe("https://idp.example.com/saml");
  });

  it("refuses http:// URLs", async () => {
    await expect(
      parseSamlMetadata(
        { kind: "url", url: "http://idp.example.com/metadata" },
        { resolveHostname: stubResolveTo([PUBLIC_IP]) },
      ),
    ).rejects.toMatchObject({ reason: "ssrf_blocked_destination" });
  });

  it("refuses URLs with embedded credentials", async () => {
    await expect(
      parseSamlMetadata(
        { kind: "url", url: "https://user:pass@idp.example.com/metadata" },
        { resolveHostname: stubResolveTo([PUBLIC_IP]) },
      ),
    ).rejects.toMatchObject({ reason: "ssrf_blocked_destination" });
  });

  it("refuses URLs longer than 2048 chars", async () => {
    const longUrl = "https://idp.example.com/" + "a".repeat(2100);
    await expect(parseSamlMetadata({ kind: "url", url: longUrl })).rejects.toMatchObject({
      reason: "ssrf_blocked_destination",
    });
  });

  it("refuses URLs that cannot be parsed as absolute URLs", async () => {
    await expect(parseSamlMetadata({ kind: "url", url: "not a url" })).rejects.toMatchObject({
      reason: "ssrf_blocked_destination",
    });
  });

  it("refuses URLs whose host resolves to a private IPv4 (RFC 1918)", async () => {
    await expect(
      parseSamlMetadata(
        { kind: "url", url: "https://idp.example.com/metadata" },
        { resolveHostname: stubResolveTo(["10.0.0.5"]) },
      ),
    ).rejects.toMatchObject({ reason: "ssrf_blocked_destination" });
  });

  it("refuses URLs whose host resolves to the IMDS link-local range", async () => {
    await expect(
      parseSamlMetadata(
        { kind: "url", url: "https://idp.example.com/metadata" },
        { resolveHostname: stubResolveTo(["169.254.169.254"]) },
      ),
    ).rejects.toMatchObject({ reason: "ssrf_blocked_destination" });
  });

  it("refuses URLs whose host resolves to an IPv6 loopback / ULA address", async () => {
    await expect(
      parseSamlMetadata(
        { kind: "url", url: "https://idp.example.com/metadata" },
        { resolveHostname: stubResolveTo(["::1"]) },
      ),
    ).rejects.toMatchObject({ reason: "ssrf_blocked_destination" });
  });

  it("refuses URLs whose host resolves to an IPv4-mapped private address", async () => {
    await expect(
      parseSamlMetadata(
        { kind: "url", url: "https://idp.example.com/metadata" },
        { resolveHostname: stubResolveTo(["::ffff:10.0.0.5"]) },
      ),
    ).rejects.toMatchObject({ reason: "ssrf_blocked_destination" });
  });

  it("treats a DNS resolution failure as ssrf_blocked_destination", async () => {
    await expect(
      parseSamlMetadata(
        { kind: "url", url: "https://idp.example.com/metadata" },
        {
          resolveHostname: vi.fn(async () => {
            throw new Error("ENOTFOUND");
          }),
        },
      ),
    ).rejects.toMatchObject({ reason: "ssrf_blocked_destination" });
  });

  it("treats an empty DNS answer as ssrf_blocked_destination", async () => {
    await expect(
      parseSamlMetadata(
        { kind: "url", url: "https://idp.example.com/metadata" },
        { resolveHostname: stubResolveTo([]) },
      ),
    ).rejects.toMatchObject({ reason: "ssrf_blocked_destination" });
  });

  it("rejects 3xx responses (redirect_blocked)", async () => {
    const resp = new Response("", {
      status: 302,
      headers: { location: "https://elsewhere.example/" },
    });
    await expect(
      parseSamlMetadata(
        { kind: "url", url: "https://idp.example.com/metadata" },
        {
          resolveHostname: stubResolveTo([PUBLIC_IP]),
          fetchImpl: stubFetch(resp) as unknown as typeof fetch,
          dispatcherFactory: () => undefined,
        },
      ),
    ).rejects.toMatchObject({ reason: "redirect_blocked" });
  });

  it("rejects non-2xx, non-3xx responses (invalid_xml)", async () => {
    const resp = new Response("not found", { status: 404 });
    await expect(
      parseSamlMetadata(
        { kind: "url", url: "https://idp.example.com/metadata" },
        {
          resolveHostname: stubResolveTo([PUBLIC_IP]),
          fetchImpl: stubFetch(resp) as unknown as typeof fetch,
          dispatcherFactory: () => undefined,
        },
      ),
    ).rejects.toMatchObject({ reason: "invalid_xml" });
  });

  it("rejects responses whose body exceeds maxBytes", async () => {
    const big = "A".repeat(300 * 1024);
    const resp = new Response(big, { status: 200 });
    await expect(
      parseSamlMetadata(
        { kind: "url", url: "https://idp.example.com/metadata" },
        {
          resolveHostname: stubResolveTo([PUBLIC_IP]),
          fetchImpl: stubFetch(resp) as unknown as typeof fetch,
          dispatcherFactory: () => undefined,
        },
      ),
    ).rejects.toMatchObject({ reason: "too_large" });
  });

  it("maps a fetch abort/timeout to ssrf_blocked_destination", async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;
    await expect(
      parseSamlMetadata(
        { kind: "url", url: "https://idp.example.com/metadata" },
        {
          resolveHostname: stubResolveTo([PUBLIC_IP]),
          fetchImpl,
          dispatcherFactory: () => undefined,
          timeoutMs: 10,
        },
      ),
    ).rejects.toMatchObject({ reason: "ssrf_blocked_destination" });
  });

  it("maps a generic fetch failure to ssrf_blocked_destination", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    await expect(
      parseSamlMetadata(
        { kind: "url", url: "https://idp.example.com/metadata" },
        {
          resolveHostname: stubResolveTo([PUBLIC_IP]),
          fetchImpl,
          dispatcherFactory: () => undefined,
        },
      ),
    ).rejects.toMatchObject({ reason: "ssrf_blocked_destination" });
  });

  it("rejects responses with no body", async () => {
    // Mock a Response that returns null on .body.
    const fetchImpl = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        body: null,
      } as unknown as Response;
    }) as unknown as typeof fetch;
    await expect(
      parseSamlMetadata(
        { kind: "url", url: "https://idp.example.com/metadata" },
        {
          resolveHostname: stubResolveTo([PUBLIC_IP]),
          fetchImpl,
          dispatcherFactory: () => undefined,
        },
      ),
    ).rejects.toMatchObject({ reason: "invalid_xml" });
  });

  it("closes the pinned dispatcher when fetch succeeds", async () => {
    const close = vi.fn(async () => undefined);
    const xml = readFixture("signed-valid.xml");
    await parseSamlMetadata(
      { kind: "url", url: "https://idp.example.com/metadata" },
      {
        resolveHostname: stubResolveTo([PUBLIC_IP]),
        fetchImpl: stubFetch(makeOkResponse(xml)) as unknown as typeof fetch,
        dispatcherFactory: () => ({ close }) as unknown as Agent,
      },
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("tolerates a dispatcher whose close() rejects", async () => {
    const close = vi.fn(async () => {
      throw new Error("boom");
    });
    const xml = readFixture("signed-valid.xml");
    await expect(
      parseSamlMetadata(
        { kind: "url", url: "https://idp.example.com/metadata" },
        {
          resolveHostname: stubResolveTo([PUBLIC_IP]),
          fetchImpl: stubFetch(makeOkResponse(xml)) as unknown as typeof fetch,
          dispatcherFactory: () => ({ close }) as unknown as Agent,
        },
      ),
    ).resolves.toBeDefined();
  });

  it("uses the default DNS resolver when no override is supplied (refuses a non-resolvable host)", async () => {
    // A `.invalid` TLD per RFC 2606 is guaranteed not to resolve -- exercises
    // the default `dns.lookup` error path without depending on a real network.
    await expect(
      parseSamlMetadata({
        kind: "url",
        url: "https://nonexistent.invalid/metadata",
      }),
    ).rejects.toMatchObject({ reason: "ssrf_blocked_destination" });
  });

  it("uses the default DNS resolver to refuse `localhost` (resolves to 127.0.0.1)", async () => {
    // `localhost` resolves to 127.0.0.1 / ::1 via the system resolver,
    // which exercises the default-resolver *success* branch (mapping
    // dns.lookup results into the IP array) and the IPv4 loopback refusal.
    await expect(
      parseSamlMetadata({
        kind: "url",
        url: "https://localhost/metadata",
      }),
    ).rejects.toMatchObject({ reason: "ssrf_blocked_destination" });
  });

  it("falls back to the global fetch when no fetchImpl override is supplied", async () => {
    // No fetchImpl, no dispatcherFactory -- but a stubbed resolver pointing
    // at a public-looking IP. The pinned dispatcher will refuse to connect
    // because that IP is unreachable from the test sandbox, but reaching
    // the `options.fetchImpl ?? fetch` coalescing is what we're after.
    await expect(
      parseSamlMetadata(
        { kind: "url", url: "https://idp.example.com/metadata" },
        {
          resolveHostname: stubResolveTo([PUBLIC_IP]),
          // Tight timeout -- we don't want this test to block while undici
          // dials a non-existent destination.
          timeoutMs: 50,
          dispatcherFactory: () => undefined,
        },
      ),
    ).rejects.toMatchObject({ reason: "ssrf_blocked_destination" });
  });

  it("uses the default pinned dispatcher factory and supplies it to fetch", async () => {
    // Don't stub `dispatcherFactory`; the production factory mints an undici
    // Agent. The stub fetch captures the `init.dispatcher` to confirm the
    // dispatcher was attached and the production factory path was taken.
    const xml = readFixture("signed-valid.xml");
    let seenDispatcher: unknown;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit & { dispatcher?: unknown }) => {
      seenDispatcher = init?.dispatcher;
      return new Response(xml, { status: 200 });
    }) as unknown as typeof fetch;
    const md = await parseSamlMetadata(
      { kind: "url", url: "https://idp.example.com/metadata" },
      {
        resolveHostname: stubResolveTo([PUBLIC_IP]),
        fetchImpl,
      },
    );
    expect(md.entityId).toBe("https://idp.example.com/saml");
    expect(seenDispatcher).toBeInstanceOf(Agent);
    // Production code closes the dispatcher in its `finally` block.
  });

  it("uses the default IPv6 family when the resolver returns an IPv6 address", async () => {
    const xml = readFixture("signed-valid.xml");
    // 2606:4700:4700::1111 -- Cloudflare DNS, public IPv6.
    const md = await parseSamlMetadata(
      { kind: "url", url: "https://idp.example.com/metadata" },
      {
        resolveHostname: stubResolveTo(["2606:4700:4700::1111"]),
        fetchImpl: stubFetch(makeOkResponse(xml)) as unknown as typeof fetch,
        dispatcherFactory: (ip, family) => {
          expect(family).toBe(6);
          expect(ip).toBe("2606:4700:4700::1111");
          return undefined;
        },
      },
    );
    expect(md.entityId).toBe("https://idp.example.com/saml");
  });
});
