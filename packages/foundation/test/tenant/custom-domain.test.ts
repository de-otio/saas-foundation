/**
 * Tests for `CustomDomainTenantResolver`.
 *
 * The lookup function is mocked — no DNS / DB I/O. The contract
 * we exercise:
 *   - Hit / miss
 *   - Case insensitivity (resolver lowercases before lookup)
 *   - Trailing-dot / port stripping
 *   - Returns null when lookup returns null
 *   - Returns null when lookup returns an invalid tenant string
 *   - Wraps a thrown lookup error in TenantResolverError
 */

import { describe, it, expect, vi } from "vitest";

import { tenantId } from "../../src/types/frozen/tenant.js";
import { CustomDomainTenantResolver } from "../../src/tenant/strategies/custom-domain.js";
import { TenantResolverError } from "../../src/tenant/errors.js";
import type { TenantResolverInput } from "../../src/tenant/resolver.js";

function makeInput(hostname: string): TenantResolverInput {
  return {
    request: new Request(`https://${hostname}/`),
    hostname,
    headers: new Map<string, string>(),
  };
}

describe("CustomDomainTenantResolver — hit/miss", () => {
  it("returns the looked-up tenant on hit", async () => {
    const lookup = vi.fn((host: string) =>
      Promise.resolve(host === "app.acme.com" ? tenantId("acme") : null),
    );
    const r = new CustomDomainTenantResolver({ lookup });
    expect(await r.resolve(makeInput("app.acme.com"))).toBe("acme");
  });

  it("returns null on miss", async () => {
    const lookup = vi.fn(() => Promise.resolve(null));
    const r = new CustomDomainTenantResolver({ lookup });
    expect(await r.resolve(makeInput("unknown.host.io"))).toBeNull();
  });
});

describe("CustomDomainTenantResolver — string fallback", () => {
  it("accepts a plain string and re-validates it as a TenantId", async () => {
    const lookup = vi.fn(() => Promise.resolve("acme-corp"));
    const r = new CustomDomainTenantResolver({ lookup });
    expect(await r.resolve(makeInput("custom.example.com"))).toBe("acme-corp");
  });

  it("returns null when lookup returns an invalid tenant string", async () => {
    const lookup = vi.fn(() => Promise.resolve("has whitespace")); // invalid
    const r = new CustomDomainTenantResolver({ lookup });
    expect(await r.resolve(makeInput("custom.example.com"))).toBeNull();
  });
});

describe("CustomDomainTenantResolver — normalisation", () => {
  it("lowercases the hostname before lookup", async () => {
    const seen: string[] = [];
    const lookup = vi.fn((host: string) => {
      seen.push(host);
      return Promise.resolve<string | null>(null);
    });
    const r = new CustomDomainTenantResolver({ lookup });
    await r.resolve(makeInput("APP.ACME.COM"));
    expect(seen).toEqual(["app.acme.com"]);
  });

  it("strips a trailing dot before lookup", async () => {
    const seen: string[] = [];
    const lookup = vi.fn((host: string) => {
      seen.push(host);
      return Promise.resolve<string | null>(null);
    });
    const r = new CustomDomainTenantResolver({ lookup });
    await r.resolve(makeInput("app.acme.com."));
    expect(seen).toEqual(["app.acme.com"]);
  });

  it("strips a port before lookup", async () => {
    const seen: string[] = [];
    const lookup = vi.fn((host: string) => {
      seen.push(host);
      return Promise.resolve<string | null>(null);
    });
    const r = new CustomDomainTenantResolver({ lookup });
    await r.resolve(makeInput("app.acme.com:8443"));
    expect(seen).toEqual(["app.acme.com"]);
  });

  it("returns null for an empty hostname", async () => {
    const lookup = vi.fn(() => Promise.resolve(null));
    const r = new CustomDomainTenantResolver({ lookup });
    // Construct the input directly to bypass URL parsing.
    const input = {
      request: new Request("https://placeholder.example/"),
      hostname: "",
      headers: new Map<string, string>(),
    };
    expect(await r.resolve(input)).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("CustomDomainTenantResolver — errors", () => {
  it("wraps a thrown lookup error in TenantResolverError", async () => {
    const lookup = vi.fn(() => Promise.reject<string | null>(new Error("db unreachable")));
    const r = new CustomDomainTenantResolver({ lookup });
    await expect(r.resolve(makeInput("custom.example.com"))).rejects.toMatchObject({
      name: "TenantResolverError",
    });
  });

  it("includes the hostname on the wrapped error", async () => {
    const lookup = vi.fn(() => Promise.reject<string | null>(new Error("db down")));
    const r = new CustomDomainTenantResolver({ lookup });
    try {
      await r.resolve(makeInput("custom.example.com"));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TenantResolverError);
      expect((err as TenantResolverError).hostname).toBe("custom.example.com");
    }
  });
});
