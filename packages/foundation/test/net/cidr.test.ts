/**
 * Tests for the CIDR helpers.
 *
 * Known-answer tests for IPv4 and IPv6 CIDR membership.
 */

import { describe, it, expect } from "vitest";
import { parseIPv4, isIPv4InCidr, parseIPv6, isIPv6InCidr } from "../../src/net/cidr.js";

// ---------------------------------------------------------------------------
// parseIPv4
// ---------------------------------------------------------------------------

describe("parseIPv4", () => {
  it("parses well-known IPs to correct integers", () => {
    expect(parseIPv4("0.0.0.0")).toBe(0);
    expect(parseIPv4("255.255.255.255")).toBe(0xffffffff);
    expect(parseIPv4("192.168.1.1")).toBe(0xc0a80101);
    expect(parseIPv4("10.0.0.1")).toBe(0x0a000001);
    expect(parseIPv4("127.0.0.1")).toBe(0x7f000001);
  });

  it("returns null for invalid inputs", () => {
    expect(parseIPv4("256.0.0.1")).toBeNull();
    expect(parseIPv4("192.168.1")).toBeNull();
    expect(parseIPv4("192.168.1.1.1")).toBeNull();
    expect(parseIPv4("")).toBeNull();
    expect(parseIPv4("abc.def.ghi.jkl")).toBeNull();
    expect(parseIPv4("1.2.3.04")).toBeNull(); // leading zero
  });
});

// ---------------------------------------------------------------------------
// isIPv4InCidr
// ---------------------------------------------------------------------------

describe("isIPv4InCidr", () => {
  it("matches exact /32 CIDR", () => {
    expect(isIPv4InCidr("10.0.0.1", "10.0.0.1/32")).toBe(true);
    expect(isIPv4InCidr("10.0.0.2", "10.0.0.1/32")).toBe(false);
  });

  it("matches /24 CIDR", () => {
    expect(isIPv4InCidr("192.168.1.1", "192.168.1.0/24")).toBe(true);
    expect(isIPv4InCidr("192.168.1.254", "192.168.1.0/24")).toBe(true);
    expect(isIPv4InCidr("192.168.2.1", "192.168.1.0/24")).toBe(false);
  });

  it("matches /8 CIDR (RFC 1918 Class A)", () => {
    expect(isIPv4InCidr("10.255.255.255", "10.0.0.0/8")).toBe(true);
    expect(isIPv4InCidr("11.0.0.1", "10.0.0.0/8")).toBe(false);
  });

  it("/0 matches everything", () => {
    expect(isIPv4InCidr("1.2.3.4", "0.0.0.0/0")).toBe(true);
    expect(isIPv4InCidr("255.255.255.255", "0.0.0.0/0")).toBe(true);
  });

  it("handles loopback", () => {
    expect(isIPv4InCidr("127.0.0.1", "127.0.0.0/8")).toBe(true);
    expect(isIPv4InCidr("127.255.255.255", "127.0.0.0/8")).toBe(true);
  });

  it("handles link-local", () => {
    expect(isIPv4InCidr("169.254.1.1", "169.254.0.0/16")).toBe(true);
    expect(isIPv4InCidr("169.255.1.1", "169.254.0.0/16")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseIPv6
// ---------------------------------------------------------------------------

describe("parseIPv6", () => {
  it("parses loopback ::1", () => {
    const bytes = parseIPv6("::1");
    expect(bytes).not.toBeNull();
    expect(bytes![15]).toBe(1);
    expect(bytes!.slice(0, 15).every((b) => b === 0)).toBe(true);
  });

  it("parses unspecified ::", () => {
    const bytes = parseIPv6("::");
    expect(bytes).not.toBeNull();
    expect(bytes!.every((b) => b === 0)).toBe(true);
  });

  it("parses a full 8-group IPv6", () => {
    const bytes = parseIPv6("2001:0db8:0000:0000:0000:0000:0000:0001");
    expect(bytes).not.toBeNull();
    expect(bytes![0]).toBe(0x20);
    expect(bytes![1]).toBe(0x01);
  });

  it("strips zone ID", () => {
    const b1 = parseIPv6("fe80::1%eth0");
    const b2 = parseIPv6("fe80::1");
    expect(b1).not.toBeNull();
    expect(b2).not.toBeNull();
    expect(b1).toEqual(b2);
  });
});

// ---------------------------------------------------------------------------
// isIPv6InCidr
// ---------------------------------------------------------------------------

describe("isIPv6InCidr", () => {
  it("matches ::1/128 exactly", () => {
    expect(isIPv6InCidr("::1", "::1/128")).toBe(true);
    expect(isIPv6InCidr("::2", "::1/128")).toBe(false);
  });

  it("matches ::/128 exactly", () => {
    expect(isIPv6InCidr("::", "::/128")).toBe(true);
    expect(isIPv6InCidr("::1", "::/128")).toBe(false);
  });

  it("matches documentation block 2001:db8::/32", () => {
    expect(isIPv6InCidr("2001:db8::1", "2001:db8::/32")).toBe(true);
    expect(isIPv6InCidr("2001:db9::1", "2001:db8::/32")).toBe(false);
  });

  it("matches unique-local fc00::/7", () => {
    expect(isIPv6InCidr("fc00::1", "fc00::/7")).toBe(true);
    expect(isIPv6InCidr("fd00::1", "fc00::/7")).toBe(true); // fd is in fc00::/7
    expect(isIPv6InCidr("fe80::1", "fc00::/7")).toBe(false);
  });

  it("/0 matches everything", () => {
    expect(isIPv6InCidr("::1", "::/0")).toBe(true);
    expect(isIPv6InCidr("2001:db8::1", "::/0")).toBe(true);
  });
});
