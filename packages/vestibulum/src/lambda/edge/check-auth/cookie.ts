/**
 * Minimal RFC-6265 cookie header parser for Lambda@Edge.
 *
 * Why hand-rolled: every byte counts toward the 1 MB Lambda@Edge bundle limit,
 * and a third-party cookie library (e.g. `cookie`) is dead weight when all we
 * need is "give me the value of cookie X from a CloudFront viewer-request
 * event". The CloudFront event shape ships the `Cookie` header as an array of
 * `{ key, value }` pairs, where the `value` is one or more `;`-separated
 * `name=value` segments.
 *
 * Security notes:
 * - Returns `undefined` for any malformed input rather than throwing.
 *   `check-auth` is fail-closed: an undefined cookie produces a 302, which is
 *   exactly the same outcome as any other parse failure.
 * - Does not decode percent-encoding. ID-token JWTs are base64url and contain
 *   no characters that require encoding, so decoding would only obscure bugs.
 * - Does not validate the cookie value against a JWT shape. That is the
 *   verifier's job; the parser's only contract is "extract the raw segment".
 */

/**
 * CloudFront viewer-request `headers` shape: each header name maps to an
 * array of `{ key, value }` entries (CloudFront preserves casing in `key`
 * and lower-cases the header-name index).
 */
export interface CloudFrontHeaderEntry {
  readonly key?: string;
  readonly value: string;
}

/** Map of lower-cased header name to array of entries. */
export type CloudFrontHeaders = Record<string, CloudFrontHeaderEntry[]>;

/**
 * Extract a single cookie's value from a CloudFront viewer-request headers
 * object.
 *
 * @param headers - The viewer-request headers object from the CloudFront
 *   Lambda@Edge event (`event.Records[0].cf.request.headers`).
 * @param name - The cookie name to look for.
 * @returns The cookie value if found and well-formed, otherwise `undefined`.
 */
export function getCookieValue(
  headers: CloudFrontHeaders | undefined,
  name: string,
): string | undefined {
  if (!headers || !name) {
    return undefined;
  }
  const cookieHeaders = headers["cookie"];
  if (!cookieHeaders || cookieHeaders.length === 0) {
    return undefined;
  }
  for (const entry of cookieHeaders) {
    if (entry === undefined || entry === null || typeof entry.value !== "string") {
      continue;
    }
    const value = parseCookieSegment(entry.value, name);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/**
 * Walk one `Cookie` header value (a `;`-separated `name=value` list) and
 * return the value of the requested cookie name, or `undefined` if absent.
 *
 * Exported for unit tests; not part of the handler's runtime contract.
 *
 * @param raw - The raw `Cookie` header value.
 * @param name - The cookie name to extract.
 * @returns The cookie value, or `undefined` if not present / malformed.
 */
export function parseCookieSegment(raw: string, name: string): string | undefined {
  // Split on `;` and trim each segment.
  const segments = raw.split(";");
  for (const rawSegment of segments) {
    const segment = rawSegment.trim();
    if (segment.length === 0) {
      continue;
    }
    const eq = segment.indexOf("=");
    if (eq <= 0) {
      // Malformed segment — no name=, or empty name. Skip.
      continue;
    }
    const k = segment.slice(0, eq).trim();
    if (k !== name) {
      continue;
    }
    const v = segment.slice(eq + 1).trim();
    // RFC 6265 allows double-quoting; strip a matched pair if present.
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
      return v.slice(1, -1);
    }
    return v;
  }
  return undefined;
}
