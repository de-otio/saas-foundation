/**
 * Cookie parsing and building utilities for auth endpoints.
 *
 * These helpers are intentionally small and dependency-free so they can be
 * bundled into Lambda without bringing in a cookie library. They enforce the
 * security attributes required by the Vestibulum cookie posture spec:
 * HttpOnly, Secure, SameSite, and Path are all mandatory on every cookie.
 *
 * @see doc/01-package-design.md §Cookie and CSRF posture
 */

/** Cookie attributes that must be present on every Set-Cookie header. */
export interface CookieOptions {
  /** Must be true — rejects absent flag at build time. */
  httpOnly: true;
  /** Must be true — rejects absent flag at build time. */
  secure: true;
  /** Enforces SameSite attribute. */
  sameSite: "Lax" | "Strict";
  /** Must be non-empty — enforces explicit path scoping. */
  path: string;
  /** Strict subdomain (no leading dot). E.g. `app.example.com`. */
  domain: string;
  /** Max-Age in seconds. 0 means "delete immediately". */
  maxAge: number;
}

/**
 * Parses the `Cookie` request header into a key→value map.
 *
 * Handles the standard `name=value; name2=value2` format. Values that
 * contain `=` (e.g. base64url) are preserved correctly.
 *
 * @param header - The raw `Cookie` header value, or undefined if absent.
 * @returns A record of cookie name → decoded value. Empty record if header
 *   is absent or empty.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  if (header === undefined || header === "") {
    return {};
  }

  const result: Record<string, string> = {};

  for (const pair of header.split(";")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) {
      continue;
    }
    const name = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    if (name.length > 0) {
      result[name] = value;
    }
  }

  return result;
}

/**
 * Builds a `Set-Cookie` header value with the mandatory security attributes
 * required by the Vestibulum cookie posture spec.
 *
 * The function signature enforces at the TypeScript level that `HttpOnly` and
 * `Secure` are always set — you cannot call it without them. This eliminates
 * the most common class of cookie misconfiguration.
 *
 * @param name - Cookie name.
 * @param value - Cookie value. Pass an empty string to clear the cookie.
 * @param opts - Required cookie options including security attributes.
 * @returns The full `Set-Cookie` header string.
 *
 * @throws If `path` is empty (misconfiguration guard).
 * @throws If `domain` is empty (misconfiguration guard).
 */
export function buildSetCookie(name: string, value: string, opts: CookieOptions): string {
  if (opts.path.length === 0) {
    throw new Error("Cookie path must not be empty");
  }
  if (opts.domain.length === 0) {
    throw new Error("Cookie domain must not be empty");
  }

  const parts: string[] = [
    `${name}=${value}`,
    `Max-Age=${opts.maxAge}`,
    `Path=${opts.path}`,
    `Domain=${opts.domain}`,
    `SameSite=${opts.sameSite}`,
  ];

  // HttpOnly and Secure are required by the type — always included.
  parts.push("HttpOnly");
  parts.push("Secure");

  return parts.join("; ");
}
