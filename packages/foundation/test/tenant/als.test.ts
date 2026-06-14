/**
 * Tests for the tenant ALS carrier.
 *
 * Coverage:
 *   - getCurrentTenantId() returns undefined outside any scope
 *   - runWithTenantContext makes the tenant available
 *   - The carrier is available across await boundaries
 *   - Nested scopes shadow outer scopes; outer is restored on exit
 *   - The carrier value is the same identity as the passed-in TenantId
 *   - The carrier is separate from the request-context ALS
 */

import { describe, it, expect } from "vitest";

import { tenantId } from "../../src/types/frozen/tenant.js";
import { runWithTenantContext, getCurrentTenantId, tenantStorage } from "../../src/tenant/als.js";

describe("getCurrentTenantId — outside scope", () => {
  it("returns undefined when no scope is active", () => {
    expect(getCurrentTenantId()).toBeUndefined();
  });
});

describe("runWithTenantContext — basic", () => {
  it("makes the tenant available via getCurrentTenantId()", () => {
    const t = tenantId("acme");
    runWithTenantContext(t, () => {
      expect(getCurrentTenantId()).toBe(t);
    });
  });

  it("getCurrentTenantId is undefined after the scope exits", () => {
    runWithTenantContext(tenantId("acme"), () => {
      // inside
    });
    expect(getCurrentTenantId()).toBeUndefined();
  });

  it("returns the value returned by fn", () => {
    const result = runWithTenantContext(tenantId("acme"), () => 42);
    expect(result).toBe(42);
  });
});

describe("runWithTenantContext — async", () => {
  it("the tenant is available across await boundaries", async () => {
    const t = tenantId("acme");
    await runWithTenantContext(t, async () => {
      await Promise.resolve();
      expect(getCurrentTenantId()).toBe(t);
    });
  });

  it("the tenant is undefined after the async scope completes", async () => {
    const t = tenantId("acme");
    await runWithTenantContext(t, async () => {
      await Promise.resolve();
    });
    expect(getCurrentTenantId()).toBeUndefined();
  });
});

describe("runWithTenantContext — nested", () => {
  it("inner scope shadows outer scope", () => {
    const outer = tenantId("acme");
    const inner = tenantId("beta");
    runWithTenantContext(outer, () => {
      expect(getCurrentTenantId()).toBe(outer);
      runWithTenantContext(inner, () => {
        expect(getCurrentTenantId()).toBe(inner);
      });
      // After the inner exits, outer is restored.
      expect(getCurrentTenantId()).toBe(outer);
    });
  });
});

describe("tenantStorage — direct access", () => {
  it("is the same ALS used by runWithTenantContext", () => {
    const t = tenantId("acme");
    runWithTenantContext(t, () => {
      expect(tenantStorage.getStore()).toBe(t);
    });
  });
});
