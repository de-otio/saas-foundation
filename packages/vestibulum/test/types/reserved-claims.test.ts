import { describe, it, expect } from "vitest";
import { RESERVED_CLAIMS, isReservedClaim } from "../../src/types/reserved-claims.js";

describe("RESERVED_CLAIMS", () => {
  it("is a ReadonlySet", () => {
    expect(RESERVED_CLAIMS).toBeInstanceOf(Set);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(RESERVED_CLAIMS)).toBe(true);
  });

  it("rejects add() mutation attempts", () => {
    expect(() => {
      // @ts-expect-error — runtime guard
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      RESERVED_CLAIMS.add("attacker_added");
    }).toThrow(TypeError);
    expect(RESERVED_CLAIMS.has("attacker_added")).toBe(false);
  });

  it("rejects delete() mutation attempts", () => {
    expect(() => {
      // @ts-expect-error — runtime guard
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      RESERVED_CLAIMS.delete("iss");
    }).toThrow(TypeError);
    expect(RESERVED_CLAIMS.has("iss")).toBe(true);
  });

  it("rejects clear() mutation attempts", () => {
    expect(() => {
      // @ts-expect-error — runtime guard
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      RESERVED_CLAIMS.clear();
    }).toThrow(TypeError);
    expect(RESERVED_CLAIMS.size).toBeGreaterThan(0);
  });

  it.each([
    "iss",
    "sub",
    "aud",
    "exp",
    "iat",
    "nbf",
    "jti",
    "nonce",
    "origin_jti",
    "acr",
    "amr",
    "azp",
    "auth_time",
    "token_use",
    "client_id",
    "event_id",
    "cognito:username",
  ])("includes %s", (claim) => {
    expect(RESERVED_CLAIMS.has(claim)).toBe(true);
  });

  it.each([
    // Modifiable per the Cognito docs — NOT reserved.
    "email",
    "name",
    "family_name",
    "given_name",
    "email_verified",
    // Custom claims.
    "custom:tenant_id",
    "custom:role",
  ])("does NOT include %s (modifiable)", (claim) => {
    expect(RESERVED_CLAIMS.has(claim)).toBe(false);
  });
});

describe("isReservedClaim", () => {
  it("returns true for reserved claims", () => {
    expect(isReservedClaim("iss")).toBe(true);
    expect(isReservedClaim("token_use")).toBe(true);
  });

  it("returns false for non-reserved claims", () => {
    expect(isReservedClaim("email")).toBe(false);
    expect(isReservedClaim("custom:tenant_id")).toBe(false);
  });

  it("returns false for empty / random strings", () => {
    expect(isReservedClaim("")).toBe(false);
    expect(isReservedClaim("made_up_claim")).toBe(false);
  });
});
