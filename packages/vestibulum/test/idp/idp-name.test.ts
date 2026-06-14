import * as fc from "fast-check";
import { describe, it, expect } from "vitest";

import { IdpManagerError } from "../../src/errors.js";
import { normaliseIdpName } from "../../src/idp/idp-name.js";

/**
 * Cognito's documented regex (Unicode-aware).
 */
const COGNITO_PROVIDER_NAME_RE = /^[^_\p{Z}][\p{L}\p{M}\p{S}\p{N}\p{P}][^_\p{Z}]+$/u;
const MAX_TOTAL = 32;

const EMPTY = new Map<string, string>();

function expectCognitoSafe(name: string): void {
  expect(name.length).toBeLessThanOrEqual(MAX_TOTAL);
  expect(COGNITO_PROVIDER_NAME_RE.test(name)).toBe(true);
}

describe("normaliseIdpName — basic cases", () => {
  it("lowercases ASCII input", () => {
    const out = normaliseIdpName("ACME", EMPTY);
    expect(out).toBe("tenant-acme");
    expectCognitoSafe(out);
  });

  it("replaces disallowed characters with -", () => {
    const out = normaliseIdpName("Acme Corp.Inc", EMPTY);
    expect(out).toBe("tenant-acme-corp-inc");
    expectCognitoSafe(out);
  });

  it("collapses runs of - into a single -", () => {
    const out = normaliseIdpName("a---b__c   d", EMPTY);
    expect(out).toBe("tenant-a-b-c-d");
    expectCognitoSafe(out);
  });

  it("strips leading and trailing -", () => {
    const out = normaliseIdpName("---hello---", EMPTY);
    expect(out).toBe("tenant-hello");
    expectCognitoSafe(out);
  });

  it("truncates the slug to 25 characters", () => {
    const out = normaliseIdpName("a".repeat(50), EMPTY);
    expect(out).toBe("tenant-" + "a".repeat(25));
    expect(out.length).toBe(32);
    expectCognitoSafe(out);
  });

  it("strips a trailing - that lands at the truncation boundary", () => {
    const input = "a".repeat(24) + "bb-something";
    const out = normaliseIdpName(input, EMPTY);
    expectCognitoSafe(out);
    expect(out.endsWith("-")).toBe(false);
  });

  it("handles UUIDs (with hyphens)", () => {
    const out = normaliseIdpName("550e8400-e29b-41d4-a716-446655440000", EMPTY);
    expectCognitoSafe(out);
    expect(out).toMatch(/^tenant-/);
  });

  it("handles email-like inputs", () => {
    const out = normaliseIdpName("admin@example.com", EMPTY);
    expect(out).toBe("tenant-admin-example-com");
    expectCognitoSafe(out);
  });
});

describe("normaliseIdpName — degenerate / Unicode input", () => {
  it("substitutes a hash for empty input", () => {
    const out = normaliseIdpName("", EMPTY);
    expect(out).toMatch(/^tenant-x[0-9a-f]+$/);
    expectCognitoSafe(out);
  });

  it("substitutes a hash for whitespace-only input", () => {
    const out = normaliseIdpName("   \t\n", EMPTY);
    expect(out).toMatch(/^tenant-x[0-9a-f]+$/);
    expectCognitoSafe(out);
  });

  it("substitutes a hash for Unicode-only input (Cyrillic)", () => {
    const out = normaliseIdpName("Привет", EMPTY);
    expect(out).toMatch(/^tenant-x[0-9a-f]+$/);
    expectCognitoSafe(out);
  });

  it("substitutes a hash for emoji-only input", () => {
    const out = normaliseIdpName("🦊🚀", EMPTY);
    expect(out).toMatch(/^tenant-x[0-9a-f]+$/);
    expectCognitoSafe(out);
  });

  it("produces stable hashes (same input → same name)", () => {
    expect(normaliseIdpName("🦊", EMPTY)).toBe(normaliseIdpName("🦊", EMPTY));
  });

  it("produces different hashes for different empty-result inputs", () => {
    const a = normaliseIdpName("🦊", EMPTY);
    const b = normaliseIdpName("🚀", EMPTY);
    expect(a).not.toBe(b);
  });

  it("handles leading-underscore input (the original chars are dropped)", () => {
    const out = normaliseIdpName("___foo", EMPTY);
    expect(out).toBe("tenant-foo");
    expectCognitoSafe(out);
  });

  it("handles leading-whitespace input", () => {
    const out = normaliseIdpName("   foo", EMPTY);
    expect(out).toBe("tenant-foo");
    expectCognitoSafe(out);
  });

  it("treats input that normalises to a string of only hyphens via stable hash", () => {
    const out = normaliseIdpName("----", EMPTY);
    expect(out).toMatch(/^tenant-x[0-9a-f]+$/);
    expectCognitoSafe(out);
  });

  it("handles mixed Unicode + ASCII (keeps the ASCII)", () => {
    const out = normaliseIdpName("Tenant 🦊 Acme", EMPTY);
    expect(out).toBe("tenant-tenant-acme");
    expectCognitoSafe(out);
  });
});

