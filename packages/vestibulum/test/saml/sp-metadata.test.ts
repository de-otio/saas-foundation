import { readFileSync } from "node:fs";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  CognitoIdentityProviderClient,
  GetSigningCertificateCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { buildSpMetadata, wrapPem } from "../../src/saml/sp-metadata.js";

const cognitoMock = mockClient(CognitoIdentityProviderClient);

const fixturePem = readFileSync(
  join(import.meta.dirname, "..", "fixtures", "saml", "test-cert.pem"),
  "utf8",
);
const fixtureBase64 = fixturePem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
// eslint-disable-next-line no-restricted-globals
const fixtureNotAfter = new Date(new X509Certificate(fixturePem).validTo);

describe("wrapPem", () => {
  it("returns PEM unchanged when already armored", () => {
    expect(wrapPem(fixturePem)).toBe(fixturePem.trim());
  });

  it("wraps raw base64 in PEM armor", () => {
    const wrapped = wrapPem(fixtureBase64);
    expect(wrapped).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(wrapped).toMatch(/-----END CERTIFICATE-----/);
    // Cert content is preserved.
    expect(new X509Certificate(wrapped).validTo).toBe(new X509Certificate(fixturePem).validTo);
  });

  it("trims surrounding whitespace", () => {
    expect(wrapPem(`   ${fixturePem}\n  `)).toBe(fixturePem.trim());
  });

  it("wraps cleanly when input has stray whitespace inside the base64", () => {
    const withSpaces = fixtureBase64.match(/.{1,20}/g)!.join("  \n ");
    const wrapped = wrapPem(withSpaces);
    expect(new X509Certificate(wrapped).validTo).toBe(new X509Certificate(fixturePem).validTo);
  });
});

describe("buildSpMetadata", () => {
  beforeEach(() => {
    cognitoMock.reset();
  });

  it("returns the documented SpMetadata shape", async () => {
    cognitoMock.on(GetSigningCertificateCommand).resolves({ Certificate: fixturePem });

    const out = await buildSpMetadata({
      userPoolId: "us-east-1_abcdef123",
      region: "us-east-1",
      hostedUiDomain: "auth.example.com",
    });

    expect(out.entityId).toBe("urn:amazon:cognito:sp:us-east-1_abcdef123");
    expect(out.acsUrl).toBe("https://auth.example.com/saml2/idpresponse");
    expect(out.signingCert.pem).toContain("-----BEGIN CERTIFICATE-----");
    expect(out.signingCert.notAfter).toEqual(fixtureNotAfter);
    expect(out.metadataXml).toContain("<md:EntityDescriptor");
  });

  it("embeds the raw-base64 cert in the metadata XML", async () => {
    cognitoMock.on(GetSigningCertificateCommand).resolves({ Certificate: fixturePem });

    const out = await buildSpMetadata({
      userPoolId: "us-east-1_pool",
      region: "eu-central-1",
      hostedUiDomain: "auth.example.com",
    });

    expect(out.metadataXml).toContain(fixtureBase64);
    // Cert is naked-base64 inside the XML element; no PEM armor.
    expect(out.metadataXml).not.toContain("-----BEGIN CERTIFICATE-----");
  });

  it("uses an injected cognitoClient when provided", async () => {
    cognitoMock.on(GetSigningCertificateCommand).resolves({ Certificate: fixturePem });
    const client = new CognitoIdentityProviderClient({ region: "us-east-1" });

    const out = await buildSpMetadata({
      userPoolId: "us-east-1_pool",
      region: "us-east-1",
      hostedUiDomain: "auth.example.com",
      cognitoClient: client,
    });

    expect(out.entityId).toContain("us-east-1_pool");
  });

  it("declares the canonical SAML 2.0 namespaces and elements", async () => {
    cognitoMock.on(GetSigningCertificateCommand).resolves({ Certificate: fixturePem });

    const out = await buildSpMetadata({
      userPoolId: "us-east-1_pool",
      region: "us-east-1",
      hostedUiDomain: "auth.example.com",
    });

    expect(out.metadataXml).toContain("urn:oasis:names:tc:SAML:2.0:metadata");
    expect(out.metadataXml).toContain("SPSSODescriptor");
    expect(out.metadataXml).toContain('AuthnRequestsSigned="true"');
    expect(out.metadataXml).toContain('WantAssertionsSigned="true"');
    expect(out.metadataXml).toContain("urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST");
    expect(out.metadataXml).toContain("http://www.w3.org/2000/09/xmldsig#");
  });

  it("escapes XML special chars in the entityId / ACS URL", async () => {
    cognitoMock.on(GetSigningCertificateCommand).resolves({ Certificate: fixturePem });

    const out = await buildSpMetadata({
      userPoolId: "us-east-1_pool",
      region: "us-east-1",
      // Domain with characters that need escaping if echoed
      // verbatim -- defensive, even though Cognito would reject
      // an invalid Hosted UI domain upstream.
      hostedUiDomain: "auth&example.com",
    });

    expect(out.metadataXml).toContain("auth&amp;example.com");
    // The raw ampersand never appears outside the escape.
    expect(out.metadataXml).not.toMatch(/auth&example/);
  });

  it("throws if Cognito returns no certificate", async () => {
    cognitoMock.on(GetSigningCertificateCommand).resolves({});

    await expect(
      buildSpMetadata({
        userPoolId: "us-east-1_empty",
        region: "us-east-1",
        hostedUiDomain: "auth.example.com",
      }),
    ).rejects.toThrow(/no certificate/i);
  });

  it("throws on empty-string Certificate field", async () => {
    cognitoMock.on(GetSigningCertificateCommand).resolves({ Certificate: "" });

    await expect(
      buildSpMetadata({
        userPoolId: "us-east-1_empty",
        region: "us-east-1",
        hostedUiDomain: "auth.example.com",
      }),
    ).rejects.toThrow(/no certificate/i);
  });

  it("wraps a raw-base64 certificate without PEM armor", async () => {
    cognitoMock.on(GetSigningCertificateCommand).resolves({ Certificate: fixtureBase64 });

    const out = await buildSpMetadata({
      userPoolId: "us-east-1_pool",
      region: "us-east-1",
      hostedUiDomain: "auth.example.com",
    });

    // The signingCert.pem ends up PEM-wrapped regardless of
    // the input shape.
    expect(out.signingCert.pem).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(new X509Certificate(out.signingCert.pem).validTo).toBe(
      new X509Certificate(fixturePem).validTo,
    );
  });
});
