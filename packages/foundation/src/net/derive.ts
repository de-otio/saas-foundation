/**
 * `trustedClientIp` and `isIpShape` — trusted-proxy client IP derivation.
 *
 * Three trust modes:
 *   - `none` (default): trust only the socket remote address.
 *   - `alb`: trust the rightmost XFF entry (ALB-appended).
 *   - `cloudflare`: trust CF-Connecting-IP.
 *
 * Returns a validated IP string, or the literal `'unknown'` on failure.
 * The `'unknown'` sentinel keeps rate-limit keys well-formed (downstream
 * rate-limiters use it as a shared bucket rather than failing).
 *
 * Shape validation guards against rate-limit-key poisoning. Even in
 * trusted-proxy modes, the header value is validated against the IPv4/IPv6
 * shape regex before being returned.
 *
 * All functions are pure except `trustedClientIp` (reads Request headers).
 */

import { createHmac } from "node:crypto";
import { isIPv4InCidr, isIPv6InCidr } from "./cidr.js";
import { RFC6890_IPV4_RESERVED, RFC6890_IPV6_RESERVED } from "./rfc6890.js";

// ---------------------------------------------------------------------------
// Shape validation
// ---------------------------------------------------------------------------

/**
 * IPv4 dotted-quad regex: each octet 0–255, strict octet-range check.
 * No leading zeros (256-overflow rejected).
 */
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * IPv6 loose-shape (without zone ID): accepts compressed/uncompressed,
 * IPv4-mapped. Rejects anything containing characters outside the hex/colon/dot
 * alphabet. Zone IDs are stripped before applying this regex.
 */
const IPV6_BODY_RE = /^[0-9a-fA-F:.]+$/;

/**
 * Returns `true` when `s` is a valid IPv4 dotted-quad or an IPv6 shape.
 * Length-capped at 64 characters to prevent buffer-filling attacks.
 *
 * IPv6 zone identifiers (`%interface-name`) are accepted and stripped before
 * shape-checking (per the design doc caveat). Zone IDs can contain any
 * printable non-space character; stripping them before the hex check is the
 * correct approach.
 *
 * Pure.
 */
export function isIpShape(s: string): boolean {
  if (!s || s.length > 64) return false;
  if (IPV4_RE.test(s)) return true;
  // IPv6 must contain at least one colon
  if (!s.includes(":")) return false;
  // Strip zone ID (everything from % onward) before applying the hex regex
  const zoneIdx = s.indexOf("%");
  const body = zoneIdx !== -1 ? s.slice(0, zoneIdx) : s;
  return IPV6_BODY_RE.test(body);
}

// ---------------------------------------------------------------------------
// Reserved-block check
// ---------------------------------------------------------------------------

/**
 * Returns true if `ip` falls within any RFC 6890 reserved block.
 * Used to reject IPs that should never appear as a legitimate client address
 * (prevents SSRF via header spoofing).
 *
 * Pure.
 */
export function isReservedIp(ip: string): boolean {
  if (!ip) return false;

  // IPv4
  if (IPV4_RE.test(ip)) {
    for (const block of RFC6890_IPV4_RESERVED) {
      if (isIPv4InCidr(ip, block.cidr)) return true;
    }
    return false;
  }

  // IPv6
  if (ip.includes(":") && IPV6_BODY_RE.test(ip.replace(/%.*$/, ""))) {
    for (const block of RFC6890_IPV6_RESERVED) {
      if (isIPv6InCidr(ip, block.cidr)) return true;
    }
    return false;
  }

  return false;
}

// ---------------------------------------------------------------------------
// IP anonymization
// ---------------------------------------------------------------------------

export type IpAnonymizationLevel = "none" | "partial" | "hash";

export interface IpAnonymizerOptions {
  readonly hashSalt?: string;
  readonly defaultLevel?: IpAnonymizationLevel;
}

/**
 * IP anonymiser supporting three levels:
 * - `none`: pass through.
 * - `partial`: IPv4 → zero last octet; IPv6 → keep first 4 hextets.
 * - `hash`: HMAC-SHA-256 → `hashed:v1:<first-16-hex>`.
 */
export class IpAnonymizer {
  private readonly hashSalt: string | undefined;
  private readonly defaultLevel: IpAnonymizationLevel;

