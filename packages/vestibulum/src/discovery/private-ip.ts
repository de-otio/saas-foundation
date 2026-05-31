/**
 * IPv4 and IPv6 private/special-purpose range classification for
 * vestibulum's SSRF guards.
 *
 * **B-E coverage.** This module delegates the actual reserved-block
 * check to foundation's `isReservedIp` (built on the RFC 6890 table
 * in `@de-otio/saas-foundation/net`). The foundation table
 * includes the five blocks B-E required:
 *
 *   - 192.0.2.0/24    (TEST-NET-1, RFC 5737)
 *   - 198.51.100.0/24 (TEST-NET-2, RFC 5737)
 *   - 203.0.113.0/24  (TEST-NET-3, RFC 5737)
 *   - 240.0.0.0/4     (Class E reserved, RFC 1112)
 *   - 255.255.255.255/32 (limited broadcast, RFC 919)
 *
 * plus the benchmarking range 198.18.0.0/15, carrier-grade NAT
 * 100.64.0.0/10, all the standard RFC 1918 private, loopback,
 * link-local, multicast, and ULA blocks, and the IPv6 reserved
 * blocks (loopback, ULA, link-local, multicast, IPv4-mapped,
 * documentation, etc.). Maintaining the coverage in one place
 * avoids the duplication that drove B-E.
 *
 * The wrapper adds **fail-closed semantics** on top of foundation's
 * check: foundation's `isReservedIp` returns `false` for
 * syntactically-invalid input (because in its primary use case —
 * client-IP derivation — invalid input is already handled
 * upstream), but for an SSRF guard, fail-closed is the safe
 * default. If the input does not parse as an IP, we treat it as
 * private. This preserves the prior vestibulum behaviour for
 * malformed input.
 *
 * Shared by:
 * - {@link probeOidcIssuer} (T1.1) — the OIDC issuer probe SSRF guard.
 * - `parseSamlMetadata` (T1.2, owned by R2) — the SAML metadata fetch SSRF guard.
 *
 * Both call sites reject any destination that resolves to an
 * address in the foundation table before opening a TCP connection.
 * The IP-pin step on the actual connect is layered on top by
 * {@link probeOidcIssuer}; this module is only the classifier.
 *
 * See doc/federation/02-runtime-api.md § Issuer probe and
 * doc/review/2026-05-24-initial-design-pass.md § B-E.
 */

import { isIpShape, isReservedIp } from "@de-otio/saas-foundation";

/**
 * Returns true if the IPv4 address is in any RFC 6890 reserved
 * block (or syntactically invalid, as a fail-closed default).
 *
 * Delegates to foundation's `isReservedIp`; the foundation table
 * is the canonical source per B-E.
 */
export function isPrivateIPv4(ip: string): boolean {
  // Fail-closed on malformed input.
  if (!isIpShape(ip)) return true;
  // Refuse IPv6 input on the IPv4 path — the caller mismatched
  // the routing.
  if (ip.includes(":")) return true;
  if (isReservedIp(ip)) return true;
  // Vestibulum-additional heuristic: the trellis reference
  // implementation refuses the entire `192.0.x.x` block as
  // non-routable for SSRF purposes. The block is a mix of IETF
  // Protocol Assignments (192.0.0.0/24), AS112-v4 (192.0.1.0,
  // 192.0.5.0/24), and TEST-NET-1 (192.0.2.0/24) — none of which
  // a legitimate OIDC issuer or SAML IdP would live on. Foundation
  // covers only /24 sub-blocks; we keep the broader refusal here
  // as defensive depth.
  const octets = ip.split(".");
  if (octets[0] === "192" && octets[1] === "0") return true;
  return false;
}

/**
 * Returns true if the IPv6 address is in any RFC 6890 reserved
 * block (or syntactically invalid, as a fail-closed default).
 *
 * Zone identifiers (`%eth0`) are stripped before classification.
 * IPv4-mapped addresses (`::ffff:x.y.z.w`) are caught by the
 * `::ffff:0:0/96` entry in foundation's reserved-IPv6 table.
 */
