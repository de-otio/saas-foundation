/**
 * Tests for the ALS semantics of request context.
 *
 * Verifies:
 * - Basic ALS: getRequestContext() returns null outside scope
 * - runWithRequestContext enters and exits cleanly
 * - Nested runWithRequestContext creates proper context tree
 * - Context is correct after nested scope exits
 */

import { describe, it, expect } from "vitest";
import {
  createRequestContext,
  runWithRequestContext,
  getRequestContext,
} from "../../src/request-context/index.js";

describe("getRequestContext() — outside scope", () => {
  it("returns null when no context is active", () => {
    expect(getRequestContext()).toBeNull();
  });
});

describe("runWithRequestContext — basic", () => {
  it("makes the context available via getRequestContext()", () => {
    const ctx = createRequestContext({ requestId: "als-basic-1" });
    runWithRequestContext(ctx, () => {
      const current = getRequestContext();
      expect(current).not.toBeNull();
      expect(current?.requestId).toBe("als-basic-1");
    });
  });

  it("context is null after the scope exits", () => {
    const ctx = createRequestContext({ requestId: "als-exit-1" });
    runWithRequestContext(ctx, () => {
      // inside
    });
    expect(getRequestContext()).toBeNull();
  });

  it("returns the value returned by fn", () => {
    const ctx = createRequestContext({ requestId: "als-return-1" });
    const result = runWithRequestContext(ctx, () => 42);
    expect(result).toBe(42);
  });
});

describe("runWithRequestContext — async", () => {
  it("context is available across await boundaries", async () => {
    const ctx = createRequestContext({ requestId: "als-async-1" });
    await runWithRequestContext(ctx, async () => {
      await Promise.resolve();
      const current = getRequestContext();
      expect(current?.requestId).toBe("als-async-1");
    });
  });

  it("context is null after async scope completes", async () => {
    const ctx = createRequestContext({ requestId: "als-async-exit-1" });
    await runWithRequestContext(ctx, async () => {
      await Promise.resolve();
    });
    expect(getRequestContext()).toBeNull();
  });
});

describe("runWithRequestContext — nested scopes", () => {
  it("nested scope sees the inner context", () => {
    const outer = createRequestContext({ requestId: "outer-1" });
    const inner = createRequestContext({ requestId: "inner-1" });

    runWithRequestContext(outer, () => {
      expect(getRequestContext()?.requestId).toBe("outer-1");

      runWithRequestContext(inner, () => {
        expect(getRequestContext()?.requestId).toBe("inner-1");
      });

      // Back to outer
      expect(getRequestContext()?.requestId).toBe("outer-1");
    });
  });

  it("deeply nested scopes each see their own context", () => {
    const contexts = ["deep-1", "deep-2", "deep-3"].map((id) =>
      createRequestContext({ requestId: id }),
    );

    const [c1, c2, c3] = contexts as [
      ReturnType<typeof createRequestContext>,
      ReturnType<typeof createRequestContext>,
      ReturnType<typeof createRequestContext>,
    ];

    runWithRequestContext(c1, () => {
      expect(getRequestContext()?.requestId).toBe("deep-1");
      runWithRequestContext(c2, () => {
        expect(getRequestContext()?.requestId).toBe("deep-2");
        runWithRequestContext(c3, () => {
          expect(getRequestContext()?.requestId).toBe("deep-3");
        });
        expect(getRequestContext()?.requestId).toBe("deep-2");
      });
      expect(getRequestContext()?.requestId).toBe("deep-1");
    });
  });
});
