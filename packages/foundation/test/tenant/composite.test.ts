/**
 * Tests for `CompositeTenantResolver`.
 *
 * Coverage:
 *   - First-non-null wins
 *   - Error short-circuit (no fall-through)
 *   - Empty resolver list throws on construction
 *   - Mixed-trust composition throws
 *   - Trusted-strategy composition is permitted
 *   - Security note: a trusted strategy's result IS NOT pre-empted by
 *     a later untrusted-strategy match — this is enforced both by the
 *     "first non-null wins" + ordering convention and (defence in
 *     depth) by the constructor-time mixed-trust guard.
 */

import { describe, it, expect, vi } from "vitest";

import { tenantId } from "../../src/types/frozen/tenant.js";
import type { TenantId } from "../../src/types/frozen/tenant.js";
import type { TenantResolver, TenantResolverInput } from "../../src/tenant/resolver.js";
import {
  CompositeTenantResolver,
  TRUST_CLASS_KEY,
  getResolverTrustClass,
} from "../../src/tenant/strategies/composite.js";
import { SubdomainTenantResolver } from "../../src/tenant/strategies/subdomain.js";
import { CustomDomainTenantResolver } from "../../src/tenant/strategies/custom-domain.js";

function makeInput(hostname = "acme.myapp.com"): TenantResolverInput {
  return {
    request: new Request(`https://${hostname}/`),
    hostname,
    headers: new Map<string, string>(),
  };
}

/** Build a fake resolver returning a fixed result.
 *  Returns an object with a stable `mock` reference so call assertions
 *  do not trip the `unbound-method` rule. */
function fake(result: TenantId | null): {
  resolver: TenantResolver;
  mock: ReturnType<typeof vi.fn>;
} {
  const mock = vi.fn(() => Promise.resolve(result));
  return { resolver: { resolve: mock }, mock };
}

/** Build a fake resolver that throws. */
function failing(message: string): { resolver: TenantResolver; mock: ReturnType<typeof vi.fn> } {
  const mock = vi.fn(() => Promise.reject(new Error(message)));
  return { resolver: { resolve: mock }, mock };
}

describe("CompositeTenantResolver — composition order", () => {
  it("returns the first non-null result", async () => {
    const r = new CompositeTenantResolver([
      fake(null).resolver,
      fake(tenantId("acme")).resolver,
      fake(tenantId("other")).resolver,
    ]);
    expect(await r.resolve(makeInput())).toBe("acme");
  });

  it("returns null when all resolvers return null", async () => {
    const r = new CompositeTenantResolver([fake(null).resolver, fake(null).resolver]);
    expect(await r.resolve(makeInput())).toBeNull();
  });

  it("does not call subsequent resolvers after a non-null result", async () => {
    const second = fake(tenantId("never-reached"));
    const r = new CompositeTenantResolver([fake(tenantId("first")).resolver, second.resolver]);
    await r.resolve(makeInput());
    expect(second.mock).not.toHaveBeenCalled();
  });
});

describe("CompositeTenantResolver — error short-circuit", () => {
  it("propagates an error from an earlier resolver (no fall-through)", async () => {
    const fallback = fake(tenantId("would-have-resolved"));
    const r = new CompositeTenantResolver([failing("dns down").resolver, fallback.resolver]);
    await expect(r.resolve(makeInput())).rejects.toThrow("dns down");
    // Critical: the fallback is NOT consulted. An early error means
    // a verified source failed; falling through to a less-trusted
    // source on the same request would be a security regression.
    expect(fallback.mock).not.toHaveBeenCalled();
  });
});

describe("CompositeTenantResolver — construction", () => {
  it("throws on an empty resolver list", () => {
    expect(() => new CompositeTenantResolver([])).toThrow();
  });

  it("permits composition of two trusted resolvers", () => {
    expect(
      () =>
        new CompositeTenantResolver([
          new SubdomainTenantResolver({ baseDomain: "myapp.com" }),
          new CustomDomainTenantResolver({ lookup: () => Promise.resolve(null) }),
        ]),
    ).not.toThrow();
  });

  it("throws when composing trusted + untrusted resolvers", () => {
    // Build a hand-rolled "untrusted" resolver with the marker set.
    const untrusted: TenantResolver = {
      resolve: () => Promise.resolve(null),
    };
    (untrusted as unknown as Record<symbol, unknown>)[TRUST_CLASS_KEY] = "untrusted";

    expect(
      () =>
        new CompositeTenantResolver([
          new SubdomainTenantResolver({ baseDomain: "myapp.com" }),
          untrusted,
        ]),
    ).toThrow(/refusing to mix server-trust-anchored and untrusted/i);
  });
});

describe("CompositeTenantResolver — trust-class inspection", () => {
  it("getResolverTrustClass reports the bundled marker", () => {
    const subdomain = new SubdomainTenantResolver({ baseDomain: "myapp.com" });
    const custom = new CustomDomainTenantResolver({ lookup: () => Promise.resolve(null) });
    expect(getResolverTrustClass(subdomain)).toBe("server-trust-anchored");
    expect(getResolverTrustClass(custom)).toBe("server-trust-anchored");
  });

  it("returns undefined for a resolver with no declared trust class", () => {
    const undeclared: TenantResolver = { resolve: () => Promise.resolve(null) };
    expect(getResolverTrustClass(undeclared)).toBeUndefined();
  });
});

describe("CompositeTenantResolver — security: trusted result is not pre-empted", () => {
  it("a non-null result from the trusted resolver wins; the untrusted resolver is never consulted", async () => {
    // The mixed-trust guard normally blocks this configuration. We
    // construct it via direct field write to demonstrate the runtime
    // ordering semantics — the GUARD is the primary defence; this
    // test exercises the secondary "even if you bypass the guard, the
    // order still matters" property.
    const untrusted = fake(tenantId("attacker-claimed"));
    // Force the marker so we know the guard would have fired if we
    // had not bypassed it via direct construction below.
    (untrusted.resolver as unknown as Record<symbol, unknown>)[TRUST_CLASS_KEY] = "untrusted";

    const trusted = fake(tenantId("verified"));
    (trusted.resolver as unknown as Record<symbol, unknown>)[TRUST_CLASS_KEY] =
      "server-trust-anchored";

    // Bypass the guard by building the array with only trusted markers
    // then mutating — exercising the runtime behaviour, not the guard.
    const r = new CompositeTenantResolver([trusted.resolver]);
    // Inject untrusted second via the private path:
    (r as unknown as { resolvers: TenantResolver[] }).resolvers = [
      trusted.resolver,
      untrusted.resolver,
    ];

    const result = await r.resolve(makeInput());
    expect(result).toBe("verified");
    expect(untrusted.mock).not.toHaveBeenCalled();
  });
});
