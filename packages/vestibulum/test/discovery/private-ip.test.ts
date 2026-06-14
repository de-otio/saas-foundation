import * as fc from "fast-check";
import { describe, it, expect } from "vitest";

import {
  expandIPv6,
  isPrivateAddress,
  isPrivateIPv4,
  isPrivateIPv6,
} from "../../src/discovery/private-ip.js";

describe("isPrivateIPv4", () => {
  describe("private ranges (must return true)", () => {
    it.each([
      // 0.0.0.0/8
      ["0.0.0.0"],
      ["0.255.255.255"],
      // 10.0.0.0/8
      ["10.0.0.0"],
      ["10.255.255.255"],
      // 127.0.0.0/8
      ["127.0.0.1"],
      ["127.255.255.255"],
      // 169.254.0.0/16 (link-local incl. IMDS)
      ["169.254.0.0"],
      ["169.254.169.254"],
      ["169.254.255.255"],
      // 172.16.0.0/12
      ["172.16.0.0"],
      ["172.20.5.6"],
      ["172.31.255.255"],
      // 192.0.0.0/24 IETF protocol assignments and the trellis
      // reference impl treats the whole 192.0.x.x block as
      // non-routable (covers TEST-NET-1 192.0.2.0/24 also).
      ["192.0.0.0"],
      ["192.0.0.255"],
      ["192.0.1.0"],
      ["192.0.2.1"],
      // 192.168.0.0/16
      ["192.168.0.0"],
      ["192.168.1.1"],
      ["192.168.255.255"],
      // 198.18.0.0/15
      ["198.18.0.0"],
      ["198.19.255.255"],
      // 100.64.0.0/10 (CGNAT)
      ["100.64.0.0"],
      ["100.127.255.255"],
      // 224.0.0.0/4 (multicast)
      ["224.0.0.1"],
      ["239.255.255.255"],
      // 240.0.0.0/4 (reserved)
      ["240.0.0.0"],
      ["255.255.255.255"],
    ])("classifies %s as private", (ip) => {
      expect(isPrivateIPv4(ip)).toBe(true);
    });
  });

  describe("public ranges (must return false)", () => {
    it.each([
      ["1.1.1.1"],
      ["8.8.8.8"],
      ["9.255.255.255"],
      ["11.0.0.0"],
      ["126.255.255.255"],
      ["128.0.0.0"],
      ["172.15.255.255"],
      ["172.32.0.0"],
      ["100.63.255.255"],
      ["100.128.0.0"],
      ["198.17.255.255"],
      ["198.20.0.0"],
      ["223.255.255.255"],
      ["169.253.255.255"],
      ["169.255.0.0"],
      ["192.1.0.0"],
      ["192.167.255.255"],
      ["192.169.0.0"],
    ])("classifies %s as public", (ip) => {
      expect(isPrivateIPv4(ip)).toBe(false);
    });
  });

  describe("malformed input fails closed (returns true)", () => {
    it.each([
      [""],
      ["not-an-ip"],
      ["1.2.3"],
      ["1.2.3.4.5"],
      ["256.0.0.0"],
      ["1.2.3.999"],
      ["-1.2.3.4"],
      ["1.2.3.4 "],
      ["::1"], // an IPv6 literal is not a v4 address
      ["1234.0.0.0"],
    ])("classifies malformed input %p as private", (ip) => {
      expect(isPrivateIPv4(ip)).toBe(true);
    });
  });
});