describe("normaliseIdpName — 25/26 boundary cases", () => {
  it("exact 25-char ASCII slug is unchanged", () => {
    const input = "a".repeat(25);
    const out = normaliseIdpName(input, EMPTY);
    expect(out).toBe("tenant-" + "a".repeat(25));
    expect(out.length).toBe(32);
    expectCognitoSafe(out);
  });

  it("exact 26-char ASCII slug truncates to 25", () => {
    const input = "a".repeat(26);
    const out = normaliseIdpName(input, EMPTY);
    expect(out).toBe("tenant-" + "a".repeat(25));
    expect(out.length).toBe(32);
    expectCognitoSafe(out);
  });

  it("27-char input that contains hyphens at the truncation boundary", () => {
    const out = normaliseIdpName("abcdefghijklmnopqrstuvwxy-z", EMPTY);
    expectCognitoSafe(out);
    expect(out.startsWith("tenant-")).toBe(true);
    expect(out).toBe("tenant-abcdefghijklmnopqrstuvwxy");
    expect(out.length).toBe(32);
  });
});

describe("normaliseIdpName — collision detection", () => {
  it("passes through when no existing name collides", () => {
    const out = normaliseIdpName("acme", new Map([["other", "tenant-other"]]));
    expect(out).toBe("tenant-acme");
  });

  it("throws name_collision when the same name belongs to another tenant", () => {
    const map = new Map([["existing-tenant", "tenant-acme"]]);
    expect(() => normaliseIdpName("acme", map)).toThrow(IdpManagerError);
    try {
      normaliseIdpName("acme", map);
    } catch (err) {
      expect((err as IdpManagerError).reason).toBe("name_collision");
      expect((err as IdpManagerError).message).toContain("existing-tenant");
    }
  });

  it("does NOT throw on re-upsert of the same tenantId", () => {
    const map = new Map([["acme", "tenant-acme"]]);
    expect(() => normaliseIdpName("acme", map)).not.toThrow();
  });

  it("detects collision arising from truncation", () => {
    const longA = "abcdefghijklmnopqrstuvwxy-tenant-A";
    const longB = "abcdefghijklmnopqrstuvwxy-tenant-B";
    const map = new Map([[longA, normaliseIdpName(longA, EMPTY)]]);
    expect(() => normaliseIdpName(longB, map)).toThrow(IdpManagerError);
  });

  it("detects collision arising from punctuation normalisation", () => {
    const first = normaliseIdpName("Acme Inc", EMPTY);
    const map = new Map([["first", first]]);
    expect(() => normaliseIdpName("acme.inc", map)).toThrow(IdpManagerError);
  });

  it("detects collision arising from the empty-input hash substitution", () => {
    const first = normaliseIdpName("🦊", EMPTY);
    const map = new Map([["cat", first]]);
    expect(() => normaliseIdpName("🦊", map)).toThrow(IdpManagerError);
  });
});

describe("normaliseIdpName — property: every input is Cognito-safe and ≤32 chars", () => {
  it("returns a Cognito-regex-valid name for any input", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 200 }), (input) => {
        const out = normaliseIdpName(input, EMPTY);
        expectCognitoSafe(out);
      }),
    );
  });

  it("returns a Cognito-regex-valid name for full-Unicode input", () => {
    fc.assert(
      fc.property(fc.fullUnicodeString({ minLength: 0, maxLength: 200 }), (input) => {
        const out = normaliseIdpName(input, EMPTY);
        expectCognitoSafe(out);
      }),
    );
  });

  it('always begins with "tenant-"', () => {
    fc.assert(
      fc.property(fc.fullUnicodeString({ minLength: 0, maxLength: 200 }), (input) => {
        const out = normaliseIdpName(input, EMPTY);
        expect(out.startsWith("tenant-")).toBe(true);
      }),
    );
  });

  it("never contains uppercase characters", () => {
    fc.assert(
      fc.property(fc.fullUnicodeString({ minLength: 0, maxLength: 200 }), (input) => {
        const out = normaliseIdpName(input, EMPTY);
        expect(out).toBe(out.toLowerCase());
      }),
    );
  });

  it("produces deterministic output for the same input", () => {
    fc.assert(
      fc.property(fc.fullUnicodeString({ minLength: 0, maxLength: 200 }), (input) => {
        expect(normaliseIdpName(input, EMPTY)).toBe(normaliseIdpName(input, EMPTY));
      }),
    );
  });

  it("is idempotent: normalising its own output preserves it", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 200 }), (input) => {
        const once = normaliseIdpName(input, EMPTY);
        const suffix = once.slice("tenant-".length);
        const third = normaliseIdpName(suffix, EMPTY);
        expectCognitoSafe(third);
        expect(third).toBe(once);
      }),
    );
  });
});
