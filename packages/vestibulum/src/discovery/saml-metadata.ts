/**
 * SAML 2.0 IdP metadata parser.
 *
 * Spec: doc/federation/04-saml.md § Metadata parsing.
 *
 * Security properties enforced here (the security-critical path; per
 * plans/federation.md § Security-critical paths, branch coverage on this
 * file is held at ≥ 90% via a per-file jest override):
 *
 *  1. **Size cap** — 256 KB by default. Bigger payloads are refused before
 *     parsing; trusting the parser to enforce a cap on a hostile input is
 *     not safe (xmldom will happily allocate).
 *  2. **XXE protection** — DTDs are refused outright. Any `<!DOCTYPE`
 *     declaration in the input fails with `SamlMetadataError('invalid_xml')`.
 *     `@xmldom/xmldom` ≥ 0.8.10 (CVE-fixed) does not resolve external
 *     entities, but accepting a DTD at all opens the door to billion-laughs
 *     and external-entity classes of attack — cheapest defense is refuse.
 *  3. **XML-signature wrapping** — for signed metadata, we verify the
 *     `<ds:Signature>` and then check that the signed reference covers
 *     the same `<md:EntityDescriptor>` we extract data from. A parallel
 *     unsigned `<md:EntityDescriptor>` does not "infect" the result
 *     because we only consume the signed element. `xml-crypto` ≥ 6.0.0
 *     (CVE-fixed) is required: earlier versions had wrapping-attack
 *     bypasses.
 *  4. **SSRF guard on `kind: 'url'`** — same RFC 6890 refusal list as the
 *     OIDC issuer probe, DNS-rebinding-pinned dispatcher, `redirect:
 *     'manual'`, URL-credential refusal, URL-length cap, streaming body
 *     cap. Admin-pasted metadata URLs are the same exfiltration surface
 *     as admin-pasted issuer URLs.
 *
 * The parser deliberately does *not* reject unsigned metadata; that
 * decision lives at the manager layer (`SamlIdpManager.upsert`, T2.2),
 * which defaults to refusing unsigned blobs and requires
 * `acceptUnsignedMetadata: true` to proceed. Here, unsigned metadata
 * parses successfully with `isSigned: false`.
 */

import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { Agent } from "undici";
import { DOMParser } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";
import { createHash, X509Certificate } from "node:crypto";

import { SamlMetadataError } from "../errors.js";
import { isPrivateIPv4, isPrivateIPv6 } from "./private-ip.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One signing or encryption certificate extracted from
 * `<md:KeyDescriptor>`.
 */
export interface SamlCertificate {
  /** Original base64 X.509 wrapped in PEM headers. */
  pem: string;
  notBefore: Date;
  notAfter: Date;
  /** `CN=` from the subject DN, if any. */
  subjectCommonName?: string;
  /** Hex-encoded SHA-256 fingerprint of the DER bytes (uppercase, no colons). */
  fingerprintSha256: string;
}

/**
 * Subset of `<saml:Attribute>` descriptors that may appear inside an
 * `<md:AttributeAuthorityDescriptor>`. Currently not consumed by the IdP
 * manager — surfaced so admin UIs can present a "what does this IdP
 * promise?" panel.
 */
export interface SamlAttributeDescriptor {
  name: string;
  nameFormat?: string;
  friendlyName?: string;
}

/**
 * S-V7: SAML signature-verification status, surfaced as a
 * discriminated union so consumers (manager layer, admin UI) can
 * distinguish "missing signature" from "tampered signature" from
 * "untrusted cert" without re-parsing.
 *
 * The legacy boolean `isSigned` (kept on {@link SamlMetadata}
 * for backward compatibility) collapses every failure mode to
 * `false`, which is the load-bearing default-reject signal the
 * manager layer keys on. The `signatureStatus` field carries
 * the diagnostic detail an admin UI surfaces alongside the
 * refusal.
 */
