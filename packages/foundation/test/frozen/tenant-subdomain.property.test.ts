/**
 * Property-based tests for the TenantSubdomain brand checker.
 *
 * Per doc/10-ai-maintained-conventions.md § Property-based testing,
 * brand checkers ship with 1000-input fuzz tests covering valid and
 * invalid spaces.
 *
 * Determinism: fast-check is seeded so failures reproduce. Numeric
 * literals chosen via `0xc0ffee` per the project convention.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  TENANT_SUBDOMAIN_CONSTRAINTS,
  TenantSubdomainValidationError,
  isTenantSubdomain,
  tenantSubdomain,
} from "../../src/types/frozen/tenant-subdomain.js";

const RUN_OPTIONS = { numRuns: 1000, seed: 0xc0ffee } as const;

/**
 * Generator: characters allowed in the body of a subdomain label
 * (lowercase alpha, digits, hyphen).
 */
const bodyCharArbitrary = fc.constantFrom(...("abcdefghijklmnopqrstuvwxyz0123456789-".split("")));

/**
 * Generator: characters allowed at start/end of a subdomain label
 * (lowercase alpha, digits only — no hyphen at boundaries).
 */
const boundaryCharArbitrary = fc.constantFrom(
  ...("abcdefghijklmnopqrstuvwxyz0123456789".split("")),
);

/**
 * Generator: a valid TenantSubdomain string.
 * Structure: [a-z] + [a-z0-9-]{1,61} + [a-z0-9]
 * Total length: 3-63.
 */
const validSubdomainArbitrary = fc
  .tuple(
    // start char: lowercase alpha only
    fc.constantFrom(...("abcdefghijklmnopqrstuvwxyz".split(""))),
    // middle chars: 1 to 61 chars from body set
    fc.array(bodyCharArbitrary, { minLength: 1, maxLength: 61 }),
    // end char: lowercase alpha or digit
    boundaryCharArbitrary,
  )
  .map(([start, middle, end]) => start + middle.join("") + end)
  .filter(
    (s) =>
      s.length >= TENANT_SUBDOMAIN_CONSTRAINTS.minLength &&
      s.length <= TENANT_SUBDOMAIN_CONSTRAINTS.maxLength,
  );

/**
 * Generator: an invalid TenantSubdomain string. Spans the documented failure
 * modes: too-short, too-long, uppercase letters, starts with digit, starts
 * with hyphen, ends with hyphen, contains invalid characters.
 */