describe("isPrivateIPv6", () => {
  describe("private ranges (must return true)", () => {
    it.each([
      // Loopback / unspecified.
      ["::1"],
      ["::"],
      ["0000:0000:0000:0000:0000:0000:0000:0001"],
      // fc00::/7 (unique local).
      ["fc00::"],
      ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
      ["fcab::1"],
      // fe80::/10 (link-local).
      ["fe80::"],
      ["febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
      ["fe80::1"],
      // ff00::/8 (multicast).
      ["ff00::1"],
      ["ffff::1"],
      // Documentation prefix.
      ["2001:db8::"],
      ["2001:db8:0:0:0:0:0:1"],
      ["2001:db8:ffff:ffff:ffff:ffff:ffff:ffff"],
      // IPv4-mapped -> applies v4 rules.
      ["::ffff:127.0.0.1"],
      ["::ffff:169.254.169.254"],
      ["::ffff:10.0.0.1"],
      ["::ffff:192.168.1.1"],
      // Zone-id is stripped before classification.
      ["fe80::1%eth0"],
      // Upper-case acceptable.
      ["FE80::1"],
    ])("classifies %s as private", (ip) => {
      expect(isPrivateIPv6(ip)).toBe(true);
    });
  });

  describe("public ranges (must return false)", () => {
    it.each([
      ["2001:4860:4860::8888"], // Google DNS
      ["2606:4700:4700::1111"], // Cloudflare DNS
      // IPv4-mapped to a public v4.
      ["::ffff:1.1.1.1"],
      ["::ffff:8.8.8.8"],
      // Not in fc00::/7 -- fbff is BEFORE the prefix.
      ["fbff::"],
      // Not in fe80::/10 -- fec0 falls outside the /10 (mask 0xffc0).
      ["fec0::1"],
      // Not in ff00::/8 -- feff falls outside.
      ["feff:ffff::1"],
      // 2001:db9::/32 is NOT documentation.
      ["2001:db9::1"],
    ])("classifies %s as public", (ip) => {
      expect(isPrivateIPv6(ip)).toBe(false);
    });
  });

  describe("malformed input fails closed (returns true)", () => {
    it.each([
      [""],
      ["1.2.3.4"], // v4, not v6
      ["gibberish"],
      ["xxxx::1"], // not hex
      ["1:2:3:4:5:6:7"], // too few parts
      ["1:2:3:4:5:6:7:8:9"], // too many parts
      ["1::2::3"], // multiple ::
      ["::ffff:256.0.0.1"], // invalid embedded v4
      ["::g"], // non-hex char
      ["12345::"], // segment > 4 hex chars
      ["::ffff:1.2.3"], // bad embedded v4
    ])("classifies malformed input %p as private", (ip) => {
      expect(isPrivateIPv6(ip)).toBe(true);
    });
  });
});

describe("isPrivateAddress", () => {
  it("routes v4 strings to isPrivateIPv4", () => {
    expect(isPrivateAddress("10.0.0.1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });

  it("routes v6 strings to isPrivateIPv6", () => {
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("2001:4860:4860::8888")).toBe(false);
  });
});

describe("expandIPv6", () => {
  it("expands the canonical loopback", () => {
    expect(expandIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it("expands the unspecified address", () => {
    expect(expandIPv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("expands a fully written address", () => {
    expect(expandIPv6("2001:db8:0:0:0:0:0:1")).toEqual([0x2001, 0x0db8, 0, 0, 0, 0, 0, 1]);
  });

  it("expands IPv4-mapped form", () => {
    expect(expandIPv6("::ffff:192.0.2.1")).toEqual([
      0,
      0,
      0,
      0,
      0,
      0xffff,
      (192 << 8) | 0,
      (2 << 8) | 1,
    ]);
  });

  it("returns null for too-many-segments", () => {
    expect(expandIPv6("1:2:3:4:5:6:7:8:9")).toBeNull();
  });

  it("returns null for non-hex segment", () => {
    expect(expandIPv6("1::g")).toBeNull();
  });

  it("returns null for invalid IPv4 tail", () => {
    expect(expandIPv6("::ffff:300.0.0.1")).toBeNull();
  });

  it("returns null for too-long hex segment", () => {
    expect(expandIPv6("12345::")).toBeNull();
  });

  it("returns null for no-double-colon-but-too-few-segments", () => {
    expect(expandIPv6("1:2:3:4:5:6:7")).toBeNull();
  });

  it("returns null for double :: (would parse as 3-way split)", () => {
    expect(expandIPv6("1::2::3")).toBeNull();
  });

  it("returns null when compressed form has head+tail > 8 segments", () => {
    expect(expandIPv6("1:2:3:4:5:6:7:8::9")).toBeNull();
  });

  it("returns null when no :: but embedded v4 leaves wrong segment count", () => {
    // 8 hex segments + a v4 tail = 9 16-bit groups: invalid.
    expect(expandIPv6("1:2:3:4:5:6:7:8:1.2.3.4")).toBeNull();
  });
});

describe('property: arbitrary IPv4 strings never produce a "public" classification for documented private ranges', () => {
  it("every IP in 10.0.0.0/8 is private", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (b, c, d) => {
          const ip = `10.${b}.${c}.${d}`;
          expect(isPrivateIPv4(ip)).toBe(true);
        },
      ),
    );
  });

  it("every IP in 127.0.0.0/8 is private", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (b, c, d) => {
          const ip = `127.${b}.${c}.${d}`;
          expect(isPrivateIPv4(ip)).toBe(true);
        },
      ),
    );
  });

  it("every IP in 169.254.0.0/16 is private (covers IMDS)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), (c, d) => {
        const ip = `169.254.${c}.${d}`;
        expect(isPrivateIPv4(ip)).toBe(true);
      }),
    );
  });

  it("every IP in 192.168.0.0/16 is private", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), (c, d) => {
        const ip = `192.168.${c}.${d}`;
        expect(isPrivateIPv4(ip)).toBe(true);
      }),
    );
  });

  it("every IP in 172.16.0.0/12 is private", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 16, max: 31 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (b, c, d) => {
          const ip = `172.${b}.${c}.${d}`;
          expect(isPrivateIPv4(ip)).toBe(true);
        },
      ),
    );
  });

  it("every IP in 100.64.0.0/10 is private", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 64, max: 127 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (b, c, d) => {
          const ip = `100.${b}.${c}.${d}`;
          expect(isPrivateIPv4(ip)).toBe(true);
        },
      ),
    );
  });

  it("every multicast IP (first octet >= 224) is private", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 224, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (a, b, c, d) => {
          const ip = `${a}.${b}.${c}.${d}`;
          expect(isPrivateIPv4(ip)).toBe(true);
        },
      ),
    );
  });

  it("every IP outside any private range is public", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 223 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (a, b, c, d) => {
          // Skip every documented private range.
          if (a === 0) return;
          if (a === 10) return;
          if (a === 127) return;
          if (a === 169 && b === 254) return;
          if (a === 172 && b >= 16 && b <= 31) return;
          if (a === 192 && b === 0) return;
          // (TEST-NET-1 192.0.2.0/24 is also covered by the
          // 192.0.x.x branch in the classifier.)
          if (a === 192 && b === 168) return;
          if (a === 198 && (b === 18 || b === 19)) return;
          // TEST-NET-2 (198.51.100.0/24) and TEST-NET-3
          // (203.0.113.0/24) — B-E required additions.
          if (a === 198 && b === 51 && c === 100) return;
          if (a === 203 && b === 0 && c === 113) return;
          if (a === 100 && b >= 64 && b <= 127) return;
          const ip = `${a}.${b}.${c}.${d}`;
          expect(isPrivateIPv4(ip)).toBe(false);
        },
      ),
    );
  });
});

describe("property: arbitrary garbage never produces a public classification", () => {
  it("random non-IP strings are classified as private (v4 path)", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 30 }), (s) => {
        // Skip syntactically-valid v4 -- that's the public-ranges test's job.
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s)) return;
        // Skip strings containing ':' -- those route to the v6 path.
        if (s.includes(":")) return;
        expect(isPrivateIPv4(s)).toBe(true);
      }),
    );
  });

  it("random colon-containing strings that are not valid v6 are private", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 30 }), (s) => {
        if (!s.includes(":")) return;
        // Try to expand; if it parses fine we skip (it might be a
        // public v6 literal).
        const expanded = expandIPv6(s.toLowerCase().split("%")[0]!);
        if (expanded) return;
        expect(isPrivateIPv6(s)).toBe(true);
      }),
    );
  });
});