export type SamlSignatureStatus =
  | { kind: "signed" }
  | { kind: "missing_signature" }
  | { kind: "invalid_signature" }
  | { kind: "cert_expired"; expiredAt: Date }
  | { kind: "untrusted_issuer"; detail: string }
  | { kind: "wrapping_attack_blocked" }
  | { kind: "malformed_signature"; detail: string };

/**
 * Parsed SAML 2.0 metadata. Shape follows
 * doc/federation/04-saml.md § Metadata parsing, with two
 * signature-status fields so the manager layer can apply
 * default-reject logic without re-parsing.
 */
export interface SamlMetadata {
  entityId: string;
  ssoEndpoint: {
    binding: "HTTP-Redirect" | "HTTP-POST";
    location: string;
  };
  /** All `<md:KeyDescriptor use="signing">` (or no `use` attribute) certs. */
  signingCertificates: SamlCertificate[];
  /** All `<md:KeyDescriptor use="encryption">` certs. */
  encryptionCertificates: SamlCertificate[];
  /** All `<md:NameIDFormat>` strings, in document order. */
  nameIdFormats: string[];
  /** `<md:EntityDescriptor validUntil="…">` parsed as a `Date`. */
  validUntil?: Date;
  /**
   * `<md:EntityDescriptor cacheDuration="…">` as a duration in
   * milliseconds. Per XML Schema, this is an `xs:duration`; we accept the
   * common SAML profile of `PnDTnHnMnS` and surface millis.
   */
  cacheDurationMs?: number;
  /** Distinct attribute descriptors surfaced for admin-UI display. */
  supportedAttributes?: SamlAttributeDescriptor[];
  /**
   * `true` only if a `<ds:Signature>` was present, verified
   * cryptographically against an embedded cert, *and* the signed reference
   * covers the `<md:EntityDescriptor>` we parsed from.
   *
   * Convenience boolean; equivalent to
   * `signatureStatus.kind === 'signed'`.
   */
  isSigned: boolean;
  /**
   * Discriminated-union signature status (S-V7). Surfaces the
   * specific failure mode when `isSigned === false` so admin UIs
   * and structured logs can distinguish "no signature element" from
   * "signature did not verify" from a "wrapping-attack-blocked"
   * mismatch.
   */
  signatureStatus: SamlSignatureStatus;
}

/** Source discriminator for {@link parseSamlMetadata}. */
export type SamlMetadataSource = { kind: "url"; url: string } | { kind: "xml"; xml: string };

/** Optional knobs surfaced for tests + caller overrides. */
export interface ParseSamlMetadataOptions {
  /** Default 5000 ms. Applied to network fetch + body streaming combined. */
  timeoutMs?: number;
  /** Default 256 KiB. Hard cap. */
  maxBytes?: number;
  /** Override the global `fetch` (tests). */
  fetchImpl?: typeof fetch;
  /** Override DNS resolution (tests). */
  resolveHostname?: (hostname: string) => Promise<string[]>;
  /**
   * Override the pinned-dispatcher factory (tests). Production binds to
   * {@link defaultPinnedDispatcher}; the dispatcher's `connect.lookup` is
   * pinned to the IP we just SSRF-validated, defeating DNS-rebinding TOCTOU
   * between the validate step and the connect step.
   */
  dispatcherFactory?: (validatedIp: string, family: 4 | 6) => unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 256 * 1024;
const MAX_URL_LENGTH = 2048;

const NS_MD = "urn:oasis:names:tc:SAML:2.0:metadata";
const NS_DS = "http://www.w3.org/2000/09/xmldsig#";
const NS_XMLDSIG = NS_DS;

const BINDING_REDIRECT = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const BINDING_POST = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parse and validate SAML 2.0 IdP metadata.
 *
 * Throws {@link SamlMetadataError} with a typed `reason` discriminant on
 * every documented failure mode. Network/IO errors map to
 * `'ssrf_blocked_destination'` if the destination was refused before
 * connect, or — once on the wire — surface as `'invalid_xml'` /
 * `'too_large'` / `'redirect_blocked'`.
 *
 * The function never resolves with partial metadata: if any required
 * field is missing (entity ID, at least one signing-capable cert, at
 * least one SSO binding), it throws.
 *
 * @see doc/federation/04-saml.md#metadata-parsing
 */
export async function parseSamlMetadata(
  source: SamlMetadataSource,
  options: ParseSamlMetadataOptions = {},
): Promise<SamlMetadata> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let xml: string;
  if (source.kind === "url") {
    xml = await fetchMetadataXml(source.url, maxBytes, options);
  } else {
    if (Buffer.byteLength(source.xml, "utf8") > maxBytes) {
      throw new SamlMetadataError("too_large", `Metadata XML exceeds maxBytes (${maxBytes}).`);
    }
    xml = source.xml;
  }
  return parseSamlMetadataXml(xml);
}