export function isPrivateIPv6(ip: string): boolean {
  if (!ip || !ip.includes(":")) {
    // An address with no `:` is not a valid IPv6 address; treat as
    // private to keep the API surface fail-closed.
    return true;
  }
  if (!isIpShape(ip)) return true;

  // Strip zone identifier before delegating.
  const stripped = (ip.split("%")[0] ?? ip).toLowerCase();
  // Defensive structural check — expandIPv6 returns null on
  // malformed compressed-form input that isIpShape's loose regex
  // accepts. Fail-closed on any such malformed shape.
  const segs = expandIPv6(stripped);
  if (segs === null) return true;

  // IPv4-mapped (`::ffff:x.y.z.w`) addresses: the prior vestibulum
  // behaviour was to extract the embedded v4 and apply the v4
  // ruleset. Foundation's reserved-IPv6 table includes
  // `::ffff:0:0/96` which would mark every v4-mapped address as
  // reserved; we override here so a v4-mapped *public* address
  // (e.g. `::ffff:8.8.8.8`) classifies as public, matching the
  // semantics the trellis port committed to.
  if (
    segs[0] === 0 &&
    segs[1] === 0 &&
    segs[2] === 0 &&
    segs[3] === 0 &&
    segs[4] === 0 &&
    segs[5] === 0xffff
  ) {
    const v4 = `${((segs[6] ?? 0) >> 8) & 0xff}.${(segs[6] ?? 0) & 0xff}.${((segs[7] ?? 0) >> 8) & 0xff}.${(segs[7] ?? 0) & 0xff}`;
    return isPrivateIPv4(v4);
  }

  return isReservedIp(stripped);
}

/**
 * Convenience wrapper: classify an arbitrary address (v4 or v6) as
 * private. Returns true for malformed input (fail-closed).
 */
export function isPrivateAddress(address: string): boolean {
  if (address.includes(":")) {
    return isPrivateIPv6(address);
  }
  return isPrivateIPv4(address);
}

/**
 * Expand a (possibly compressed, possibly IPv4-tailed) IPv6 string to
 * an 8-element array of 16-bit segments. Returns `null` on a syntactically
 * invalid input.
 *
 * Exported for the test suite and as a defensive structural check
 * used by {@link isPrivateIPv6}; treat as package-internal.
 */
export function expandIPv6(ip: string): number[] | null {
  let work = ip;
  let v4Tail: [number, number] | null = null;

  // Detect embedded IPv4 (e.g. `::ffff:192.0.2.1`).
  const v4Match = /([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})$/.exec(work);
  if (v4Match) {
    const matched = v4Match[1] ?? "";
    const o = matched.split(".").map((s) => Number(s));
    if (o.some((x) => Number.isNaN(x) || x < 0 || x > 255)) {
      return null;
    }
    v4Tail = [((o[0] ?? 0) << 8) | (o[1] ?? 0), ((o[2] ?? 0) << 8) | (o[3] ?? 0)];
    work = work.slice(0, work.length - matched.length).replace(/:$/, "");
  }

  const parts = work.split("::");
  if (parts.length > 2) {
    return null;
  }
  const head = parts[0] !== undefined && parts[0] !== "" ? parts[0].split(":") : [];
  const tail =
    parts.length === 2 && parts[1] !== undefined && parts[1] !== "" ? parts[1].split(":") : [];
  const totalAfterHeadTail = head.length + tail.length + (v4Tail !== null ? 2 : 0);
  const missing = 8 - totalAfterHeadTail;
  if (parts.length === 2) {
    if (missing < 0) {
      return null;
    }
  } else if (missing !== 0) {
    return null;
  }
  const fill = parts.length === 2 ? new Array<string>(missing).fill("0") : [];
  const filled = [...head, ...fill, ...tail];
  const out: number[] = [];
  for (const s of filled) {
    if (!/^[0-9a-f]{0,4}$/.test(s)) {
      return null;
    }
    out.push(parseInt(s || "0", 16));
  }
  if (v4Tail) {
    out.push(v4Tail[0], v4Tail[1]);
  }
  if (out.length !== 8) {
    return null;
  }
  return out;
}
