/**
 * Tests for the `TenantResolver` interface and the `resolveTenant`
 * entry point.
 *
 * Interface conformance — the bundled resolvers all return
 * `Promise<TenantId | null>`; the entry point passes input through
 * verbatim; null and non-null both round-trip.
 */

import { describe, it, expect, vi } from "vitest";

import { tenantId } from "../../src/types/frozen/tenant.js";
import type { TenantResolver, TenantResolverInput } from "../../src/tenant/resolver.js";
import { resolveTenant } from "../../src/tenant/resolver.js";

function makeInput(hostname = "example.com"): TenantResolverInput {
  return {
    request: new Request(`https://${hostname}/`),
    hostname,
    headers: new Map<string, string>(),
  };
}

describe("resolveTenant", () => {
  it("delegates to the resolver's resolve method", async () => {
    const resolveFn = vi.fn(() => Promise.resolve(tenantId("acme")));
    const resolver: TenantResolver = { resolve: resolveFn };
    const result = await resolveTenant(resolver, makeInput("acme.myapp.com"));
    expect(result).toBe("acme");
    expect(resolveFn).toHaveBeenCalledOnce();
  });

  it("propagates null results", async () => {
    const resolver: TenantResolver = {
      resolve: () => Promise.resolve(null),
    };
    const result = await resolveTenant(resolver, makeInput());
    expect(result).toBeNull();
  });

  it("propagates errors thrown by the resolver", async () => {
    const resolver: TenantResolver = {
      resolve: () => Promise.reject(new Error("boom")),
    };
    await expect(resolveTenant(resolver, makeInput())).rejects.toThrow("boom");
  });

  it("passes the input through verbatim", async () => {
    const seen: TenantResolverInput[] = [];
    const resolver: TenantResolver = {
      resolve: (input) => {
        seen.push(input);
        return Promise.resolve(null);
      },
    };
    const input = makeInput("custom.example.com");
    await resolveTenant(resolver, input);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(input);
  });
});
