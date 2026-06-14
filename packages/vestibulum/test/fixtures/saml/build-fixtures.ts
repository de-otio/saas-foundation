/**
 * Builds the SAML test-fixture corpus deterministically.
 *
 * Invoked as the vitest `globalSetup` for the package: every
 * `npm test` regenerates the on-disk corpus from a fixed test private
 * key (which is itself committed; rotation is by design — every test
 * run is byte-deterministic given the committed `test-key.pem`).
 *
 * Generated files (in this directory):
 *   - test-key.pem        RSA-2048 PKCS#8 PEM, regenerated only if absent.
 *   - test-cert.pem       self-signed X.509 with 2020→2099 validity.
 *   - expired-cert.pem    self-signed X.509 with 2000→2001 validity.
 *   - signed-valid.xml    metadata with a valid enveloped signature.
 *   - signed-tampered.xml signed-valid with a single byte flipped after signing.
 *   - signed-wrapped.xml  EntitiesDescriptor: attacker EntityDescriptor + the signed one.
 *   - unsigned-valid.xml  well-formed metadata without ds:Signature.
 *   - expired.xml         metadata whose signing cert is past notAfter.
 *   - xxe-laden.xml       DOCTYPE with an external entity declaration.
 *   - oversized.xml       padded to exceed the 256 KiB cap.
 *
 * This file is a build script, not a test — Jest invokes the default
 * export once before any test file. Keep it small; it must not pull in
 * the package under test.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { SignedXml } from "xml-crypto";

const FIX_DIR = import.meta.dirname;

export default async function buildFixtures(): Promise<void> {
  fs.mkdirSync(FIX_DIR, { recursive: true });
  const { privateKey, publicCert } = ensureKeyPair();
  const expiredCert = ensureExpiredCert();

  const certB64 = pemToBase64Block(publicCert);
  const expiredB64 = pemToBase64Block(expiredCert);

  // signed-valid.xml --------------------------------------------------
  const validId = "_valid-entity";
  const validXml = signXml(
    entityDescriptorXml({
      entityId: "https://idp.example.com/saml",
      idAttr: validId,
      certB64,
    }),
    validId,
    privateKey,
    publicCert,
  );
  fs.writeFileSync(path.join(FIX_DIR, "signed-valid.xml"), validXml);

  // signed-tampered.xml -----------------------------------------------
  // Flip a byte inside the *signed* EntityDescriptor (SSO Location) after
  // signing; any change invalidates the SHA-256 digest of the reference.
  const tampered = validXml.replace("idp.example.com/sso/redirect", "idp.example.com/sso/redirec_");
  fs.writeFileSync(path.join(FIX_DIR, "signed-tampered.xml"), tampered);

  // signed-wrapped.xml ------------------------------------------------
  // Wrap the signed EntityDescriptor inside an outer EntitiesDescriptor
  // and prepend a sibling EntityDescriptor (the attacker payload). A naive
  // parser that picks "first EntityDescriptor in document order" would
  // hand the attacker's entityID to the manager; our parser refuses
  // because the signature does not cover the attacker's element.
  const wrappedInner = entityDescriptorXml({
    entityId: "https://attacker.example/saml",
    idAttr: "_attacker-entity",
    certB64,
  });
  const wrappedXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<md:EntitiesDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata">\n` +
    `${wrappedInner}\n` +
    `${stripXmlDecl(validXml)}\n` +
    `</md:EntitiesDescriptor>\n`;
  fs.writeFileSync(path.join(FIX_DIR, "signed-wrapped.xml"), wrappedXml);

  // unsigned-valid.xml ------------------------------------------------
  const unsignedXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    entityDescriptorXml({
      entityId: "https://unsigned.example.com/saml",
      idAttr: "_unsigned-entity",
      certB64,
    }) +
    "\n";
  fs.writeFileSync(path.join(FIX_DIR, "unsigned-valid.xml"), unsignedXml);

  // expired.xml -------------------------------------------------------
  const expiredXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    entityDescriptorXml({
      entityId: "https://expired.example.com/saml",
      idAttr: "_expired-entity",
      certB64: expiredB64,
    }) +
    "\n";
  fs.writeFileSync(path.join(FIX_DIR, "expired.xml"), expiredXml);

  // xxe-laden.xml -----------------------------------------------------
  const xxeXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE EntityDescriptor [\n` +
    `  <!ELEMENT EntityDescriptor ANY>\n` +
    `  <!ENTITY xxe SYSTEM "file:///etc/passwd">\n` +
    `]>\n` +
    `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="&xxe;">\n` +
    `  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">\n` +
    `    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.com/sso"/>\n` +
    `  </md:IDPSSODescriptor>\n` +
    `</md:EntityDescriptor>\n`;
  fs.writeFileSync(path.join(FIX_DIR, "xxe-laden.xml"), xxeXml);

  // oversized.xml -----------------------------------------------------
  const padding = "<md:NameIDFormat>urn:padding:abcdefghij</md:NameIDFormat>\n";
  // 257 KiB to comfortably exceed the 256 KiB cap.
  // eslint-disable-next-line no-restricted-globals
  const padded = padding.repeat(Math.ceil((257 * 1024) / padding.length));
  const oversizedXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://oversized.example/saml">\n` +
    `  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">\n` +
    `    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.com/sso"/>\n` +
    `  </md:IDPSSODescriptor>\n` +
    `${padded}` +
    `</md:EntityDescriptor>\n`;
  fs.writeFileSync(path.join(FIX_DIR, "oversized.xml"), oversizedXml);
}

// ---------------------------------------------------------------------
// Cert + key minting
// ---------------------------------------------------------------------

function ensureKeyPair(): { privateKey: string; publicCert: string } {
  const keyPath = path.join(FIX_DIR, "test-key.pem");
  const certPath = path.join(FIX_DIR, "test-cert.pem");
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return {
      privateKey: fs.readFileSync(keyPath, "utf8"),
      publicCert: fs.readFileSync(certPath, "utf8"),
    };
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const cert = selfSignedCert(privateKey, publicKey, {
    notBefore: "2020-01-01T00:00:00Z",
    notAfter: "2099-01-01T00:00:00Z",
    cn: "vestibulum-test-idp",
  });
  fs.writeFileSync(keyPath, privateKeyPem);
  fs.writeFileSync(certPath, cert);
  return { privateKey: privateKeyPem, publicCert: cert };
}

function ensureExpiredCert(): string {
  const p = path.join(FIX_DIR, "expired-cert.pem");
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  const privateKey = crypto.createPrivateKey(
    fs.readFileSync(path.join(FIX_DIR, "test-key.pem"), "utf8"),
  );
  const publicKey = crypto.createPublicKey(privateKey);
  const cert = selfSignedCert(privateKey, publicKey, {
    notBefore: "2000-01-01T00:00:00Z",
    notAfter: "2001-01-01T00:00:00Z",
    cn: "vestibulum-test-expired",
  });
  fs.writeFileSync(p, cert);
  return cert;
}

// ---------------------------------------------------------------------
// SAML metadata template + signing
// ---------------------------------------------------------------------

function entityDescriptorXml(args: { entityId: string; idAttr: string; certB64: string }): string {
  const { entityId, idAttr, certB64 } = args;
  return (
    `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}" ID="${idAttr}" validUntil="2099-01-01T00:00:00Z" cacheDuration="PT6H">\n` +
    `  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">\n` +
    `    <md:KeyDescriptor use="signing">\n` +
    `      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">\n` +
    `        <ds:X509Data>\n` +
    `          <ds:X509Certificate>${certB64}</ds:X509Certificate>\n` +
    `        </ds:X509Data>\n` +
    `      </ds:KeyInfo>\n` +
    `    </md:KeyDescriptor>\n` +
    `    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>\n` +
    `    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso/redirect"/>\n` +
    `    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.com/sso/post"/>\n` +
    `  </md:IDPSSODescriptor>\n` +
    `</md:EntityDescriptor>`
  );
}

function signXml(
  xmlString: string,
  idAttr: string,
  privateKey: string,
  publicCert: string,
): string {
  const sig = new SignedXml({
    privateKey,
    publicCert,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    getKeyInfoContent: ({ publicCert: pc }: { publicCert?: crypto.KeyLike }) => {
      // pc is a KeyLike (string | Buffer | KeyObject); the fixture always
      // passes a PEM string or Buffer. Narrow explicitly so we never call
      // the default Object stringification on a KeyObject.
      const pem = typeof pc === "string" ? pc : Buffer.isBuffer(pc) ? pc.toString("utf8") : "";
      const b64 = pemToBase64Block(pem);
      return `<X509Data><X509Certificate>${b64}</X509Certificate></X509Data>`;
    },
  });
  sig.addReference({
    xpath: `//*[local-name(.)='EntityDescriptor' and @ID='${idAttr}']`,
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  sig.computeSignature(xmlString, {
    location: {
      reference: `//*[local-name(.)='EntityDescriptor' and @ID='${idAttr}']`,
      action: "prepend",
    },
  });
  return sig.getSignedXml();
}

function pemToBase64Block(pem: string): string {
  return pem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
}

function stripXmlDecl(xml: string): string {
  return xml.replace(/^\s*<\?xml[^?]*\?>\s*/, "");
}

