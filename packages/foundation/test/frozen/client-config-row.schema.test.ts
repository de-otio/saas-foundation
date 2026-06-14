/**
 * Schema tests for `ClientConfigRowSchema`.
 *
 * Tests the Zod schema that guards the DDB ClientConfig table row shape.
 * Covers valid and invalid inputs for each field, plus a property test
 * showing that any valid TenantSubdomain + TenantId produces a valid row
 * when other fields are well-formed.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  ClientConfigRowSchema,
  TenantSubdomainSchema,
  TenantIdSchema,
} from "../../src/types/frozen/schemas.js";
import { isTenantSubdomain } from "../../src/types/frozen/tenant-subdomain.js";
import { isTenantId } from "../../src/types/frozen/tenant.js";

const RUN_OPTIONS = { numRuns: 1000, seed: 0xc0ffee } as const;

/** A known-good base row for cloning in negative tests. */
const VALID_ROW = {
  clientId: "us-east-1_abc123_client",
  subdomain: "acme",
  tenantId: "tenant-acme",
  siteBaseUrl: "https://acme.tenants.example.com",
  allowedEmailDomains: ["acme.com", "acme.org"],
  createdAt: "2024-01-01T00:00:00.000Z",
} as const;

describe("ClientConfigRowSchema — valid inputs", () => {
  it("accepts a complete well-formed row", () => {
    const result = ClientConfigRowSchema.safeParse(VALID_ROW);
    expect(result.success).toBe(true);
  });

  it("accepts a row with updatedAt set", () => {
    const result = ClientConfigRowSchema.safeParse({
      ...VALID_ROW,
      updatedAt: "2024-06-15T12:30:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a row with empty allowedEmailDomains", () => {
    const result = ClientConfigRowSchema.safeParse({
      ...VALID_ROW,
      allowedEmailDomains: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a row with updatedAt absent (optional)", () => {
    const { updatedAt: _u, ...withoutUpdated } = { ...VALID_ROW, updatedAt: undefined };
    const result = ClientConfigRowSchema.safeParse(withoutUpdated);
    expect(result.success).toBe(true);
  });
});

describe("ClientConfigRowSchema — invalid clientId", () => {
  it("rejects empty clientId", () => {
    const result = ClientConfigRowSchema.safeParse({ ...VALID_ROW, clientId: "" });
    expect(result.success).toBe(false);
  });
});

describe("ClientConfigRowSchema — invalid subdomain", () => {
  it("rejects uppercase subdomain", () => {
    const result = ClientConfigRowSchema.safeParse({ ...VALID_ROW, subdomain: "ACME" });
    expect(result.success).toBe(false);
  });

  it("rejects subdomain starting with digit", () => {
    const result = ClientConfigRowSchema.safeParse({ ...VALID_ROW, subdomain: "1acme" });
    expect(result.success).toBe(false);
  });

  it("rejects subdomain ending with hyphen", () => {
    const result = ClientConfigRowSchema.safeParse({ ...VALID_ROW, subdomain: "acme-" });
    expect(result.success).toBe(false);
  });

  it("rejects subdomain that is too short (2 chars)", () => {
    const result = ClientConfigRowSchema.safeParse({ ...VALID_ROW, subdomain: "ab" });
    expect(result.success).toBe(false);
  });

  it("rejects subdomain that is too long (64 chars)", () => {
    const result = ClientConfigRowSchema.safeParse({
      ...VALID_ROW,
      subdomain: "a" + "b".repeat(62) + "c",
    });
    expect(result.success).toBe(false);
  });
});

describe("ClientConfigRowSchema — invalid tenantId", () => {
  it("rejects empty tenantId", () => {
    const result = ClientConfigRowSchema.safeParse({ ...VALID_ROW, tenantId: "" });
    expect(result.success).toBe(false);
  });

  it("rejects tenantId with control characters", () => {
    const result = ClientConfigRowSchema.safeParse({
      ...VALID_ROW,
      tenantId: "tenant\x00id",
    });
    expect(result.success).toBe(false);
  });
});

describe("ClientConfigRowSchema — invalid siteBaseUrl", () => {
  it("rejects non-URL string", () => {
    const result = ClientConfigRowSchema.safeParse({
      ...VALID_ROW,
      siteBaseUrl: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  it("rejects http:// URL (must be https)", () => {
    const result = ClientConfigRowSchema.safeParse({
      ...VALID_ROW,
      siteBaseUrl: "http://acme.tenants.example.com",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty string", () => {
    const result = ClientConfigRowSchema.safeParse({ ...VALID_ROW, siteBaseUrl: "" });
    expect(result.success).toBe(false);
  });
});

describe("ClientConfigRowSchema — invalid allowedEmailDomains", () => {
  it("rejects non-array value", () => {
    const result = ClientConfigRowSchema.safeParse({
      ...VALID_ROW,
      allowedEmailDomains: "acme.com",
    });
    expect(result.success).toBe(false);
  });

  it("rejects array containing an empty string", () => {
    const result = ClientConfigRowSchema.safeParse({
      ...VALID_ROW,
      allowedEmailDomains: ["acme.com", ""],
    });
    expect(result.success).toBe(false);
  });

  it("rejects array containing an invalid domain (no dot)", () => {
    const result = ClientConfigRowSchema.safeParse({
      ...VALID_ROW,
      allowedEmailDomains: ["nodot"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects array containing uppercase domain", () => {
    const result = ClientConfigRowSchema.safeParse({
      ...VALID_ROW,
      allowedEmailDomains: ["ACME.COM"],
    });
    expect(result.success).toBe(false);
  });
});

describe("ClientConfigRowSchema — invalid datetime fields", () => {
  it("rejects non-datetime createdAt", () => {
    const result = ClientConfigRowSchema.safeParse({
      ...VALID_ROW,
      createdAt: "not-a-date",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-datetime updatedAt when provided", () => {
    const result = ClientConfigRowSchema.safeParse({
      ...VALID_ROW,
      updatedAt: "2024-13-01",
    });
    expect(result.success).toBe(false);
  });
});

describe("ClientConfigRowSchema — property tests", () => {
  /**
   * Generator: a valid TenantSubdomain string.
   * Structure: [a-z] + [a-z0-9-]{1,61} + [a-z0-9]
   */
  const bodyCharArb = fc.constantFrom(...("abcdefghijklmnopqrstuvwxyz0123456789-".split("")));
  const boundaryCharArb = fc.constantFrom(
    ...("abcdefghijklmnopqrstuvwxyz0123456789".split("")),
  );

  const validSubdomainArb = fc
    .tuple(
      fc.constantFrom(...("abcdefghijklmnopqrstuvwxyz".split(""))),
      fc.array(bodyCharArb, { minLength: 1, maxLength: 61 }),
      boundaryCharArb,
    )
    .map(([start, middle, end]) => start + middle.join("") + end)
    .filter((s) => isTenantSubdomain(s));

  /**
   * Generator: a valid TenantId (non-empty, no whitespace/control chars).
   */
  const validTenantIdCharArb = fc.constantFrom(
    ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_".split(""),
  );
  const validTenantIdArb = fc
    .array(validTenantIdCharArb, { minLength: 1, maxLength: 64 })
    .map((chars) => chars.join(""))
    .filter((s) => isTenantId(s));

  it("any valid TenantSubdomain + TenantId produces a valid row when other fields are well-formed", () => {
    fc.assert(
      fc.property(validSubdomainArb, validTenantIdArb, (subdomain, tenantId) => {
        const row = {
          clientId: "client-id-12345",
          subdomain,
          tenantId,
          siteBaseUrl: `https://${subdomain}.tenants.example.com`,
          allowedEmailDomains: ["example.com"],
          createdAt: "2024-01-01T00:00:00.000Z",
        };
        const result = ClientConfigRowSchema.safeParse(row);
        expect(result.success).toBe(true);
      }),
      RUN_OPTIONS,
    );
  });

  it("TenantSubdomainSchema accepts exactly the inputs isTenantSubdomain accepts", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const schemaResult = TenantSubdomainSchema.safeParse(input);
        expect(schemaResult.success).toBe(isTenantSubdomain(input));
      }),
      RUN_OPTIONS,
    );
  });

  it("TenantIdSchema accepts exactly the inputs isTenantId accepts", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const schemaResult = TenantIdSchema.safeParse(input);
        expect(schemaResult.success).toBe(isTenantId(input));
      }),
      RUN_OPTIONS,
    );
  });
});