  constructor(options?: IpAnonymizerOptions) {
    this.hashSalt = options?.hashSalt;
    this.defaultLevel = options?.defaultLevel ?? "partial";
  }

  anonymize(ip: string, level?: IpAnonymizationLevel): string {
    const effectiveLevel = level ?? this.defaultLevel;

    if (effectiveLevel === "none") return ip;

    if (effectiveLevel === "hash") {
      if (this.hashSalt === undefined) {
        throw new Error("IpAnonymizer: hashSalt is required when anonymization level is 'hash'");
      }
      return this._hashIp(ip, this.hashSalt);
    }

    // partial
    return anonymizeIpPartial(ip);
  }

  private _hashIp(ip: string, salt: string): string {
    // Synchronous HMAC-SHA-256 via node:crypto.
    // Result: `hashed:v1:<first-16-hex-chars>`
    // The `v1` algorithm-version prefix allows future changes to the hash
    // construction without ambiguity in historical audit rows.
    const hmac = createHmac("sha256", salt).update(ip).digest("hex");
    return `hashed:v1:${hmac.slice(0, 16)}`;
  }
}

/**
 * Convenience anonymizer for callers that don't need hashing.
 * No salt required.
 *
 * Pure (except for string manipulation).
 */
export function anonymizeIpPartial(ip: string): string {
  if (!ip) return ip;

  // IPv4: zero the last octet
  if (IPV4_RE.test(ip)) {
    const parts = ip.split(".");
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }

  // IPv6: zero everything after the first 4 hextets
  // Strip zone ID first
  const zoneIdx = ip.indexOf("%");
  const addr = zoneIdx !== -1 ? ip.slice(0, zoneIdx) : ip;

  // Expand to full notation, zero last 4 hextets
  const doubleColonIdx = addr.indexOf("::");
  if (doubleColonIdx !== -1) {
    // Compressed form — simple approach: keep up to first 4 groups
    const parts = addr.replace("::", ":0:0:0:0:0:0:0:0:").split(":").filter(Boolean);
    if (parts.length >= 4) {
      return `${parts[0]}:${parts[1]}:${parts[2]}:${parts[3]}::`;
    }
    return `${addr}::`;
  }

  const parts = addr.split(":");
  if (parts.length === 8) {
    return `${parts[0]}:${parts[1]}:${parts[2]}:${parts[3]}::`;
  }

  // Fallback — can't parse, return as-is
  return ip;
}

// ---------------------------------------------------------------------------
// Trusted-proxy derivation
// ---------------------------------------------------------------------------

export type TrustedProxyMode = "none" | "alb" | "cloudflare";

export interface TrustedClientIpConfig {
  readonly mode: TrustedProxyMode;
}

/** Read a remote-address hint from a `Request` if the runtime exposes one. */
function remoteAddrFromRequest(request: Request): string | null {
  const candidate = (request as unknown as { socket?: { remoteAddress?: string } }).socket
    ?.remoteAddress;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

/**
 * Derive a client IP we are willing to use for rate-limit keys / audit
 * payloads. Always returns a non-empty string; `'unknown'` when nothing
 * trustworthy is available.
 *
 * Validation pipeline (in order):
 * 1. Select candidate based on trust mode.
 * 2. Validate IP shape (isIpShape).
 * 3. Reject reserved-block IPs (SSRF prevention).
 *
 * Impure: reads `request.headers`.
 */
export function trustedClientIp(request: Request, config: TrustedClientIpConfig): string {
  const mode = config.mode;

  let candidate: string | null = null;

  if (mode === "cloudflare") {
    const cf = request.headers.get("CF-Connecting-IP");
    candidate = cf !== null ? cf.trim() : null;
  } else if (mode === "alb") {
    // ALB appends the immediate client to the right end of XFF.
    const xff = request.headers.get("X-Forwarded-For");
    if (xff !== null) {
      const parts = xff
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      candidate = parts[parts.length - 1] ?? null;
    }
  } else {
    // mode === "none"
    candidate = remoteAddrFromRequest(request);
  }

  if (candidate === null) return "unknown";
  if (!isIpShape(candidate)) return "unknown";
  if (isReservedIp(candidate)) return "unknown";
  return candidate;
}