// ---------------------------------------------------------------------
// Minimal self-signed-cert minting (pure-Node, no openssl shell-out)
// ---------------------------------------------------------------------

function selfSignedCert(
  privKey: crypto.KeyObject,
  pubKey: crypto.KeyObject,
  opts: { notBefore: string; notAfter: string; cn: string },
): string {
  const tbs = buildTbs(pubKey, opts);
  const sigAlgOid = encodeOid("1.2.840.113549.1.1.11"); // sha256WithRSAEncryption
  const sigAlg = derSequence(Buffer.concat([sigAlgOid, derNull()]));
  const signature = crypto.sign("RSA-SHA256", tbs, privKey);
  const sigBitString = derBitString(signature);
  const cert = derSequence(Buffer.concat([tbs, sigAlg, sigBitString]));
  const b64 = cert.toString("base64");
  return [
    "-----BEGIN CERTIFICATE-----",
    ...(b64.match(/.{1,64}/g) ?? []),
    "-----END CERTIFICATE-----",
    "",
  ].join("\n");
}

function buildTbs(
  pubKey: crypto.KeyObject,
  opts: { notBefore: string; notAfter: string; cn: string },
): Buffer {
  const version = Buffer.from([0xa0, 0x03, 0x02, 0x01, 0x02]); // [0] EXPLICIT INT v3
  const serial = derInteger(Buffer.from([0x01]));
  const sigAlg = derSequence(Buffer.concat([encodeOid("1.2.840.113549.1.1.11"), derNull()]));
  const issuer = derName(opts.cn);
  const validity = derSequence(Buffer.concat([derTime(opts.notBefore), derTime(opts.notAfter)]));
  const subject = derName(opts.cn);
  const spki = pubKey.export({ type: "spki", format: "der" }) as Buffer;
  return derSequence(Buffer.concat([version, serial, sigAlg, issuer, validity, subject, spki]));
}

