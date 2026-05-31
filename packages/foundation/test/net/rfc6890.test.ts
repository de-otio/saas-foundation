/**
 * Tests for RFC 6890 reserved block table.
 *
 * Verifies:
 * - Every documented block is present
 * - Spot-tests a few IPs against each block
 * - The B-E required additions are all present
 * - Property-based fuzz test: random IPs are classified
 */

import fc from "fast-check";
import { describe, it, expect } from "vitest";
import { RFC6890_IPV4_RESERVED, RFC6890_IPV6_RESERVED } from "../../src/net/rfc6890.js";
import { isIPv4InCidr } from "../../src/net/cidr.js";
import { isIpShape, isReservedIp } from "../../src/net/derive.js";

const RUN_OPTIONS = { numRuns: 1000, seed: 0xc0ffee } as const;

// ---------------------------------------------------------------------------
// Required B-E blocks
// ---------------------------------------------------------------------------

const REQUIRED_B_E_CIDRS = [
  "192.0.2.0/24", // TEST-NET-1
  "198.51.100.0/24", // TEST-NET-2
  "203.0.113.0/24", // TEST-NET-3
  "240.0.0.0/4", // Class E
  "255.255.255.255/32", // Limited broadcast
];

describe("RFC6890_IPV4_RESERVED — B-E required blocks", () => {
  for (const cidr of REQUIRED_B_E_CIDRS) {
    it(`contains required block ${cidr}`, () => {
      const found = RFC6890_IPV4_RESERVED.some((b) => b.cidr === cidr);
      expect(found, `Block ${cidr} must be in RFC6890_IPV4_RESERVED`).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Spot tests for each IPv4 block
// ---------------------------------------------------------------------------

const IPV4_SPOT_TESTS: Array<{ cidr: string; insideIp: string; outsideIp: string }> = [
  { cidr: "0.0.0.0/8", insideIp: "0.0.0.1", outsideIp: "1.0.0.1" },
  { cidr: "10.0.0.0/8", insideIp: "10.20.30.40", outsideIp: "11.0.0.1" },
  { cidr: "100.64.0.0/10", insideIp: "100.64.0.1", outsideIp: "100.128.0.1" },
  { cidr: "127.0.0.0/8", insideIp: "127.0.0.1", outsideIp: "128.0.0.1" },
  { cidr: "169.254.0.0/16", insideIp: "169.254.1.1", outsideIp: "169.255.0.1" },
  { cidr: "172.16.0.0/12", insideIp: "172.31.255.255", outsideIp: "172.32.0.1" },
  { cidr: "192.0.0.0/24", insideIp: "192.0.0.1", outsideIp: "192.0.1.1" },
  { cidr: "192.0.2.0/24", insideIp: "192.0.2.1", outsideIp: "192.0.3.1" },
  { cidr: "192.168.0.0/16", insideIp: "192.168.1.1", outsideIp: "192.169.0.1" },
  { cidr: "198.18.0.0/15", insideIp: "198.18.1.1", outsideIp: "198.20.0.1" },
  { cidr: "198.51.100.0/24", insideIp: "198.51.100.1", outsideIp: "198.51.101.1" },
  { cidr: "203.0.113.0/24", insideIp: "203.0.113.1", outsideIp: "203.0.114.1" },
  { cidr: "224.0.0.0/4", insideIp: "224.0.0.1", outsideIp: "240.0.0.1" },
  { cidr: "240.0.0.0/4", insideIp: "240.0.0.1", outsideIp: "239.255.255.255" },
  { cidr: "255.255.255.255/32", insideIp: "255.255.255.255", outsideIp: "255.255.255.254" },
];

describe("RFC6890_IPV4_RESERVED — spot tests", () => {
  for (const { cidr, insideIp, outsideIp } of IPV4_SPOT_TESTS) {
    it(`${insideIp} is inside ${cidr}`, () => {
      expect(isIPv4InCidr(insideIp, cidr)).toBe(true);
    });
    it(`${outsideIp} is outside ${cidr}`, () => {
      expect(isIPv4InCidr(outsideIp, cidr)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// benchmarking comment fix: 192.0.0.0/24 is Protocol Assignments, not benchmarking
// ---------------------------------------------------------------------------

describe("RFC6890_IPV4_RESERVED — benchmarking comment correctness", () => {
  it("192.0.0.0/24 is labelled as IETF Protocol Assignments, not Benchmarking", () => {
    const protocolBlock = RFC6890_IPV4_RESERVED.find((b) => b.cidr === "192.0.0.0/24");
    expect(protocolBlock).toBeDefined();
    expect(protocolBlock?.name.toLowerCase()).not.toContain("benchmark");
  });

  it("198.18.0.0/15 is labelled as Benchmarking", () => {
    const benchBlock = RFC6890_IPV4_RESERVED.find((b) => b.cidr === "198.18.0.0/15");
    expect(benchBlock).toBeDefined();
    expect(benchBlock?.name.toLowerCase()).toContain("bench");
  });
});

// ---------------------------------------------------------------------------
// isReservedIp — property-based fuzz test
// ---------------------------------------------------------------------------

describe("isReservedIp — property-based", () => {
  // Arbitraries for each well-known reserved range
  const privateAArb = fc
    .tuple(
      fc.constant(10),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
    )
    .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

  const loopbackArb = fc
    .tuple(
      fc.constant(127),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
    )
    .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

  it("all 10.x.x.x IPs are reserved", () => {
    fc.assert(
      fc.property(privateAArb, (ip) => {
        expect(isReservedIp(ip)).toBe(true);
      }),
      RUN_OPTIONS,
    );
  });

  it("all 127.x.x.x IPs are reserved", () => {
    fc.assert(
      fc.property(loopbackArb, (ip) => {
        expect(isReservedIp(ip)).toBe(true);
      }),
      RUN_OPTIONS,
    );
  });

  it("isReservedIp returns a boolean for any IP-shaped string", () => {
    const ipArb = fc
      .tuple(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
      )
      .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

    fc.assert(
      fc.property(ipArb, (ip) => {
        const result = isReservedIp(ip);
        expect(typeof result).toBe("boolean");
        // Any valid IP shaped string must produce true or false
        if (isIpShape(ip)) {
          expect(typeof result).toBe("boolean");
        }
      }),
      RUN_OPTIONS,
    );
  });

  it("some routable IPs are NOT reserved", () => {
    // Spot-test a few routable global-scope IPs
    const routableIps = [
      "8.8.8.8", // Google DNS
      "1.1.1.1", // Cloudflare DNS
      "93.184.216.34", // example.com
    ];
    for (const ip of routableIps) {
      expect(isReservedIp(ip)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// IPv6 reserved blocks
// ---------------------------------------------------------------------------

describe("RFC6890_IPV6_RESERVED — contents", () => {
  const requiredCidrs = [
    "::1/128",
    "::/128",
    "::ffff:0:0/96",
    "2001:db8::/32",
    "fc00::/7",
    "fe80::/10",
    "ff00::/8",
  ];

  for (const cidr of requiredCidrs) {
    it(`contains block ${cidr}`, () => {
      const found = RFC6890_IPV6_RESERVED.some((b) => b.cidr === cidr);
      expect(found, `${cidr} must be in RFC6890_IPV6_RESERVED`).toBe(true);
    });
  }
});
