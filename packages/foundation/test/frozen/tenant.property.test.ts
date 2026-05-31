/**
 * Property-based tests for the TenantId brand checker.
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
  TENANT_ID_CONSTRAINTS,
  TenantIdValidationError,
  isTenantId,
  tenantId,
} from "../../src/types/frozen/tenant.js";

const RUN_OPTIONS = { numRuns: 1000, seed: 0xc0ffee } as const;

/**
 * Generator: characters allowed in a TenantId (no whitespace, no C0
 * controls, no DEL). Drawn from the printable ASCII band plus a few
 * non-ASCII letters to exercise unicode handling.
 */
const validCharArbitrary = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".split(
    "",
  ),
  // a sprinkling of non-ASCII letters
  "ä",
  "ö",
  "ü",
  "ß",
  "é",
  "ñ",
  "ø",
  "λ",
  "中",
);

/** Generator: a valid TenantId string (1-256 chars from the allowed set). */
const validTenantArbitrary = fc
  .array(validCharArbitrary, {
    minLength: TENANT_ID_CONSTRAINTS.minLength,
    maxLength: TENANT_ID_CONSTRAINTS.maxLength,
  })
  .map((chars) => chars.join(""));

/**
 * Generator: an invalid TenantId string. Spans the four documented
 * failure modes: empty, too-long, whitespace-containing, control-char-
 * containing.
 */
const invalidTenantArbitrary = fc.oneof(
  // empty
  fc.constant(""),
  // too long
  fc.integer({ min: TENANT_ID_CONSTRAINTS.maxLength + 1, max: 512 }).map((n) => "a".repeat(n)),
  // contains whitespace
  fc.tuple(validTenantArbitrary, fc.constantFrom(" ", "\t", "\n", "\r")).map(([s, ws]) => {
    // Insert at a deterministic position derived from input length
    const pos = s.length === 0 ? 0 : s.length % 2 === 0 ? 0 : s.length;
    return s.slice(0, pos) + ws + s.slice(pos);
  }),
  // contains a C0 control or DEL
  fc
    .tuple(
      validTenantArbitrary,
      fc.integer({ min: 0, max: 0x1f }).map((code) => String.fromCharCode(code)),
    )
    .map(([s, ctrl]) => `${s}${ctrl}`),
  fc.tuple(validTenantArbitrary, fc.constant("\x7f")).map(([s, del]) => `${s}${del}`),
);

describe("tenantId / isTenantId — property-based", () => {
  it("every valid input round-trips through tenantId and isTenantId", () => {
    fc.assert(
      fc.property(validTenantArbitrary, (input) => {
        const result = tenantId(input);
        // The brand erases; the value is still the input string
        expect(result).toBe(input);
        // The predicate must agree
        expect(isTenantId(result)).toBe(true);
        // And on the raw input
        expect(isTenantId(input)).toBe(true);
      }),
      RUN_OPTIONS,
    );
  });

  it("every invalid input causes tenantId to throw TenantIdValidationError", () => {
    fc.assert(
      fc.property(invalidTenantArbitrary, (input) => {
        let thrown: unknown = null;
        try {
          tenantId(input);
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(TenantIdValidationError);
        expect((thrown as TenantIdValidationError).name).toBe("TenantIdValidationError");
      }),
      RUN_OPTIONS,
    );
  });

  it("isTenantId returns false for every invalid input", () => {
    fc.assert(
      fc.property(invalidTenantArbitrary, (input) => {
        expect(isTenantId(input)).toBe(false);
      }),
      RUN_OPTIONS,
    );
  });

  it("isTenantId(value) iff tenantId(value) does not throw (consistency)", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        let constructorSucceeded = true;
        try {
          tenantId(input);
        } catch {
          constructorSucceeded = false;
        }
        expect(isTenantId(input)).toBe(constructorSucceeded);
      }),
      RUN_OPTIONS,
    );
  });

  it("isTenantId returns false for non-string inputs", () => {
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
          expect(isTenantId(input)).toBe(false);
        },
      ),
      RUN_OPTIONS,
    );
  });

  it("tenantId throws for non-string inputs", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.constant(undefined)),
        (input) => {
          expect(() => tenantId(input as unknown as string)).toThrow(TenantIdValidationError);
        },
      ),
      RUN_OPTIONS,
    );
  });

  it("TenantIdValidationError preserves the offending input", () => {
    const bad = "has space";
    try {
      tenantId(bad);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TenantIdValidationError);
      expect((err as TenantIdValidationError).input).toBe(bad);
    }
  });

  it("a string of exactly 256 valid characters is accepted", () => {
    const id = "a".repeat(256);
    expect(isTenantId(id)).toBe(true);
    expect(tenantId(id)).toBe(id);
  });

  it("a string of 257 characters is rejected", () => {
    const tooLong = "a".repeat(257);
    expect(isTenantId(tooLong)).toBe(false);
    expect(() => tenantId(tooLong)).toThrow(TenantIdValidationError);
  });
});
