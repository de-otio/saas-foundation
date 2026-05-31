/**
 * Property-based tests for RequestContext shape via Zod schema.
 *
 * RequestContext is a TS interface (open to declaration merging) and
 * has no brand-checker. Boundary validation goes through
 * `RequestContextSchema.safeParse`.
 *
 * The freeze-on-construction invariant is asserted at the type-system
 * boundary here; the actual ALS lifecycle lands in P3.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { RequestContextSchema } from "../../src/types/frozen/schemas.js";
import { tenantId } from "../../src/types/frozen/tenant.js";

const RUN_OPTIONS = { numRuns: 1000, seed: 0xc0ffee } as const;

const validTenantChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.";

const tenantStringArb = fc
  .array(fc.constantFrom(...validTenantChars.split("")), {
    minLength: 1,
    maxLength: 32,
  })
  .map((cs) => cs.join(""));

const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 64 });

const validContextArbitrary = fc.record(
  {
    requestId: nonEmptyStringArb,
    startedAt: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
  },
  { requiredKeys: ["requestId", "startedAt"] },
);

const principalArb = fc.oneof(
  fc.record({
    kind: fc.constant("user" as const),
    userSub: nonEmptyStringArb,
    sessionId: nonEmptyStringArb,
  }),
  fc.record({
    kind: fc.constant("service" as const),
    serviceName: nonEmptyStringArb,
  }),
  fc.record({ kind: fc.constant("anonymous" as const) }),
);

describe("RequestContextSchema — property-based", () => {
  it("accepts every well-formed minimum context", () => {
    fc.assert(
      fc.property(validContextArbitrary, (ctx) => {
        const result = RequestContextSchema.safeParse(ctx);
        expect(result.success).toBe(true);
      }),
      RUN_OPTIONS,
    );
  });

  it("rejects empty requestId", () => {
    fc.assert(
      fc.property(validContextArbitrary, (ctx) => {
        const result = RequestContextSchema.safeParse({ ...ctx, requestId: "" });
        expect(result.success).toBe(false);
      }),
      RUN_OPTIONS,
    );
  });

  it("rejects negative startedAt", () => {
    fc.assert(
      fc.property(
        validContextArbitrary,
        fc.integer({ min: -1_000_000, max: -1 }),
        (ctx, negativeStart) => {
          const result = RequestContextSchema.safeParse({ ...ctx, startedAt: negativeStart });
          expect(result.success).toBe(false);
        },
      ),
      RUN_OPTIONS,
    );
  });

  it("accepts a valid tenantId on the context", () => {
    fc.assert(
      fc.property(validContextArbitrary, tenantStringArb, (ctx, tid) => {
        const result = RequestContextSchema.safeParse({ ...ctx, tenantId: tenantId(tid) });
        expect(result.success).toBe(true);
      }),
      RUN_OPTIONS,
    );
  });

  it("rejects tenantId values that violate the TenantId rules", () => {
    fc.assert(
      fc.property(
        validContextArbitrary,
        fc.constantFrom("has space", "tab\there", "ctrl\x01"),
        (ctx, badTid) => {
          const result = RequestContextSchema.safeParse({ ...ctx, tenantId: badTid });
          expect(result.success).toBe(false);
        },
      ),
      RUN_OPTIONS,
    );
  });

  it("accepts an optional principal", () => {
    fc.assert(
      fc.property(validContextArbitrary, principalArb, (ctx, principal) => {
        const result = RequestContextSchema.safeParse({ ...ctx, principal });
        expect(result.success).toBe(true);
      }),
      RUN_OPTIONS,
    );
  });

  it("rejects a principal with an unknown kind", () => {
    fc.assert(
      fc.property(validContextArbitrary, (ctx) => {
        const result = RequestContextSchema.safeParse({
          ...ctx,
          principal: { kind: "robot", userSub: "x", sessionId: "y" },
        });
        expect(result.success).toBe(false);
      }),
      RUN_OPTIONS,
    );
  });

  it("a frozen context passes the schema (immutability invariant)", () => {
    fc.assert(
      fc.property(validContextArbitrary, (ctx) => {
        const frozen = Object.freeze({ ...ctx });
        expect(Object.isFrozen(frozen)).toBe(true);
        const result = RequestContextSchema.safeParse(frozen);
        expect(result.success).toBe(true);
      }),
      RUN_OPTIONS,
    );
  });
});