const invalidSubdomainArbitrary = fc.oneof(
  // too short (length 1 or 2)
  fc.integer({ min: 1, max: 2 }).map((n) => "a".repeat(n)),
  // too long (length 64+)
  fc.integer({ min: 64, max: 128 }).map((n) => "a".repeat(n)),
  // contains uppercase letter
  fc
    .tuple(
      validSubdomainArbitrary,
      fc.constantFrom(...("ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""))),
    )
    .map(([s, upper]) => s.slice(0, 1) + upper + s.slice(1)),
  // starts with a digit
  fc
    .tuple(
      fc.constantFrom(...("0123456789".split(""))),
      fc.array(bodyCharArbitrary, { minLength: 2, maxLength: 61 }),
      boundaryCharArbitrary,
    )
    .map(([d, mid, end]) => d + mid.join("") + end),
  // starts with a hyphen
  fc
    .tuple(
      fc.array(bodyCharArbitrary, { minLength: 1, maxLength: 60 }),
      boundaryCharArbitrary,
    )
    .map(([mid, end]) => "-" + mid.join("") + end),
  // ends with a hyphen (3+ chars, last char is hyphen)
  fc
    .tuple(
      fc.constantFrom(...("abcdefghijklmnopqrstuvwxyz".split(""))),
      fc.array(bodyCharArbitrary, { minLength: 1, maxLength: 61 }),
    )
    .map(([start, mid]) => start + mid.join("") + "-"),
  // contains an invalid character (space, dot, underscore, etc.)
  fc
    .tuple(
      validSubdomainArbitrary,
      fc.constantFrom(" ", ".", "_", "@", "/", "!", "A"),
    )
    .map(([s, bad]) => {
      // Insert the bad char in the middle to avoid start/end confusion
      const mid = Math.floor(s.length / 2);
      return s.slice(0, mid) + bad + s.slice(mid);
    }),
);

describe("tenantSubdomain / isTenantSubdomain — property-based", () => {
  it("every valid input round-trips through tenantSubdomain and isTenantSubdomain", () => {
    fc.assert(
      fc.property(validSubdomainArbitrary, (input) => {
        const result = tenantSubdomain(input);
        // The brand erases; the value is still the input string
        expect(result).toBe(input);
        // The predicate must agree
        expect(isTenantSubdomain(result)).toBe(true);
        // And on the raw input
        expect(isTenantSubdomain(input)).toBe(true);
      }),
      RUN_OPTIONS,
    );
  });

  it("every invalid input causes tenantSubdomain to throw TenantSubdomainValidationError", () => {
    fc.assert(
      fc.property(invalidSubdomainArbitrary, (input) => {
        let thrown: unknown = null;
        try {
          tenantSubdomain(input);
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(TenantSubdomainValidationError);
        expect((thrown as TenantSubdomainValidationError).name).toBe(
          "TenantSubdomainValidationError",
        );
      }),
      RUN_OPTIONS,
    );
  });

  it("isTenantSubdomain returns false for every invalid input", () => {
    fc.assert(
      fc.property(invalidSubdomainArbitrary, (input) => {
        expect(isTenantSubdomain(input)).toBe(false);
      }),
      RUN_OPTIONS,
    );
  });

  it("isTenantSubdomain(value) iff tenantSubdomain(value) does not throw (consistency)", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        let constructorSucceeded = true;
        try {
          tenantSubdomain(input);
        } catch {
          constructorSucceeded = false;
        }
        expect(isTenantSubdomain(input)).toBe(constructorSucceeded);
      }),
      RUN_OPTIONS,
    );
  });

  it("isTenantSubdomain returns false for non-string inputs", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.constant(undefined),
          fc.array(fc.string()),
          fc.object(),
        ),
        (input) => {
          expect(isTenantSubdomain(input)).toBe(false);
        },
      ),
      RUN_OPTIONS,
    );
  });

  it("tenantSubdomain throws for non-string inputs", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.constant(undefined)),
        (input) => {
          expect(() => tenantSubdomain(input as unknown as string)).toThrow(
            TenantSubdomainValidationError,
          );
        },
      ),
      RUN_OPTIONS,
    );
  });

  it("TenantSubdomainValidationError preserves the offending input", () => {
    const bad = "UPPERCASE";
    try {
      tenantSubdomain(bad);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TenantSubdomainValidationError);
      expect((err as TenantSubdomainValidationError).input).toBe(bad);
    }
  });

  it("a string of exactly 63 valid characters is accepted", () => {
    // 1 alpha-start + 61 body + 1 alpha-end = 63
    const id = "a" + "b".repeat(61) + "c";
    expect(id.length).toBe(63);
    expect(isTenantSubdomain(id)).toBe(true);
    expect(tenantSubdomain(id)).toBe(id);
  });

  it("a string of 64 characters is rejected", () => {
    const tooLong = "a" + "b".repeat(62) + "c";
    expect(tooLong.length).toBe(64);
    expect(isTenantSubdomain(tooLong)).toBe(false);
    expect(() => tenantSubdomain(tooLong)).toThrow(TenantSubdomainValidationError);
  });

  it("a string of exactly 3 valid characters is accepted", () => {
    // 1 alpha-start + 1 body + 1 alpha-end
    const id = "abc";
    expect(isTenantSubdomain(id)).toBe(true);
    expect(tenantSubdomain(id)).toBe(id);
  });

  it("a string of 2 characters is rejected", () => {
    const tooShort = "ab";
    expect(isTenantSubdomain(tooShort)).toBe(false);
    expect(() => tenantSubdomain(tooShort)).toThrow(TenantSubdomainValidationError);
  });

  it("a string ending with a hyphen is rejected", () => {
    const trailingDash = "abc-";
    expect(isTenantSubdomain(trailingDash)).toBe(false);
    expect(() => tenantSubdomain(trailingDash)).toThrow(TenantSubdomainValidationError);
  });

  it("a string starting with a digit is rejected", () => {
    const digitStart = "1abc";
    expect(isTenantSubdomain(digitStart)).toBe(false);
    expect(() => tenantSubdomain(digitStart)).toThrow(TenantSubdomainValidationError);
  });

  it("a string starting with a hyphen is rejected", () => {
    const hyphenStart = "-abc";
    expect(isTenantSubdomain(hyphenStart)).toBe(false);
    expect(() => tenantSubdomain(hyphenStart)).toThrow(TenantSubdomainValidationError);
  });

  it("uppercase letters are rejected", () => {
    const upper = "Abc";
    expect(isTenantSubdomain(upper)).toBe(false);
    expect(() => tenantSubdomain(upper)).toThrow(TenantSubdomainValidationError);
  });

  it("hyphen in the middle is accepted", () => {
    const withDash = "abc-def";
    expect(isTenantSubdomain(withDash)).toBe(true);
    expect(tenantSubdomain(withDash)).toBe(withDash);
  });

  it("digits in the middle are accepted", () => {
    const withDigits = "abc123def";
    expect(isTenantSubdomain(withDigits)).toBe(true);
    expect(tenantSubdomain(withDigits)).toBe(withDigits);
  });
});
