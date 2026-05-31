/**
 * SAML SP-metadata generation.
 *
 * Cognito does not expose a "fetch my SP metadata" endpoint —
 * the SP metadata XML is constructed by the admin from
 * documented URL patterns and the pool's current signing
 * certificate. `buildSpMetadata` produces that XML and
 * surfaces the cert's `notAfter` so consumers can build a
 * rotation-due alert.
 *
 * Cognito assigns a new SAML 2.0 signing certificate annually
 * with 10-year validity per cert. IdPs that pin the SP cert
 * as a trust anchor for signed AuthnRequests will need
 * re-pasted metadata at each Cognito rotation. See
 * doc/federation/04-saml.md § SP metadata generation.
 */

import { X509Certificate } from "node:crypto";
import {
  CognitoIdentityProviderClient,
  GetSigningCertificateCommand,
} from "@aws-sdk/client-cognito-identity-provider";

export interface BuildSpMetadataProps {
  /** Cognito user-pool ID (e.g. `us-east-1_abcdef123`). */
  userPoolId: string;
  /** AWS region the pool is in. */
  region: string;
  /**
   * The Hosted UI domain serving `/saml2/idpresponse` for this
   * pool. Either the Cognito-managed form
   * (`{prefix}.auth.{region}.amazoncognito.com`) or a custom
   * domain (e.g. `auth.example.com`). Pass without scheme.
   */
  hostedUiDomain: string;
  /**
   * Injectable for tests; defaults to a new client constructed
   * against `region`.
   */
  cognitoClient?: CognitoIdentityProviderClient;
}

export interface SpMetadata {
  /** SP entity ID. Cognito convention: `urn:amazon:cognito:sp:{pool-id}`. */
  entityId: string;
  /** Assertion Consumer Service URL — the only ACS Cognito accepts. */
  acsUrl: string;
  /** Generated SP-metadata XML, ready to paste into the IdP admin UI. */
  metadataXml: string;
  /** The signing certificate Cognito will use for signed AuthnRequests. */
  signingCert: {
    pem: string;
    notAfter: Date;
  };
}

/**
 * Build SP metadata for a Cognito user pool's SAML SP.
 *
 * Performs one `GetSigningCertificate` call against Cognito;
 * the cert is embedded in the metadata XML and surfaced
 * separately so callers can alert on upcoming expiry.
 */
export async function buildSpMetadata(props: BuildSpMetadataProps): Promise<SpMetadata> {
  const client = props.cognitoClient ?? new CognitoIdentityProviderClient({ region: props.region });

  const response = await client.send(
    new GetSigningCertificateCommand({ UserPoolId: props.userPoolId }),
  );

  const rawCert = response.Certificate;
  if (typeof rawCert !== "string" || rawCert.length === 0) {
    throw new Error(
      `Cognito GetSigningCertificate returned no certificate for pool ${props.userPoolId}`,
    );
  }

  const pem = wrapPem(rawCert);
  const cert = new X509Certificate(pem);
  const notAfter = new Date(cert.validTo);

  const entityId = `urn:amazon:cognito:sp:${props.userPoolId}`;
  const acsUrl = `https://${props.hostedUiDomain}/saml2/idpresponse`;
  const metadataXml = renderSpMetadataXml({
    entityId,
    acsUrl,
    certBase64: extractBase64(pem),
  });

  return {
    entityId,
    acsUrl,
    metadataXml,
    signingCert: { pem, notAfter },
  };
}

/**
 * Wrap raw base64 cert bytes in PEM armor. If the input is
 * already PEM (begins with `-----BEGIN`), returns it
 * unchanged.
 */
export function wrapPem(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("-----BEGIN")) {
    return trimmed;
  }
  // Cognito sometimes returns raw base64 without armor. Wrap.
  const base64 = trimmed.replace(/\s+/g, "");
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 64) {
    lines.push(base64.slice(i, i + 64));
  }
  return ["-----BEGIN CERTIFICATE-----", ...lines, "-----END CERTIFICATE-----"].join("\n");
}

function extractBase64(pem: string): string {
  return pem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
}

interface RenderProps {
  entityId: string;
  acsUrl: string;
  certBase64: string;
}

function renderSpMetadataXml(p: RenderProps): string {
  // Minimal SAML 2.0 SP metadata. The structure follows OASIS
  // SAML 2.0 metadata schema (urn:oasis:names:tc:SAML:2.0:metadata).
  // We declare an SP that supports HTTP-POST ACS only (Cognito's
  // only accepted binding for assertion delivery).
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"`,
    `                     entityID="${escapeXml(p.entityId)}">`,
    `  <md:SPSSODescriptor AuthnRequestsSigned="true"`,
    `                      WantAssertionsSigned="true"`,
    `                      protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">`,
    `    <md:KeyDescriptor use="signing">`,
    `      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">`,
    `        <ds:X509Data>`,
    `          <ds:X509Certificate>${p.certBase64}</ds:X509Certificate>`,
    `        </ds:X509Data>`,
    `      </ds:KeyInfo>`,
    `    </md:KeyDescriptor>`,
    `    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>`,
    `    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"`,
    `                                 Location="${escapeXml(p.acsUrl)}"`,
    `                                 index="0"`,
    `                                 isDefault="true"/>`,
    `  </md:SPSSODescriptor>`,
    `</md:EntityDescriptor>`,
  ].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
