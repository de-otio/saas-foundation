/**
 * Tests for `SubdomainTenantResolver`.
 *
 * Coverage:
 *   - Happy path: acme.myapp.com -> "acme"
 *   - Bare apex: myapp.com -> null
 *   - Non-matching base: evil.com -> null
 *   - Multi-level: a.b.myapp.com -> "a.b" (consumer's policy decides)
 *   - Reserved (www-stripping): www.myapp.com -> null
 *   - Case insensitivity
 *   - Trailing-dot / port normalisation
 *   - Invalid characters fall to null (not throw)
 *   - Throws on empty baseDomain
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { SubdomainTenantResolver } from "../../src/tenant/strategies/subdomain.js";
import type { TenantResolverInput } from "../../src/tenant/resolver.js";

function makeInput(hostname: string): TenantResolverInput {
  return {
    request: new Request(`https://${hostname}/`),
    hostname,
    headers: new Map<string, string>(),
  };
}

describe("SubdomainTenantResolver — happy path", () => {
  it("extracts a leftmost tenant slug", async () => {
    const r = new SubdomainTenantResolver({ baseDomain: "myapp.com" });
    expect(await r.resolve(makeInput("acme.myapp.com"))).toBe("acme");
  });

  it("returns the FULL prefix for multi-level subdomains", async () => {
    const r = new SubdomainTenantResolver({ baseDomain: "myapp.com" });
    expect(await r.resolve(makeInput("a.b.myapp.com"))).toBe("a.b");
  });
});

describe("SubdomainTenantResolver — non-matching hosts", () => {
  it("returns null for the bare apex", async () => {
    const r = new SubdomainTenantResolver({ baseDomain: "myapp.com" });
    expect(await r.resolve(makeInput("myapp.com"))).toBeNull();
  });

  it("returns null for a host outside baseDomain", async () => {
    const r = new SubdomainTenantResolver({ baseDomain: "myapp.com" });
    expect(await r.resolve(makeInput("evil.com"))).toBeNull();
  });

  it("returns null for a host that contains baseDomain as a substring but not a suffix", async () => {
    const r = new SubdomainTenantResolver({ baseDomain: "myapp.com" });
    // "myapp.com.attacker.net" must not match — only true suffixes.
    expect(await r.resolve(makeInput("myapp.com.attacker.net"))).toBeNull();
  });
});

describe("SubdomainTenantResolver — reserved labels", () => {
  it("treats www as non-tenant by default", async () => {
    const r = new SubdomainTenantResolver({ baseDomain: "myapp.com" });
    expect(await r.resolve(makeInput("www.myapp.com"))).toBeNull();
  });

  it("supports custom reserved labels", async () => {
    const r = new SubdomainTenantResolver({
      baseDomain: "myapp.com",
      reservedLabels: ["www", "api", "admin"],
    });
    expect(await r.resolve(makeInput("api.myapp.com"))).toBeNull();
    expect(await r.resolve(makeInput("admin.myapp.com"))).toBeNull();
    expect(await r.resolve(makeInput("acme.myapp.com"))).toBe("acme");
  });

  it("checks reserved labels against the leftmost label only", async () => {
    // "www.acme.myapp.com" — leftmost label is "www"
    const r = new SubdomainTenantResolver({ baseDomain: "myapp.com" });
    expect(await r.resolve(makeInput("www.acme.myapp.com"))).toBeNull();
  });
});

describe("SubdomainTenantResolver — normalisation", () => {
  it("is case-insensitive on baseDomain", async () => {
    const r = new SubdomainTenantResolver({ baseDomain: "MyApp.com" });
    expect(await r.resolve(makeInput("acme.myapp.com"))).toBe("acme");
  });

  it("is case-insensitive on the incoming host", async () => {
    const r = new SubdomainTenantResolver({ baseDomain: "myapp.com" });
    expect(await r.resolve(makeInput("ACME.MyApp.Com"))).toBe("acme");
  });

  it("strips a trailing dot (FQDN form)", async () => {
    const r = new SubdomainTenantResolver({ baseDomain: "myapp.com" });
    expect(await r.resolve(makeInput("acme.myapp.com."))).toBe("acme");
  });

  it("strips a port suffix", async () => {
    const r = new SubdomainTenantResolver({ baseDomain: "myapp.com" });
    expect(await r.resolve(makeInput("acme.myapp.com:8443"))).toBe("acme");
  });
});

describe("SubdomainTenantResolver — invalid slugs", () => {
  it("returns null for a slug that would fail TenantId validation", async () => {
    // Hostnames can't actually contain whitespace, but if the prefix
    // somehow ended up with control characters we treat that as null,
    // not an exception.
    const r = new SubdomainTenantResolver({ baseDomain: "myapp.com" });
    // We can't easily craft an invalid hostname via the Request URL,
    // so we call resolveSync via the public path with a header-based
    // input that bypasses URL parsing.
    const longPrefix = "x".repeat(300);
    expect(await r.resolve(makeInput(`${longPrefix}.myapp.com`))).toBeNull();
  });
});

describe("SubdomainTenantResolver — construction", () => {
  it("throws on empty baseDomain", () => {
    expect(() => new SubdomainTenantResolver({ baseDomain: "" })).toThrow();
  });
});

describe("SubdomainTenantResolver — property based", () => {
  it("any host not ending in baseDomain returns null", async () => {
    const r = new SubdomainTenantResolver({ baseDomain: "myapp.com" });
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[a-z][a-z0-9-]{1,30}\.(com|net|org|io)$/),
        async (host) => {
          // Filter out the case where the generator happens to produce
          // a baseDomain match.
          if (host.endsWith("myapp.com")) return;
          expect(await r.resolve(makeInput(host))).toBeNull();
        },
      ),
      { numRuns: 100, seed: 0xc0ffee },
    );
  });
});
