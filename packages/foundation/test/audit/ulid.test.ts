/**
 * Tests for the embedded ulid generator.
 *
 * Coverage:
 *   - Output is 26 chars, Crockford's Base32 alphabet
 *   - Same-millisecond ulids differ (random suffix)
 *   - Lexicographic ordering follows timestamp order
 *   - Throws on out-of-range timestamps
 */

import { describe, it, expect } from "vitest";

import { ulid } from "../../src/audit/ulid.js";

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("ulid", () => {
  it("produces a 26-char Crockford Base32 string", () => {
    const id = ulid(1_700_000_000_000);
    expect(id).toMatch(CROCKFORD);
  });

  it("two ulids at the same timestamp differ in the random suffix", () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_000);
    expect(a).not.toBe(b);
    // The time prefix (first 10 chars) MAY match (same ms); the random
    // suffix (last 16 chars) is overwhelmingly likely to differ.
    expect(a.substring(10)).not.toBe(b.substring(10));
  });

  it("lexicographic order follows timestamp order", () => {
    const earlier = ulid(1_700_000_000_000);
    const later = ulid(1_700_000_001_000);
    expect(later > earlier).toBe(true);
  });

  it("throws RangeError on a negative timestamp", () => {
    expect(() => ulid(-1)).toThrow(RangeError);
  });

  it("throws RangeError on a timestamp beyond 48-bit range", () => {
    expect(() => ulid(2 ** 48 + 1)).toThrow(RangeError);
  });
});
