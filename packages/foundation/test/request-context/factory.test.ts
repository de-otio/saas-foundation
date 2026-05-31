/**
 * Tests for createRequestContext factory.
 *
 * Verifies:
 * - Result is frozen
 * - All optional fields round-trip correctly
 * - Clock injection for deterministic startedAt
 * - Validation: rejects empty requestId
 * - Property-based: valid inputs produce frozen results
 */

import fc from "fast-check";
import { describe, it, expect } from "vitest";
import {
  createRequestContext,
  RequestContextValidationError,
} from "../../src/request-context/index.js";
import { tenantId } from "../../src/types/frozen/tenant.js";

const RUN_OPTIONS = { numRuns: 1000, seed: 0xc0ffee } as const;

describe("createRequestContext — basic", () => {
  it("returns a frozen object", () => {
    const ctx = createRequestContext({ requestId: "r1" });
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it("sets requestId correctly", () => {
    const ctx = createRequestContext({ requestId: "req-factory-test" });
    expect(ctx.requestId).toBe("req-factory-test");
  });

  it("uses the injected clock for startedAt", () => {
    const frozenTime = 1_700_000_000_000;
    const ctx = createRequestContext({ requestId: "r-clock" }, () => frozenTime);
    expect(ctx.startedAt).toBe(frozenTime);
  });

  it("uses provided startedAt over clock", () => {
    const ctx = createRequestContext({ requestId: "r-started", startedAt: 12345 }, () => 99999);
    expect(ctx.startedAt).toBe(12345);
  });

  it("includes tenantId when provided", () => {
    const ctx = createRequestContext({
      requestId: "r-tid",
      tenantId: tenantId("contoso"),
    });
    expect(ctx.tenantId).toBe("contoso");
  });

  it("omits tenantId when absent", () => {
    const ctx = createRequestContext({ requestId: "r-no-tid" });
    expect("tenantId" in ctx).toBe(false);
  });

  it("includes principal when provided", () => {
    const ctx = createRequestContext({
      requestId: "r-principal",
      principal: { kind: "user", userSub: "u-42", sessionId: "s-99" },
    });
    expect(ctx.principal).toEqual({
      kind: "user",
      userSub: "u-42",
      sessionId: "s-99",
    });
  });

  it("includes traceId, region, residencyRegion, clientIp when provided", () => {
    const ctx = createRequestContext({
      requestId: "r-full",
      traceId: "trace-123",
      region: "eu-west-1",
      residencyRegion: "eu-central-1",
      clientIp: "203.0.113.1",
    });
    expect(ctx.traceId).toBe("trace-123");
    expect(ctx.region).toBe("eu-west-1");
    expect(ctx.residencyRegion).toBe("eu-central-1");
    expect(ctx.clientIp).toBe("203.0.113.1");
  });
});

describe("createRequestContext — validation", () => {
  it("throws RequestContextValidationError for empty requestId", () => {
    expect(() => createRequestContext({ requestId: "" })).toThrow(RequestContextValidationError);
  });

  it("error has correct name discriminant", () => {
    try {
      createRequestContext({ requestId: "" });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as RequestContextValidationError).name).toBe("RequestContextValidationError");
    }
  });
});

describe("createRequestContext — mutation resistance", () => {
  it("mutating the result throws TypeError in strict mode", () => {
    const ctx = createRequestContext({ requestId: "r-mut" });
    expect(() => {
      // @ts-expect-error — intentional mutation attempt
      ctx.requestId = "hacked";
    }).toThrow(TypeError);
  });
});

describe("createRequestContext — property-based", () => {
  const nonEmptyString = fc.string({ minLength: 1, maxLength: 64 });

  it("any valid requestId produces a frozen context with that requestId", () => {
    fc.assert(
      fc.property(nonEmptyString, fc.integer({ min: 0 }), (reqId, ts) => {
        const ctx = createRequestContext({ requestId: reqId }, () => ts);
        expect(Object.isFrozen(ctx)).toBe(true);
        expect(ctx.requestId).toBe(reqId);
        expect(ctx.startedAt).toBe(ts);
      }),
      RUN_OPTIONS,
    );
  });

  it("created context round-trips all required fields", () => {
    fc.assert(
      fc.property(nonEmptyString, fc.integer({ min: 0 }), (reqId, ts) => {
        const ctx = createRequestContext({ requestId: reqId }, () => ts);
        expect(ctx.requestId).toBe(reqId);
        expect(ctx.startedAt).toBe(ts);
        return true;
      }),
      RUN_OPTIONS,
    );
  });
});
