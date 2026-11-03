/**
 * U18 — one address normaliser, applied before any Cognito call.
 *
 * Properties (fast-check): idempotent; output is lower-case; case and
 * surrounding-whitespace variants of one address normalise equal; anything that
 * cannot be an address is rejected for every caller alike.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  MAX_EMAIL_LENGTH,
  normalizeEmail,
} from "../../../src/lambda/shared/normalize-email.js";

/** ASCII local parts and domains: case mapping is invertible here (ß -> SS is not). */
const localPart = fc.stringMatching(/^[A-Za-z0-9._%+-]{1,20}$/);
const domain = fc.stringMatching(/^[A-Za-z0-9-]{1,12}(\.[A-Za-z]{2,6}){1,2}$/);
const address = fc.tuple(localPart, domain).map(([l, d]) => `${l}@${d}`);

const padding = fc.constantFrom("", " ", "\t", "\n", "\r\n", "\u00a0", "\u2003", " \u00a0 ");

/** Randomly flips the case of each ASCII letter of `s`. */
const caseVariant = (s: string) =>
  fc.array(fc.boolean(), { minLength: s.length, maxLength: s.length }).map((flips) =>
    [...s].map((c, i) => (flips[i] === true ? c.toUpperCase() : c.toLowerCase())).join(""),
  );

describe("normalizeEmail (U18)", () => {
  it("lower-cases and trims a typical address", () => {
    expect(normalizeEmail("  Person@Example.COM \n")).toBe("person@example.com");
  });

  it("does not strip a +tag: the person typed their address", () => {
    expect(normalizeEmail("Person+Tag@example.com")).toBe("person+tag@example.com");
  });

  it("composes to NFC (a decomposed é and a precomposed é are one address)", () => {
    expect(normalizeEmail("rémy@example.com")).toBe(normalizeEmail("rémy@example.com"));
    expect(normalizeEmail("rémy@example.com")).toBe("rémy@example.com");
  });

  it("P: idempotent for any string", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (raw) => {
        const once = normalizeEmail(raw);
        if (once !== undefined) expect(normalizeEmail(once)).toBe(once);
      }),
      { numRuns: 500 },
    );
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 40 }), fc.string({ maxLength: 20 }), (l, d) => {
        const once = normalizeEmail(`${l}@${d}`);
        if (once !== undefined) expect(normalizeEmail(once)).toBe(once);
      }),
      { numRuns: 500 },
    );
  });

  it("P: the output is lower-case (and valid input is never rejected)", () => {
    fc.assert(
      fc.property(address, (a) => {
        const out = normalizeEmail(a);
        expect(out).toBeDefined();
        expect(out).toBe(out!.toLowerCase());
      }),
      { numRuns: 300 },
    );
  });

  it("P: case and surrounding-whitespace variants of one address normalise equal", () => {
    fc.assert(
      fc.property(
        address.chain((a) => fc.tuple(fc.constant(a), caseVariant(a), padding, padding)),
        ([a, variant, left, right]) => {
          expect(normalizeEmail(`${left}${variant}${right}`)).toBe(normalizeEmail(a));
        },
      ),
      { numRuns: 300 },
    );
  });

  describe("rejects (undefined) what cannot be an address, the same for every caller", () => {
    it.each([
      ["empty", ""],
      ["blank", "   "],
      ["no @", "person.example.com"],
      ["two @", "a@b@example.com"],
      ["empty local part", "@example.com"],
      ["empty domain", "person@"],
      ["only @", "@"],
      ["space inside", "per son@example.com"],
      ["tab inside", "person@exa\tmple.com"],
      ["newline inside", "person@example.com\nBcc: x@example.com"],
      ["NUL", "per\u0000son@example.com"],
      ["DEL-range control", "per\u007fson@example.com"],
      ["C1 control", "per\u0085son@example.com"],
      ["NBSP inside", "per\u00a0son@example.com"],
    ])("%s", (_name, raw) => {
      expect(normalizeEmail(raw)).toBeUndefined();
    });

    it("measures the 254-octet limit exactly (accepts 254, rejects 255)", () => {
      const domainPart = "@example.com"; // 12 octets
      const at254 = "a".repeat(MAX_EMAIL_LENGTH - domainPart.length) + domainPart;
      expect(at254).toHaveLength(MAX_EMAIL_LENGTH);
      expect(normalizeEmail(at254)).toBe(at254);
      expect(normalizeEmail("a" + at254)).toBeUndefined();
    });

    it("counts octets, not UTF-16 units: multi-byte characters hit the limit sooner", () => {
      const local = "é".repeat(121); // 242 octets + 12 = 254
      expect(normalizeEmail(`${local}@example.com`)).toBeDefined();
      expect(normalizeEmail(`${local}é@example.com`)).toBeUndefined();
    });

    it("P: every accepted address has exactly one @, no whitespace or control characters, and fits", () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 300 }), (raw) => {
          const out = normalizeEmail(raw);
          if (out === undefined) return;
          expect(out.split("@")).toHaveLength(2);
          expect(out.split("@").every((p) => p !== "")).toBe(true);
          expect(/[\s\p{Cc}]/u.test(out)).toBe(false);
          expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_EMAIL_LENGTH);
        }),
        { numRuns: 800 },
      );
    });

    it("does not throw on a non-string", () => {
      expect(normalizeEmail(undefined as never)).toBeUndefined();
      expect(normalizeEmail(42 as never)).toBeUndefined();
    });
  });
});
