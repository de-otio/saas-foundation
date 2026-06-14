/**
 * Unit tests for `prop-validation.ts`. Pure functions, no CDK
 * instantiation — every validation rule has a positive ("happy") test
 * and a negative ("rejected with clear message") test.
 */

import { describe, expect, it } from "vitest";
import {
  validateCustomAttributeDeclarations,
  validateSesIdentitySender,
  validateSenderMatchesHostedZone,
  validateSignupModeForFederation,
  validateTokenSize,
  estimateTokenSizeBytes,
  MagicLinkIdentityPropsError,
  MAX_CUSTOM_ATTRIBUTE_NAME_LENGTH,
  MIN_CUSTOM_ATTRIBUTE_NAME_LENGTH,
  TOKEN_SIZE_ERROR_THRESHOLD_BYTES,
  TOKEN_SIZE_WARNING_THRESHOLD_BYTES,
  BASE_CLAIMS_OVERHEAD_BYTES,
  type CustomAttributeDeclaration,
} from "../../lib/magic-link-identity/index.js";

describe("validateCustomAttributeDeclarations", () => {
  it("accepts an empty array", () => {
    expect(() => validateCustomAttributeDeclarations([])).not.toThrow();
  });

  it("accepts a well-formed string attribute", () => {
    expect(() =>
      validateCustomAttributeDeclarations([
        { name: "tenantId", dataType: "String", maxLength: 36, mutable: true },
      ]),
    ).not.toThrow();
  });

  it("rejects names containing invalid characters", () => {
    expect(() =>
      validateCustomAttributeDeclarations([{ name: "bad-name", dataType: "String" }]),
    ).toThrowError(MagicLinkIdentityPropsError);
  });

  it("rejects names shorter than the minimum (S-C2)", () => {
    // Empty string fails the regex check first; the length check only
    // catches non-empty names that violate the upper bound.
    expect(() =>
      validateCustomAttributeDeclarations([{ name: "", dataType: "String" }]),
    ).toThrowError(MagicLinkIdentityPropsError);
  });

  it("rejects names longer than the maximum (S-C2)", () => {
    const tooLong = "a".repeat(MAX_CUSTOM_ATTRIBUTE_NAME_LENGTH + 1);
    expect(() =>
      validateCustomAttributeDeclarations([{ name: tooLong, dataType: "String" }]),
    ).toThrowError(new RegExp(`${MAX_CUSTOM_ATTRIBUTE_NAME_LENGTH}`));
  });

  it("accepts names at the boundary (1 and 20 chars)", () => {
    expect(() =>
      validateCustomAttributeDeclarations([
        { name: "a".repeat(MIN_CUSTOM_ATTRIBUTE_NAME_LENGTH), dataType: "String" },
        { name: "b".repeat(MAX_CUSTOM_ATTRIBUTE_NAME_LENGTH), dataType: "String" },
      ]),
    ).not.toThrow();
  });

  it("rejects duplicate names", () => {
    expect(() =>
      validateCustomAttributeDeclarations([
        { name: "tenantId", dataType: "String" },
        { name: "tenantId", dataType: "String" },
      ]),
    ).toThrowError(/duplicate/);
  });

  it("rejects required + immutable combinations", () => {
    expect(() =>
      validateCustomAttributeDeclarations([
        {
          name: "tenantId",
          dataType: "String",
          required: true,
          mutable: false,
        },
      ]),
    ).toThrowError(/required and immutable/);
  });

  it("rejects min/max length on non-String types", () => {
    expect(() =>
      validateCustomAttributeDeclarations([{ name: "age", dataType: "Number", minLength: 1 }]),
    ).toThrowError(/minLength.maxLength/);
  });

  it("rejects minLength > maxLength", () => {
    expect(() =>
      validateCustomAttributeDeclarations([
        { name: "x", dataType: "String", minLength: 10, maxLength: 5 },
      ]),
    ).toThrowError(/minLength.*greater than maxLength/);
  });

  it("rejects more than 50 attributes", () => {
    const decls: CustomAttributeDeclaration[] = Array.from({ length: 51 }, (_, i) => ({
      name: `a${i}`,
      dataType: "String" as const,
    }));
    expect(() => validateCustomAttributeDeclarations(decls)).toThrowError(/at most 50/);
  });
});

