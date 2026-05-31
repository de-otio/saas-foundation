/**
 * Tests for trustedClientIp and isIpShape.
 *
 * Verifies:
 * - Happy path: each trust mode returns the expected IP
 * - Reserved IPs are rejected (returned as 'unknown')
 * - Malformed headers are rejected
 * - Empty/missing header returns 'unknown'
 * - isIpShape shape validation
 */

import { describe, it, expect } from "vitest";
import {
  trustedClientIp,
  isIpShape,
  isReservedIp,
  anonymizeIpPartial,
  IpAnonymizer,
} from "../../src/net/derive.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRequest(headers: Record<string, string> = {}, socketRemoteAddress?: string): Request {
  const req = new Request("https://example.com/", { headers });
  if (socketRemoteAddress !== undefined) {
    // Attach a fake socket the way Node's HTTP layer does
    Object.defineProperty(req, "socket", {
      value: { remoteAddress: socketRemoteAddress },
      writable: false,
      configurable: true,
    });
  }
  return req;
}

// ---------------------------------------------------------------------------
// isIpShape
// ---------------------------------------------------------------------------

describe("isIpShape", () => {
  it("accepts valid IPv4 dotted-quads", () => {
    expect(isIpShape("0.0.0.0")).toBe(true);
    expect(isIpShape("255.255.255.255")).toBe(true);
    expect(isIpShape("192.168.1.1")).toBe(true);
    expect(isIpShape("1.2.3.4")).toBe(true);
  });

  it("rejects IPv4 with out-of-range octets", () => {
    expect(isIpShape("256.0.0.1")).toBe(false);
    expect(isIpShape("0.0.0.256")).toBe(false);
  });

  it("rejects malformed IPv4", () => {
    expect(isIpShape("1.2.3")).toBe(false);
    expect(isIpShape("1.2.3.4.5")).toBe(false);
    expect(isIpShape("abc.def.ghi.jkl")).toBe(false);
    expect(isIpShape("")).toBe(false);
  });

  it("accepts valid IPv6", () => {
    expect(isIpShape("::1")).toBe(true);
    expect(isIpShape("::")).toBe(true);
    expect(isIpShape("2001:db8::1")).toBe(true);
    expect(isIpShape("fe80::1%eth0")).toBe(true);
  });

  it("rejects strings with SQL injection chars", () => {
    expect(isIpShape("1.2.3.4; DROP TABLE users")).toBe(false);
    expect(isIpShape("1.2.3.4\nX-Injected: true")).toBe(false);
  });

  it("rejects strings over 64 characters", () => {
    expect(isIpShape("a".repeat(65))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isReservedIp
// ---------------------------------------------------------------------------

describe("isReservedIp", () => {
  it("identifies all RFC 1918 private ranges", () => {
    expect(isReservedIp("10.0.0.1")).toBe(true);
    expect(isReservedIp("172.16.0.1")).toBe(true);
    expect(isReservedIp("172.31.255.255")).toBe(true);
    expect(isReservedIp("192.168.1.1")).toBe(true);
  });

  it("identifies loopback", () => {
    expect(isReservedIp("127.0.0.1")).toBe(true);
    expect(isReservedIp("127.255.255.255")).toBe(true);
  });

  it("identifies link-local", () => {
    expect(isReservedIp("169.254.1.1")).toBe(true);
  });

  it("identifies TEST-NET blocks (B-E additions)", () => {
    expect(isReservedIp("192.0.2.1")).toBe(true); // TEST-NET-1
    expect(isReservedIp("198.51.100.1")).toBe(true); // TEST-NET-2
    expect(isReservedIp("203.0.113.1")).toBe(true); // TEST-NET-3
  });

  it("identifies Class E reserved", () => {
    expect(isReservedIp("240.0.0.1")).toBe(true);
    expect(isReservedIp("255.255.255.254")).toBe(true);
  });

  it("identifies limited broadcast", () => {
    expect(isReservedIp("255.255.255.255")).toBe(true);
  });

  it("returns false for routable IPs", () => {
    expect(isReservedIp("8.8.8.8")).toBe(false);
    expect(isReservedIp("1.1.1.1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// trustedClientIp — mode: none
// ---------------------------------------------------------------------------

describe("trustedClientIp — mode: none", () => {
  it("returns socket remote address when available and routable", () => {
    const req = makeRequest({}, "1.2.3.4");
    expect(trustedClientIp(req, { mode: "none" })).toBe("1.2.3.4");
  });

  it("returns unknown when socket address is absent", () => {
    const req = makeRequest();
    expect(trustedClientIp(req, { mode: "none" })).toBe("unknown");
  });

  it("returns unknown when socket address is a private IP", () => {
    const req = makeRequest({}, "10.0.0.1");
    expect(trustedClientIp(req, { mode: "none" })).toBe("unknown");
  });

  it("ignores XFF header in none mode", () => {
    const req = makeRequest({ "X-Forwarded-For": "1.2.3.4" });
    // No socket, so unknown
    expect(trustedClientIp(req, { mode: "none" })).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// trustedClientIp — mode: alb
// ---------------------------------------------------------------------------

describe("trustedClientIp — mode: alb", () => {
  it("returns the rightmost XFF entry (ALB-appended client)", () => {
    const req = makeRequest({
      "X-Forwarded-For": "1.2.3.4, 5.6.7.8",
    });
    expect(trustedClientIp(req, { mode: "alb" })).toBe("5.6.7.8");
  });

  it("returns the sole entry when XFF has one IP", () => {
    const req = makeRequest({ "X-Forwarded-For": "8.8.8.8" });
    expect(trustedClientIp(req, { mode: "alb" })).toBe("8.8.8.8");
  });

  it("returns unknown when XFF is absent", () => {
    const req = makeRequest();
    expect(trustedClientIp(req, { mode: "alb" })).toBe("unknown");
  });

  it("returns unknown when all XFF entries are private", () => {
    const req = makeRequest({
      "X-Forwarded-For": "192.168.1.1, 10.0.0.1",
    });
    expect(trustedClientIp(req, { mode: "alb" })).toBe("unknown");
  });

  it("returns unknown when XFF contains malformed IP", () => {
    const req = makeRequest({ "X-Forwarded-For": "not-an-ip" });
    expect(trustedClientIp(req, { mode: "alb" })).toBe("unknown");
  });

  it("returns unknown for TEST-NET-1 (SSRF prevention, B-E)", () => {
    const req = makeRequest({ "X-Forwarded-For": "192.0.2.1" });
    expect(trustedClientIp(req, { mode: "alb" })).toBe("unknown");
  });

  it("returns unknown for TEST-NET-2 (SSRF prevention, B-E)", () => {
    const req = makeRequest({ "X-Forwarded-For": "198.51.100.1" });
    expect(trustedClientIp(req, { mode: "alb" })).toBe("unknown");
  });

  it("returns unknown for limited broadcast (B-E)", () => {
    const req = makeRequest({ "X-Forwarded-For": "255.255.255.255" });
    expect(trustedClientIp(req, { mode: "alb" })).toBe("unknown");
  });

  it("trims whitespace from XFF entries", () => {
    const req = makeRequest({ "X-Forwarded-For": "  1.2.3.4  ,  8.8.8.8  " });
    expect(trustedClientIp(req, { mode: "alb" })).toBe("8.8.8.8");
  });
});

// ---------------------------------------------------------------------------
// trustedClientIp — mode: cloudflare
// ---------------------------------------------------------------------------

describe("trustedClientIp — mode: cloudflare", () => {
  it("returns CF-Connecting-IP value when valid", () => {
    const req = makeRequest({ "CF-Connecting-IP": "8.8.8.8" });
    expect(trustedClientIp(req, { mode: "cloudflare" })).toBe("8.8.8.8");
  });

  it("returns unknown when CF-Connecting-IP is absent", () => {
    const req = makeRequest();
    expect(trustedClientIp(req, { mode: "cloudflare" })).toBe("unknown");
  });

  it("returns unknown when CF-Connecting-IP is a private IP", () => {
    const req = makeRequest({ "CF-Connecting-IP": "192.168.1.1" });
    expect(trustedClientIp(req, { mode: "cloudflare" })).toBe("unknown");
  });

  it("returns unknown for TEST-NET-3 (SSRF prevention, B-E)", () => {
    const req = makeRequest({ "CF-Connecting-IP": "203.0.113.1" });
    expect(trustedClientIp(req, { mode: "cloudflare" })).toBe("unknown");
  });

  it("trims whitespace from CF-Connecting-IP", () => {
    const req = makeRequest({ "CF-Connecting-IP": "  1.2.3.4  " });
    expect(trustedClientIp(req, { mode: "cloudflare" })).toBe("1.2.3.4");
  });
});

// ---------------------------------------------------------------------------
// anonymizeIpPartial
// ---------------------------------------------------------------------------

describe("anonymizeIpPartial", () => {
  it("zeros the last IPv4 octet", () => {
    expect(anonymizeIpPartial("192.168.1.42")).toBe("192.168.1.0");
    expect(anonymizeIpPartial("8.8.8.8")).toBe("8.8.8.0");
  });

  it("passes through empty string unchanged", () => {
    expect(anonymizeIpPartial("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// IpAnonymizer
// ---------------------------------------------------------------------------

describe("IpAnonymizer", () => {
  it("level none returns the IP as-is", () => {
    const anonymizer = new IpAnonymizer({ defaultLevel: "none" });
    expect(anonymizer.anonymize("1.2.3.4")).toBe("1.2.3.4");
  });

  it("level partial truncates last octet", () => {
    const anonymizer = new IpAnonymizer({ defaultLevel: "partial" });
    expect(anonymizer.anonymize("1.2.3.4")).toBe("1.2.3.0");
  });

  it("level hash requires hashSalt", () => {
    const anonymizer = new IpAnonymizer();
    expect(() => anonymizer.anonymize("1.2.3.4", "hash")).toThrow();
  });

  it("level hash with salt returns hashed:v1:... prefix", () => {
    const anonymizer = new IpAnonymizer({ hashSalt: "test-salt" });
    const result = anonymizer.anonymize("1.2.3.4", "hash");
    expect(result.startsWith("hashed:v1:")).toBe(true);
  });

  it("hash result is deterministic", () => {
    const anonymizer = new IpAnonymizer({ hashSalt: "test-salt" });
    const a = anonymizer.anonymize("1.2.3.4", "hash");
    const b = anonymizer.anonymize("1.2.3.4", "hash");
    expect(a).toBe(b);
  });

  it("hash result differs for different IPs", () => {
    const anonymizer = new IpAnonymizer({ hashSalt: "test-salt" });
    const a = anonymizer.anonymize("1.2.3.4", "hash");
    const b = anonymizer.anonymize("5.6.7.8", "hash");
    expect(a).not.toBe(b);
  });

  it("per-call level override takes precedence over default", () => {
    const anonymizer = new IpAnonymizer({ defaultLevel: "none" });
    expect(anonymizer.anonymize("1.2.3.4", "partial")).toBe("1.2.3.0");
  });
});
