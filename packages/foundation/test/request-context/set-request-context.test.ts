/**
 * Tests for setRequestContext semantics.
 *
 * Verifies:
 * - Replacement (not mutation) creates a new frozen object
 * - The new context is visible via getRequestContext()
 * - Throws when called outside any scope
 * - The replaced context is itself frozen
 */

import { describe, it, expect } from "vitest";
import {
  createRequestContext,
  runWithRequestContext,
  getRequestContext,
  setRequestContext,
  RequestContextPhaseError,
} from "../../src/request-context/index.js";
import { tenantId } from "../../src/types/frozen/tenant.js";

describe("setRequestContext — basic replacement", () => {
  it("replaces the current context in the ALS store", () => {
    const initial = createRequestContext({ requestId: "set-initial" });
    const replacement = createRequestContext({ requestId: "set-replaced" });

    runWithRequestContext(initial, () => {
      expect(getRequestContext()?.requestId).toBe("set-initial");
      setRequestContext(replacement);
      expect(getRequestContext()?.requestId).toBe("set-replaced");
    });
  });

  it("replacement context is frozen", () => {
    const initial = createRequestContext({ requestId: "set-freeze-check" });
    const next = createRequestContext({
      requestId: "set-freeze-check",
      tenantId: tenantId("my-tenant"),
    });

    runWithRequestContext(initial, () => {
      setRequestContext(next);
      const current = getRequestContext();
      expect(Object.isFrozen(current)).toBe(true);
    });
  });

  it("mutating the replaced context throws", () => {
    const initial = createRequestContext({ requestId: "set-mut" });
    const next = createRequestContext({ requestId: "set-mut-replaced" });

    runWithRequestContext(initial, () => {
      setRequestContext(next);
      const current = getRequestContext();
      expect(() => {
        // @ts-expect-error — intentional mutation attempt
        current!.requestId = "hacked";
      }).toThrow(TypeError);
    });
  });

  it("replacement includes new fields from the spread pattern", () => {
    const initial = createRequestContext({ requestId: "set-spread" });

    runWithRequestContext(initial, () => {
      const ctx = getRequestContext()!;
      const next = createRequestContext({
        ...ctx,
        tenantId: tenantId("new-tenant"),
      });
      setRequestContext(next);

      const updated = getRequestContext();
      expect(updated?.requestId).toBe("set-spread");
      expect(updated?.tenantId).toBe("new-tenant");
    });
  });
});

describe("setRequestContext — phase guard", () => {
  it("throws RequestContextPhaseError outside any scope", () => {
    const ctx = createRequestContext({ requestId: "orphan" });
    expect(() => setRequestContext(ctx)).toThrow(RequestContextPhaseError);
  });

  it("error has the correct name discriminant", () => {
    const ctx = createRequestContext({ requestId: "orphan-2" });
    try {
      setRequestContext(ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as RequestContextPhaseError).name).toBe("RequestContextPhaseError");
    }
  });
});