describe("validateSesIdentitySender", () => {
  it("accepts a well-formed email and returns the domain", () => {
    expect(validateSesIdentitySender("noreply@example.com")).toBe("example.com");
  });

  it("rejects a non-email string", () => {
    expect(() => validateSesIdentitySender("not-an-email")).toThrowError(
      MagicLinkIdentityPropsError,
    );
  });

  it("rejects an empty local-part", () => {
    expect(() => validateSesIdentitySender("@example.com")).toThrowError(/non-empty local-part/);
  });

  it("rejects an empty domain", () => {
    expect(() => validateSesIdentitySender("noreply@")).toThrowError(/non-empty.*domain/);
  });
});

describe("validateSenderMatchesHostedZone", () => {
  it("accepts an exact match", () => {
    expect(() => validateSenderMatchesHostedZone("example.com", "example.com")).not.toThrow();
  });

  it("accepts a subdomain", () => {
    expect(() => validateSenderMatchesHostedZone("mail.example.com", "example.com")).not.toThrow();
  });

  it("rejects an unrelated domain", () => {
    expect(() => validateSenderMatchesHostedZone("other.test", "example.com")).toThrowError(
      /must match or be a subdomain/,
    );
  });
});

describe("validateSignupModeForFederation (B-I)", () => {
  it("accepts federation enabled with explicit open mode", () => {
    expect(() =>
      validateSignupModeForFederation({
        federationEnabled: true,
        signupMode: "open",
      }),
    ).not.toThrow();
  });

  it("accepts federation enabled with admin-invite-only", () => {
    expect(() =>
      validateSignupModeForFederation({
        federationEnabled: true,
        signupMode: "admin-invite-only",
      }),
    ).not.toThrow();
  });

  it("accepts federation disabled with no signup mode", () => {
    expect(() =>
      validateSignupModeForFederation({
        federationEnabled: false,
        signupMode: undefined,
      }),
    ).not.toThrow();
  });

  it("rejects federation enabled without explicit signupMode", () => {
    expect(() =>
      validateSignupModeForFederation({
        federationEnabled: true,
        signupMode: undefined,
      }),
    ).toThrowError(/federationEnabled: true requires.*signupMode/);
  });
});

describe("estimateTokenSizeBytes / validateTokenSize (S-C3)", () => {
  it("returns the base overhead with no attributes", () => {
    expect(estimateTokenSizeBytes([])).toBe(BASE_CLAIMS_OVERHEAD_BYTES);
  });

  it("uses the default attribute size when maxLength is unset", () => {
    const bytes = estimateTokenSizeBytes([{ name: "x", dataType: "String" }]);
    expect(bytes).toBeGreaterThan(BASE_CLAIMS_OVERHEAD_BYTES);
    expect(bytes).toBeLessThan(BASE_CLAIMS_OVERHEAD_BYTES + 512);
  });

  it("returns no warning for small attribute sets", () => {
    const result = validateTokenSize([{ name: "tenantId", dataType: "String", maxLength: 36 }]);
    expect(result.warning).toBeUndefined();
  });

  it("emits a warning when the estimate crosses the warning threshold", () => {
    // Need to push the estimate just above 5 KB but below 6 KB.
    const bigMaxLength = TOKEN_SIZE_WARNING_THRESHOLD_BYTES - BASE_CLAIMS_OVERHEAD_BYTES + 200;
    const result = validateTokenSize([
      { name: "big", dataType: "String", maxLength: bigMaxLength },
    ]);
    expect(result.warning).toMatch(/worst-case ID-token size/);
  });

  it("throws when the estimate crosses the hard error threshold (6 KB)", () => {
    const bigMaxLength = TOKEN_SIZE_ERROR_THRESHOLD_BYTES;
    expect(() =>
      validateTokenSize([{ name: "huge", dataType: "String", maxLength: bigMaxLength }]),
    ).toThrowError(/error threshold/);
  });
});