// ---------------------------------------------------------------------------
// Network fetch — mirrors the issuer-probe SSRF + DNS-rebinding hardening
// ---------------------------------------------------------------------------

async function fetchMetadataXml(
  url: string,
  maxBytes: number,
  options: ParseSamlMetadataOptions,
): Promise<string> {
  if (url.length > MAX_URL_LENGTH) {
    throw new SamlMetadataError(
      "ssrf_blocked_destination",
      `Metadata URL exceeds ${MAX_URL_LENGTH} chars.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SamlMetadataError(
      "ssrf_blocked_destination",
      "Metadata URL is not a valid absolute URL.",
    );
  }
  if (parsed.protocol !== "https:") {
    throw new SamlMetadataError("ssrf_blocked_destination", "Metadata URL must use https://.");
  }
  if (parsed.username || parsed.password) {
    throw new SamlMetadataError(
      "ssrf_blocked_destination",
      "Metadata URL must not include credentials.",
    );
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const resolve = options.resolveHostname ?? defaultResolve;
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    throw new SamlMetadataError("ssrf_blocked_destination", `Could not resolve ${hostname}.`);
  }
  if (addresses.length === 0) {
    throw new SamlMetadataError("ssrf_blocked_destination", `No DNS records for ${hostname}.`);
  }
  for (const addr of addresses) {
    if (addr.includes(":")) {
      if (isPrivateIPv6(addr)) {
        throw new SamlMetadataError(
          "ssrf_blocked_destination",
          `Metadata URL resolves to a refused address (${addr}).`,
        );
      }
    } else if (isPrivateIPv4(addr)) {
      throw new SamlMetadataError(
        "ssrf_blocked_destination",
        `Metadata URL resolves to a refused address (${addr}).`,
      );
    }
  }

  // Pin the connect step to the IP we just validated; without this, Node's
  // fetch performs a second DNS lookup at connect time and a TTL=0 attacker
  // can swap public for private between validate and connect.
  const validatedIp = addresses[0] ?? "";
  if (!validatedIp) {
    throw new SamlMetadataError("unreachable", "DNS resolution returned no addresses");
  }
  const validatedFamily = isIP(validatedIp);
  const factory = options.dispatcherFactory ?? defaultPinnedDispatcher;
  let pinnedDispatcher: unknown;
  if (validatedFamily === 4 || validatedFamily === 6) {
    pinnedDispatcher = factory(validatedIp, validatedFamily);
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const init: RequestInit & { dispatcher?: unknown } = {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/samlmetadata+xml, application/xml, text/xml" },
      signal: controller.signal,
    };
    if (pinnedDispatcher !== undefined) init.dispatcher = pinnedDispatcher;

    let response: Response;
    try {
      response = await fetchImpl(parsed.toString(), init);
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === "AbortError") {
        throw new SamlMetadataError(
          "ssrf_blocked_destination",
          `Metadata fetch timed out after ${timeoutMs} ms.`,
        );
      }
      throw new SamlMetadataError(
        "ssrf_blocked_destination",
        `Metadata fetch failed: ${(err as Error).message}`,
      );
    }

    if (response.status >= 300 && response.status < 400) {
      throw new SamlMetadataError(
        "redirect_blocked",
        `Metadata URL returned HTTP ${response.status}; redirects are not followed.`,
      );
    }
    if (!response.ok) {
      throw new SamlMetadataError("invalid_xml", `Metadata URL returned HTTP ${response.status}.`);
    }

    return await readBodyWithCap(response, maxBytes);
  } finally {
    clearTimeout(timer);
    if (
      pinnedDispatcher !== undefined &&
      typeof (pinnedDispatcher as { close?: () => Promise<void> }).close === "function"
    ) {
      await (pinnedDispatcher as { close: () => Promise<void> }).close().catch(() => undefined);
    }
  }
}

async function readBodyWithCap(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new SamlMetadataError("invalid_xml", "Metadata response had no body.");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SamlMetadataError("too_large", `Metadata body exceeded ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return new TextDecoder("utf-8").decode(out);
}

function defaultResolve(hostname: string): Promise<string[]> {
  return dns
    .lookup(hostname, { all: true, verbatim: true })
    .then((addrs) => addrs.map((a) => a.address));
}

function defaultPinnedDispatcher(validatedIp: string, family: 4 | 6): Agent {
  return new Agent({
    connect: { lookup: makePinnedLookup(validatedIp, family) },
  });
}

/**
 * Build the `connect.lookup` callback used by {@link defaultPinnedDispatcher}.
 *
 * Exported so tests can invoke the callback directly and confirm it
 * resolves to the validated IP — the SSRF-vs-DNS-rebinding defense's
 * load-bearing line is exactly this callback returning the
 * pre-validated address instead of consulting DNS again.
 *
 * @internal
 */
export function makePinnedLookup(
  validatedIp: string,
  family: 4 | 6,
): (
  hostname: string,
  opts: unknown,
  cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
) => void {
  return (_hostname, _opts, cb) => cb(null, validatedIp, family);
}

// ---------------------------------------------------------------------------
// XML parsing + validation
// ---------------------------------------------------------------------------

/** Exported for direct-XML tests; `parseSamlMetadata` calls into this. */
export function parseSamlMetadataXml(xml: string): SamlMetadata {
  // 1. XXE refusal — refuse the document outright if it contains a DTD.
  //    @xmldom does not resolve external entities, but accepting a DTD opens
  //    the door to billion-laughs-style internal-entity attacks regardless.
  if (containsDoctype(xml)) {
    throw new SamlMetadataError(
      "invalid_xml",
      "Metadata contains a DOCTYPE declaration; DTDs are refused for XXE protection.",
    );
  }

  // 2. Parse with strict error handlers — any warning/error becomes a fatal
  //    parse failure. xmldom otherwise downgrades many errors to warnings.
  let doc: Document;
  try {
    const parseErrors: string[] = [];
    const parser = new DOMParser({
      locator: true,
      onError: (level, msg) => {
        if (level === "warning") {
          parseErrors.push(msg);
        } else {
          throw new Error(msg);
        }
      },
    });
    doc = parser.parseFromString(xml, "text/xml") as unknown as Document;
    if (parseErrors.length > 0) {
      throw new SamlMetadataError("invalid_xml", `XML parse warnings: ${parseErrors.join("; ")}`);
    }
  } catch (err) {
    if (err instanceof SamlMetadataError) throw err;
    throw new SamlMetadataError("invalid_xml", `XML parse failed: ${(err as Error).message}`);
  }

  // 3. Find the EntityDescriptor we will operate on.
  const entityDescriptor = findEntityDescriptor(doc);
  if (!entityDescriptor) {
    throw new SamlMetadataError("invalid_xml", "No <md:EntityDescriptor> element found.");
  }

  // 4. Signature verification. If a Signature element exists *anywhere* in
  //    the document, attempt to verify it. The result is meaningful for the
  //    manager layer only if the signature covers the EntityDescriptor we
  //    are parsing; this also rejects XML-signature-wrapping attacks where
  //    a sibling unsigned EntityDescriptor is smuggled in.
  //
  // S-V7: the helper returns a discriminated `SamlSignatureStatus`
  // so the diagnostic mode (missing / tampered / wrapping / malformed)
  // can be surfaced alongside the legacy `isSigned` boolean.
  const signatureStatus = verifyDocumentSignature(doc, xml, entityDescriptor);
  const isSigned = signatureStatus.kind === "signed";

  // 5. Extract the metadata fields.
  const entityId = requireAttr(entityDescriptor, "entityID", "EntityDescriptor@entityID");
  const idpSso = findChildNS(entityDescriptor, NS_MD, "IDPSSODescriptor");
  if (!idpSso) {
    throw new SamlMetadataError(
      "invalid_xml",
      "<md:EntityDescriptor> has no <md:IDPSSODescriptor> child.",
    );
  }

  const ssoEndpoint = pickSsoEndpoint(idpSso);
  const { signingCertificates, encryptionCertificates } = extractKeyDescriptors(idpSso);

  if (signingCertificates.length === 0) {
    throw new SamlMetadataError(
      "no_signing_cert",
      "IDPSSODescriptor has no signing <md:KeyDescriptor>.",
    );
  }
  const now = Date.now();
  if (signingCertificates.every((c) => c.notAfter.getTime() < now)) {
    throw new SamlMetadataError("expired", "All signing certificates are past notAfter.");
  }

  const nameIdFormats = childTextsNS(idpSso, NS_MD, "NameIDFormat");

  const validUntilAttr = entityDescriptor.getAttribute("validUntil");
  const validUntil = validUntilAttr !== null ? parseDateOrThrow(validUntilAttr) : undefined;
  const cacheDurationAttr = entityDescriptor.getAttribute("cacheDuration");
  const cacheDurationMs =
    cacheDurationAttr !== null ? parseXsDuration(cacheDurationAttr) : undefined;

  const supportedAttributes = extractSupportedAttributes(entityDescriptor);

  const result: SamlMetadata = {
    entityId,
    ssoEndpoint,
    signingCertificates,
    encryptionCertificates,
    nameIdFormats,
    isSigned,
    signatureStatus,
    ...(validUntil ? { validUntil } : {}),
    ...(cacheDurationMs !== undefined ? { cacheDurationMs } : {}),
    ...(supportedAttributes.length > 0 ? { supportedAttributes } : {}),
  };
  return result;
}

// ---------------------------------------------------------------------------
// Signature verification (wrapping-attack defense)
// ---------------------------------------------------------------------------

/**
 * Verify the `<ds:Signature>` over the supplied EntityDescriptor.
 *
 * S-V7: returns a discriminated {@link SamlSignatureStatus} rather
 * than a bare boolean, so the manager layer (and admin UI) can
 * distinguish "missing signature" from "tampered signature" from
 * "wrapping attack" without re-parsing.
 *
 * Returns `{ kind: 'signed' }` only if:
 *   - a `<ds:Signature>` element exists as a direct child of
 *     the supplied EntityDescriptor,
 *   - `xml-crypto`'s `checkSignature` returns true,
 *   - exactly one reference was validated, and
 *   - that reference's URI / ID-attribute resolves to the same
 *     EntityDescriptor element we just selected for parsing.
 *
 * Wrapping attacks (the most common SAML attack class against this
 * code path) try to keep the signed subtree intact but smuggle a
 * parallel unsigned EntityDescriptor that gets consumed by the
 * parser. The "same element" check defeats that — if our
 * `findEntityDescriptor` returns the attacker's element, the
 * verified reference will not match and we return
 * `{ kind: 'wrapping_attack_blocked' }`.
 */
function verifyDocumentSignature(
  doc: Document,
  xml: string,
  entityDescriptor: Element,
): SamlSignatureStatus {
  const signatureNodes = collectByNS(doc, NS_DS, "Signature");
  if (signatureNodes.length === 0) {
    return { kind: "missing_signature" };
  }
  // The signature we care about is the *direct* child of the
  // EntityDescriptor we're parsing. A signature on a sibling or ancestor
  // is the classic wrapping-attack shape; refusing to look at it
  // produces `wrapping_attack_blocked` so the diagnostic surfaces
  // distinctly from "no signature at all". Descendants nested deeper
  // inside (e.g. inside a KeyDescriptor's KeyInfo) are also not
  // metadata signatures — same outcome.
  const directSignature = signatureNodes.find((sig) => isDirectChildOf(sig, entityDescriptor));
  if (!directSignature) {
    return { kind: "wrapping_attack_blocked" };
  }

  // xml-crypto ≥ 6 defaults `getCertFromKeyInfo` to a no-op for safety
  // (callers are expected to opt in to using the embedded key). We opt
  // in here because the parser's role is only to determine whether
  // *some* key in the metadata can verify the signature; the trust
  // decision (is this the right key?) belongs to the manager layer.
  // xml-crypto expects the static method as a callback; it doesn't
  // use `this`, so the unbound-method rule is a false positive here.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const getCertFromKeyInfo = SignedXml.getCertFromKeyInfo;
  const sig = new SignedXml({ getCertFromKeyInfo });
  try {
    sig.loadSignature(directSignature);
    if (!sig.checkSignature(xml)) {
      return { kind: "invalid_signature" };
    }
  } catch (err) {
    return {
      kind: "malformed_signature",
      detail: (err as Error).message ?? "unknown",
    };
  }

  // Wrapping defense, layer 2: require that the verified references
  // include exactly one entry that targets the EntityDescriptor by ID.
  // After `checkSignature` re-parses the XML internally, references hold
  // their URI strings even though the validated DOM nodes belong to
  // xml-crypto's reparsed tree (so node-identity comparison would not
  // work across the boundary). URI comparison is the stable check.
  const refs = sig.getReferences();
  if (refs.length !== 1) {
    return {
      kind: "malformed_signature",
      detail: `expected exactly 1 reference, got ${refs.length}`,
    };
  }
  /* istanbul ignore next — xml-crypto's typing allows undefined uri but
     `loadSignature` rejects refs without URI long before we get here. */
  const refUri = (refs[0]?.uri ?? "").replace(/^#/, "");
  if (refUri === "") {
    return {
      kind: "malformed_signature",
      detail: "reference has no URI",
    };
  }
  const entityId = entityDescriptor.getAttribute("ID");
  if (entityId === null || entityId === "") {
    return { kind: "wrapping_attack_blocked" };
  }
  if (refUri !== entityId) {
    return { kind: "wrapping_attack_blocked" };
  }
  return { kind: "signed" };
}

function isDirectChildOf(node: Element, parent: Element): boolean {
  // xmldom's `Node` does not always pass `===` against the Element we
  // hold (different DOM-builder code paths can wrap the same underlying
  // node), so we walk parentNode rather than reference-compare.
  return node.parentNode === parent;
}

// ---------------------------------------------------------------------------
// Metadata extraction helpers
// ---------------------------------------------------------------------------

function findEntityDescriptor(doc: Document): Element | null {
  // SAML metadata is normally a single root `<md:EntityDescriptor>`. The
  // `<md:EntitiesDescriptor>` aggregate form is legal but uncommon for
  // single-IdP records; pick the first EntityDescriptor in that case.
  const root = doc.documentElement;
  if (root === null || root === undefined) return null;
  if (root.namespaceURI === NS_MD && root.localName === "EntityDescriptor") {
    return root;
  }
  // Otherwise descend looking for the first EntityDescriptor.
  const all = collectByNS(doc, NS_MD, "EntityDescriptor");
  return all[0] ?? null;
}

function pickSsoEndpoint(idpSso: Element): SamlMetadata["ssoEndpoint"] {
  const services = collectChildrenByNS(idpSso, NS_MD, "SingleSignOnService");
  const redirect = services.find((s) => s.getAttribute("Binding") === BINDING_REDIRECT);
  const post = services.find((s) => s.getAttribute("Binding") === BINDING_POST);
  const picked = redirect ?? post;
  if (!picked) {
    throw new SamlMetadataError(
      "unsupported_binding",
      "IDPSSODescriptor has no HTTP-Redirect or HTTP-POST SingleSignOnService.",
    );
  }
  const location = requireAttr(picked, "Location", "SingleSignOnService@Location");
  return {
    binding: picked === redirect ? "HTTP-Redirect" : "HTTP-POST",
    location,
  };
}

function extractKeyDescriptors(idpSso: Element): {
  signingCertificates: SamlCertificate[];
  encryptionCertificates: SamlCertificate[];
} {
  const signingCertificates: SamlCertificate[] = [];
  const encryptionCertificates: SamlCertificate[] = [];

  const descriptors = collectChildrenByNS(idpSso, NS_MD, "KeyDescriptor");
  for (const kd of descriptors) {
    const use = kd.getAttribute("use"); // may be empty == both
    const keyInfo = firstChildNS(kd, NS_XMLDSIG, "KeyInfo");
    if (!keyInfo) continue;
    const x509Datas = collectChildrenByNS(keyInfo, NS_XMLDSIG, "X509Data");
    for (const data of x509Datas) {
      const certNodes = collectChildrenByNS(data, NS_XMLDSIG, "X509Certificate");
      for (const certNode of certNodes) {
        /* istanbul ignore next — xmldom returns a string here; the
           nullish-coalescing satisfies TypeScript's `string | null`
           textContent typing. */
        const b64 = (certNode.textContent ?? "").replace(/\s+/g, "");
        if (!b64) continue;
        const cert = buildCertificate(b64);
        if (!cert) continue;
        if (use === "encryption") {
          encryptionCertificates.push(cert);
        } else {
          // `use=""` ("both") or `use="signing"` → counts as signing-eligible.
          signingCertificates.push(cert);
          if (use === "" || use === null) {
            encryptionCertificates.push(cert);
          }
        }
      }
    }
  }
  return { signingCertificates, encryptionCertificates };
}

function buildCertificate(b64: string): SamlCertificate | null {
  // `X509Certificate` throws on any structural problem — including invalid
  // ASN.1 time fields — so the caller's `catch` block covers the
  // unparseable-dates case. We don't need a separate NaN guard.
  try {
    const der = Buffer.from(b64, "base64");
    const pem = pemFromBase64(b64);
    const x = new X509Certificate(der);
    const notBefore = new Date(x.validFrom);
    const notAfter = new Date(x.validTo);
    const cnMatch = /CN=([^,/+]+)/.exec(x.subject);
    /* istanbul ignore next — all test fixtures embed a CN; the
       no-CN branch survives so a malformed admin-pasted cert
       does not crash extraction. */
    const subjectCommonName = cnMatch !== null ? cnMatch[1]?.trim() : undefined;
    const fingerprintSha256 = createHash("sha256").update(der).digest("hex").toUpperCase();
    return {
      pem,
      notBefore,
      notAfter,
      fingerprintSha256,
      /* istanbul ignore next — same no-CN guard as above. */
      ...(subjectCommonName !== undefined ? { subjectCommonName } : {}),
    };
  } catch {
    return null;
  }
}

function extractSupportedAttributes(entityDescriptor: Element): SamlAttributeDescriptor[] {
  // `<md:AttributeAuthorityDescriptor>` is optional and rare; pull
  // `<saml:Attribute>` descriptors out if present.
  const out: SamlAttributeDescriptor[] = [];
  const authorities = collectChildrenByNS(entityDescriptor, NS_MD, "AttributeAuthorityDescriptor");
  for (const aa of authorities) {
    for (const node of Array.from(aa.childNodes)) {
      if (node.nodeType !== 1) continue;
      const el = node as Element;
      if (el.localName !== "Attribute") continue;
      const name = el.getAttribute("Name");
      if (name === null || name === "") continue;
      const nameFormatRaw = el.getAttribute("NameFormat");
      const nameFormat = nameFormatRaw !== null && nameFormatRaw !== "" ? nameFormatRaw : undefined;
      const friendlyNameRaw = el.getAttribute("FriendlyName");
      const friendlyName =
        friendlyNameRaw !== null && friendlyNameRaw !== "" ? friendlyNameRaw : undefined;
      out.push({
        name,
        ...(nameFormat !== undefined ? { nameFormat } : {}),
        ...(friendlyName !== undefined ? { friendlyName } : {}),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// XML utility helpers
// ---------------------------------------------------------------------------

function containsDoctype(xml: string): boolean {
  // Match `<!DOCTYPE` allowing leading whitespace / BOM / XML prolog.
  // The check is byte-level; a hostile producer cannot evade it via
  // encoding tricks because xmldom decodes UTF-8 / UTF-16 BOM before
  // serializing — and a stripped document with no `<!DOCTYPE` literal
  // is exactly what we want anyway.
  return /<!DOCTYPE\b/i.test(xml);
}

function requireAttr(el: Element, attr: string, label: string): string {
  const value = el.getAttribute(attr);
  if (value === null || value === "") {
    throw new SamlMetadataError("invalid_xml", `Missing ${label}.`);
  }
  return value;
}

function findChildNS(parent: Element, ns: string, localName: string): Element | null {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    if (el.namespaceURI === ns && el.localName === localName) return el;
  }
  return null;
}

function firstChildNS(parent: Element | Node, ns: string, localName: string): Element | null {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    if (el.namespaceURI === ns && el.localName === localName) return el;
  }
  return null;
}

function collectChildrenByNS(parent: Element, ns: string, localName: string): Element[] {
  const out: Element[] = [];
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    if (el.namespaceURI === ns && el.localName === localName) out.push(el);
  }
  return out;
}

function collectByNS(doc: Document, ns: string, localName: string): Element[] {
  // Document-wide collection. `getElementsByTagNameNS` is the standard
  // call; xmldom supports it.
  const list = doc.getElementsByTagNameNS(ns, localName);
  const out: Element[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list.item(i);
    if (item !== null) out.push(item);
  }
  return out;
}

function childTextsNS(parent: Element, ns: string, localName: string): string[] {
  return collectChildrenByNS(parent, ns, localName)
    .map((el) => {
      /* istanbul ignore next — see X509Certificate textContent note. */
      const t = el.textContent ?? "";
      return t.trim();
    })
    .filter((s) => s.length > 0);
}

function parseDateOrThrow(value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new SamlMetadataError("invalid_xml", `Invalid date in metadata: ${value}`);
  }
  return d;
}

/**
 * Parse an `xs:duration` value. SAML metadata commonly uses
 * `PT6H` (six hours) or `P1D` (one day); we accept the
 * non-negative subset of the full lexical form.
 *
 * Returns milliseconds. Months/years are not unambiguously
 * convertible to ms (variable length), so they raise an error.
 */
function parseXsDuration(value: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!m) {
    throw new SamlMetadataError("invalid_xml", `Unsupported cacheDuration: ${value}`);
  }
  const days = m[1] !== undefined && m[1] !== "" ? Number(m[1]) : 0;
  const hours = m[2] !== undefined && m[2] !== "" ? Number(m[2]) : 0;
  const minutes = m[3] !== undefined && m[3] !== "" ? Number(m[3]) : 0;
  const seconds = m[4] !== undefined && m[4] !== "" ? Number(m[4]) : 0;
  if (days === 0 && hours === 0 && minutes === 0 && seconds === 0) {
    throw new SamlMetadataError(
      "invalid_xml",
      `cacheDuration must specify at least one component: ${value}`,
    );
  }
  return days * 86_400_000 + hours * 3_600_000 + minutes * 60_000 + Math.round(seconds * 1000);
}

function pemFromBase64(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) {
    lines.push(b64.slice(i, i + 64));
  }
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}