function derTime(iso: string): Buffer {
  // Use GeneralizedTime for years outside 1950-2049, UTCTime otherwise.
  // eslint-disable-next-line no-restricted-globals
  const d = new Date(iso);
  const yyyy = d.getUTCFullYear();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const datePart =
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z";
  if (yyyy >= 1950 && yyyy <= 2049) {
    const yy = String(yyyy).slice(2);
    const s = Buffer.from(yy + datePart, "ascii");
    return Buffer.concat([Buffer.from([0x17]), derLength(s.length), s]);
  } else {
    const s = Buffer.from(String(yyyy) + datePart, "ascii");
    return Buffer.concat([Buffer.from([0x18]), derLength(s.length), s]);
  }
}

function derName(cn: string): Buffer {
  // commonName OID = 2.5.4.3
  const atav = derSequence(Buffer.concat([encodeOid("2.5.4.3"), derPrintableString(cn)]));
  const rdn = derSet(atav);
  return derSequence(rdn);
}

function derSequence(content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x30]), derLength(content.length), content]);
}
function derSet(content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x31]), derLength(content.length), content]);
}
function derInteger(content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x02]), derLength(content.length), content]);
}
function derNull(): Buffer {
  return Buffer.from([0x05, 0x00]);
}
function derBitString(buf: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x03]), derLength(buf.length + 1), Buffer.from([0x00]), buf]);
}
function derPrintableString(s: string): Buffer {
  const body = Buffer.from(s, "ascii");
  return Buffer.concat([Buffer.from([0x13]), derLength(body.length), body]);
}
function derLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x100) return Buffer.from([0x81, len]);
  if (len < 0x10000) return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
  if (len < 0x1000000) {
    return Buffer.from([0x83, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  }
  return Buffer.from([0x84, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
}
function encodeOid(oid: string): Buffer {
  const parts = oid.split(".").map(Number);
  const first = parts[0]! * 40 + parts[1]!;
  const rest: number[] = [];
  for (let i = 2; i < parts.length; i++) {
    rest.push(...encodeOidComponent(parts[i]!));
  }
  const body = Buffer.from([first, ...rest]);
  return Buffer.concat([Buffer.from([0x06]), derLength(body.length), body]);
}
function encodeOidComponent(n: number): number[] {
  const out = [n & 0x7f];
  let v = n >> 7;
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return out;
}
