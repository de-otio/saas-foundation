/**
 * CIDR membership helpers for IPv4 and IPv6.
 *
 * No external dependencies — pure bitmath.
 * All functions are pure (no side effects).
 */

// ---------------------------------------------------------------------------
// IPv4 helpers
// ---------------------------------------------------------------------------

/**
 * Parse an IPv4 dotted-quad string to a 32-bit unsigned integer.
 * Returns `null` if the string is not a valid dotted-quad.
 *
 * Pure.
 */
export function parseIPv4(s: string): number | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    // Reject empty or non-numeric
    if (part === "" || !/^\d+$/.test(part)) return null;
    // Reject leading zeros (octal-ambiguous: "04" !== "4" semantically)
    if (part.length > 1 && part[0] === "0") return null;
    const n = Number(part);
    if (n < 0 || n > 255 || !Number.isInteger(n)) return null;
    result = (result << 8) | n;
  }
  // Convert to unsigned 32-bit
  return result >>> 0;
}

/**
 * Returns true if `ip` (parsed IPv4 integer) is inside `networkInt/prefixLen`.
 *
 * Pure.
 */
export function ipv4InCidr(ip: number, networkInt: number, prefixLen: number): boolean {
  if (prefixLen === 0) return true;
  if (prefixLen === 32) return ip === networkInt;
  const mask = (~0 << (32 - prefixLen)) >>> 0;
  return (ip & mask) === (networkInt & mask);
}

/**
 * Returns true if the IPv4 string `ip` falls within the CIDR `network/prefix`.
 * Both `ip` and the `network` part of the CIDR must be valid IPv4 dotted-quads.
 *
 * Pure.
 */
export function isIPv4InCidr(ip: string, cidr: string): boolean {
  const slashIdx = cidr.indexOf("/");
  if (slashIdx === -1) return false;

  const networkStr = cidr.slice(0, slashIdx);
  const prefixStr = cidr.slice(slashIdx + 1);
  const prefixLen = Number(prefixStr);

  if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 32) return false;

  const ipInt = parseIPv4(ip);
  const networkInt = parseIPv4(networkStr);
  if (ipInt === null || networkInt === null) return false;

  return ipv4InCidr(ipInt, networkInt, prefixLen);
}

// ---------------------------------------------------------------------------
// IPv6 helpers
// ---------------------------------------------------------------------------

/**
 * Expand a compressed IPv6 string to a full 128-bit array (16 bytes).
 * Returns `null` on parse failure.
 *
 * Handles:
 * - `::` expansion
 * - IPv4-mapped forms (e.g., `::ffff:192.0.2.1`)
 * - Zone identifiers are stripped (e.g., `fe80::1%eth0`)
 *
 * Pure.
 */
export function parseIPv6(s: string): Uint8Array | null {
  // Strip zone ID
  const zoneIdx = s.indexOf("%");
  const addr = zoneIdx !== -1 ? s.slice(0, zoneIdx) : s;

  // Split on ::
  const doubleColonIdx = addr.indexOf("::");
  let hi: string[];
  let lo: string[];

  if (doubleColonIdx === -1) {
    hi = addr.split(":");
    lo = [];
  } else {
    hi = addr
      .slice(0, doubleColonIdx)
      .split(":")
      .filter((x) => x !== "");
    lo = addr
      .slice(doubleColonIdx + 2)
      .split(":")
      .filter((x) => x !== "");
  }

  // Handle IPv4-mapped in the last group
  let ipv4Bytes: Uint8Array | null = null;
  const allGroups = [...hi, ...lo];
  const lastGroup = allGroups[allGroups.length - 1];

  if (lastGroup !== undefined && lastGroup.includes(".")) {
    // Remove the IPv4 part from lo/hi
    if (lo.length > 0 && lo[lo.length - 1]?.includes(".") === true) {
      lo = lo.slice(0, lo.length - 1);
    } else if (hi.length > 0 && hi[hi.length - 1]?.includes(".") === true) {
      hi = hi.slice(0, hi.length - 1);
    }
    ipv4Bytes = new Uint8Array(4);
    const ipv4Parts = lastGroup.split(".");
    if (ipv4Parts.length !== 4) return null;
    for (let i = 0; i < 4; i++) {
      const n = Number(ipv4Parts[i]);
      if (!Number.isInteger(n) || n < 0 || n > 255) return null;
      ipv4Bytes[i] = n;
    }
  }

  // Determine expected number of 16-bit groups
  const ipv4GroupCount = ipv4Bytes !== null ? 2 : 0;
  const totalGroups = 8;
  const fillerCount =
    doubleColonIdx !== -1 ? totalGroups - hi.length - lo.length - ipv4GroupCount : 0;

  if (fillerCount < 0) return null;
  if (doubleColonIdx === -1 && hi.length + ipv4GroupCount !== totalGroups) return null;

  const bytes = new Uint8Array(16);
  let byteIdx = 0;

  const writeGroup = (hexStr: string): boolean => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(hexStr)) return false;
    const val = parseInt(hexStr, 16);
    bytes[byteIdx++] = (val >> 8) & 0xff;
    bytes[byteIdx++] = val & 0xff;
    return true;
  };

  for (const g of hi) {
    if (!writeGroup(g)) return null;
  }
  for (let i = 0; i < fillerCount; i++) {
    bytes[byteIdx++] = 0;
    bytes[byteIdx++] = 0;
  }
  for (const g of lo) {
    if (!writeGroup(g)) return null;
  }
  if (ipv4Bytes !== null) {
    bytes[byteIdx++] = ipv4Bytes[0] ?? 0;
    bytes[byteIdx++] = ipv4Bytes[1] ?? 0;
    bytes[byteIdx++] = ipv4Bytes[2] ?? 0;
    bytes[byteIdx++] = ipv4Bytes[3] ?? 0;
  }

  if (byteIdx !== 16) return null;
  return bytes;
}

/**
 * Returns true if `ipBytes` falls within `network/prefixLen` (IPv6).
 *
 * Pure.
 */
export function ipv6InCidr(
  ipBytes: Uint8Array,
  networkBytes: Uint8Array,
  prefixLen: number,
): boolean {
  if (prefixLen === 0) return true;

  const fullBytes = Math.floor(prefixLen / 8);
  const remainingBits = prefixLen % 8;

  for (let i = 0; i < fullBytes; i++) {
    if ((ipBytes[i] ?? 0) !== (networkBytes[i] ?? 0)) return false;
  }

  if (remainingBits > 0) {
    const mask = 0xff & (0xff << (8 - remainingBits));
    if (((ipBytes[fullBytes] ?? 0) & mask) !== ((networkBytes[fullBytes] ?? 0) & mask)) {
      return false;
    }
  }

  return true;
}

/**
 * Returns true if the IPv6 string `ip` falls within the CIDR `network/prefix`.
 *
 * Pure.
 */
export function isIPv6InCidr(ip: string, cidr: string): boolean {
  const slashIdx = cidr.indexOf("/");
  if (slashIdx === -1) return false;

  const networkStr = cidr.slice(0, slashIdx);
  const prefixStr = cidr.slice(slashIdx + 1);
  const prefixLen = Number(prefixStr);

  if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 128) return false;

  const ipBytes = parseIPv6(ip);
  const networkBytes = parseIPv6(networkStr);
  if (ipBytes === null || networkBytes === null) return false;

  return ipv6InCidr(ipBytes, networkBytes, prefixLen);
}
