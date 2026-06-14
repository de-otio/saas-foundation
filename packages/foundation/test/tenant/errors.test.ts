/**
 * Tests for tenant error types — name discriminants and construction.
 */

import { describe, it, expect } from "vitest";

import {
  TenantNotFoundError,
  TenantAuthorizationError,
  TenantResolverError,
} from "../../src/tenant/errors.js";

describe("TenantNotFoundError", () => {
  it("has the expected name", () => {
    const err = new TenantNotFoundError();
    expect(err.name).toBe("TenantNotFoundError");
  });

  it("carries an optional hostname", () => {
    const err = new TenantNotFoundError("missing", "acme.example.com");
    expect(err.hostname).toBe("acme.example.com");
    expect(err.message).toBe("missing");
  });

  it("defaults message when omitted", () => {
    const err = new TenantNotFoundError();
    expect(err.message).toBe("Tenant could not be resolved");
    expect(err.hostname).toBeUndefined();
  });
});

describe("TenantAuthorizationError", () => {
  it("has the expected name", () => {
    const err = new TenantAuthorizationError("suspended");
    expect(err.name).toBe("TenantAuthorizationError");
  });

  it("carries the reason and a prefixed message", () => {
    const err = new TenantAuthorizationError("suspended");
    expect(err.reason).toBe("suspended");
    expect(err.message).toBe("Tenant authorization failed: suspended");
  });
});

describe("TenantResolverError", () => {
  it("has the expected name", () => {
    const err = new TenantResolverError("dns down");
    expect(err.name).toBe("TenantResolverError");
  });

  it("carries the optional hostname and cause", () => {
    const cause = new Error("inner");
    const err = new TenantResolverError("dns down", {
      hostname: "acme.example.com",
      cause,
    });
    expect(err.hostname).toBe("acme.example.com");
    expect(err.cause).toBe(cause);
  });
});
