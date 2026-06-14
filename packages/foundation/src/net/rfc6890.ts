/**
 * RFC 6890 reserved address blocks for IPv4 and IPv6.
 *
 * Per B-E: The following five blocks were missing from earlier drafts and
 * MUST be included:
 *   - 192.0.2.0/24    (TEST-NET-1, RFC 5737)
 *   - 198.51.100.0/24 (TEST-NET-2, RFC 5737)
 *   - 203.0.113.0/24  (TEST-NET-3, RFC 5737)
 *   - 240.0.0.0/4     (Class E reserved, RFC 1112)
 *   - 255.255.255.255/32 (limited broadcast, RFC 919)
 *
 * Per B-E (benchmarking comment fix):
 *   - 192.0.0.0/24 is IETF Protocol Assignments (NOT benchmarking)
 *   - 198.18.0.0/15 is Benchmarking (RFC 2544)
 *
 * All entries are pure data. No side effects.
 */

/** An entry in the reserved-block table. */
export interface ReservedBlock {
  /** Human-readable name for the block. */
  readonly name: string;
  /** CIDR notation. */
  readonly cidr: string;
  /** Reference document. */
  readonly rfc: string;
}

/**
 * IPv4 reserved blocks. Includes all RFC 6890 entries plus the five
 * blocks required by B-E.
 *
 * This list is intentionally exhaustive — an IP library would remove the
 * maintenance burden, but the list is short enough (~20 entries) to own
 * inline, and the explicit list is auditable.
 */
export const RFC6890_IPV4_RESERVED: ReadonlyArray<ReservedBlock> = Object.freeze([
  { name: "This host on this network", cidr: "0.0.0.0/8", rfc: "RFC 1122" },
  {
    name: "Private-Use (Class A)",
    cidr: "10.0.0.0/8",
    rfc: "RFC 1918",
  },
  {
    name: "Shared Address Space",
    cidr: "100.64.0.0/10",
    rfc: "RFC 6598",
  },
  {
    name: "Loopback",
    cidr: "127.0.0.0/8",
    rfc: "RFC 1122",
  },
  {
    name: "Link Local",
    cidr: "169.254.0.0/16",
    rfc: "RFC 3927",
  },
  {
    name: "Private-Use (Class B)",
    cidr: "172.16.0.0/12",
    rfc: "RFC 1918",
  },
  {
    name: "IETF Protocol Assignments",
    cidr: "192.0.0.0/24",
    rfc: "RFC 6890",
  },
  {
    // TEST-NET-1 — B-E required addition
    name: "Documentation (TEST-NET-1)",
    cidr: "192.0.2.0/24",
    rfc: "RFC 5737",
  },
  {
    name: "Private-Use (Class C)",
    cidr: "192.168.0.0/16",
    rfc: "RFC 1918",
  },
  {
    // Benchmarking — note: 192.0.0.0/24 is Protocol Assignments (different block)
    name: "Benchmarking",
    cidr: "198.18.0.0/15",
    rfc: "RFC 2544",
  },
  {
    // TEST-NET-2 — B-E required addition
    name: "Documentation (TEST-NET-2)",
    cidr: "198.51.100.0/24",
    rfc: "RFC 5737",
  },
  {
    // TEST-NET-3 — B-E required addition
    name: "Documentation (TEST-NET-3)",
    cidr: "203.0.113.0/24",
    rfc: "RFC 5737",
  },
  {
    name: "Multicast",
    cidr: "224.0.0.0/4",
    rfc: "RFC 1112",
  },
  {
    // Class E — B-E required addition
    name: "Reserved (Class E)",
    cidr: "240.0.0.0/4",
    rfc: "RFC 1112",
  },
  {
    // Limited broadcast — B-E required addition
    name: "Limited Broadcast",
    cidr: "255.255.255.255/32",
    rfc: "RFC 919",
  },
]);

/**
 * IPv6 reserved blocks.
 */
export const RFC6890_IPV6_RESERVED: ReadonlyArray<ReservedBlock> = Object.freeze([
  { name: "Loopback", cidr: "::1/128", rfc: "RFC 4291" },
  { name: "Unspecified", cidr: "::/128", rfc: "RFC 4291" },
  { name: "IPv4-mapped", cidr: "::ffff:0:0/96", rfc: "RFC 4291" },
  { name: "IPv4-compatible (deprecated)", cidr: "::/96", rfc: "RFC 4291" },
  { name: "Discard", cidr: "100::/64", rfc: "RFC 6666" },
  { name: "IETF Protocol Assignments", cidr: "2001::/23", rfc: "RFC 2928" },
  { name: "Teredo", cidr: "2001::/32", rfc: "RFC 4380" },
  { name: "Benchmarking", cidr: "2001:2::/48", rfc: "RFC 5180" },
  { name: "Documentation (2001:db8::)", cidr: "2001:db8::/32", rfc: "RFC 3849" },
  { name: "6to4", cidr: "2002::/16", rfc: "RFC 3056" },
  { name: "Unique Local", cidr: "fc00::/7", rfc: "RFC 4193" },
  { name: "Link-Scoped Unicast", cidr: "fe80::/10", rfc: "RFC 4291" },
  { name: "Multicast", cidr: "ff00::/8", rfc: "RFC 4291" },
]);

/** Union of all reserved blocks for consumers that need to iterate both. */
export const RFC6890_ALL_RESERVED: ReadonlyArray<ReservedBlock> = Object.freeze([
  ...RFC6890_IPV4_RESERVED,
  ...RFC6890_IPV6_RESERVED,
]);
