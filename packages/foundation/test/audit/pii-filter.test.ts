/**
 * Tests for `PiiFilter`.
 *
 * Coverage:
 *   - Known PII keys are redacted (default strategy)
 *   - Unknown keys pass through unchanged
 *   - Drop strategy removes the key entirely
 *   - Recursive: nested objects + arrays
 *   - Custom keys replace or extend the default list
 *   - Case-insensitive key matching
 *   - Property-based: random nested JSON with PII keys is always redacted
 *   - Input is never mutated
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { PiiFilter, DEFAULT_PII_KEYS } from "../../src/audit/pii-filter.js";
import type { JsonValue } from "../../src/types/frozen/audit.js";

describe("PiiFilter — default", () => {
  it("redacts password", () => {
    const f = new PiiFilter();
    expect(f.apply({ password: "hunter2" })).toEqual({ password: "[REDACTED]" });
  });

  it("redacts access_token", () => {
    const f = new PiiFilter();
    expect(f.apply({ access_token: "abc" })).toEqual({ access_token: "[REDACTED]" });
  });

  it("passes through unknown keys", () => {
    const f = new PiiFilter();
    expect(f.apply({ user_id: "u_123", email: "x@y.com" })).toEqual({
      user_id: "u_123",
      email: "x@y.com",
    });
  });

  it("is case-insensitive on key names", () => {
    const f = new PiiFilter();
    expect(f.apply({ PASSWORD: "x", Authorization: "y" })).toEqual({
      PASSWORD: "[REDACTED]",
      Authorization: "[REDACTED]",
    });
  });
});

describe("PiiFilter — drop strategy", () => {
  it("removes the key entirely", () => {
    const f = new PiiFilter({ strategy: "drop" });
    const out = f.apply({ password: "x", ok: "y" });
    expect(out).not.toHaveProperty("password");
    expect(out["ok"]).toBe("y");
  });
});

describe("PiiFilter — recursive", () => {
  it("scrubs nested objects", () => {
    const f = new PiiFilter();
    const out = f.apply({
      outer: {
        password: "x",
        keep: "y",
      },
    });
    expect(out).toEqual({
      outer: {
        password: "[REDACTED]",
        keep: "y",
      },
    });
  });

  it("scrubs objects nested inside arrays", () => {
    const f = new PiiFilter();
    const out = f.apply({
      events: [{ password: "x" }, { keep: "y" }],
    });
    expect(out).toEqual({
      events: [{ password: "[REDACTED]" }, { keep: "y" }],
    });
  });

  it("handles null values", () => {
    const f = new PiiFilter();
    expect(f.apply({ x: null })).toEqual({ x: null });
  });

  it("handles primitive values", () => {
    const f = new PiiFilter();
    expect(f.apply({ count: 5, ok: true, name: "x" })).toEqual({
      count: 5,
      ok: true,
      name: "x",
    });
  });
});

describe("PiiFilter — custom keys", () => {
  it("replaces the denylist with custom keys", () => {
    const f = new PiiFilter({ keys: ["custom_field"] });
    const out = f.apply({ custom_field: "x", password: "should-pass" });
    expect(out["custom_field"]).toBe("[REDACTED]");
    expect(out["password"]).toBe("should-pass");
  });

  it("extends the default denylist via additionalKeys", () => {
    const f = new PiiFilter({ additionalKeys: ["custom_field"] });
    const out = f.apply({ custom_field: "x", password: "y" });
    expect(out["custom_field"]).toBe("[REDACTED]");
    expect(out["password"]).toBe("[REDACTED]");
  });
});

describe("PiiFilter — immutability", () => {
  it("does not mutate the input", () => {
    const f = new PiiFilter();
    const input = { password: "x", keep: "y" };
    const snapshot = { ...input };
    f.apply(input);
    expect(input).toEqual(snapshot);
  });
});

describe("PiiFilter — idempotency (redact twice == redact once)", () => {
  it("redacting an already-redacted payload yields an identical result (default strategy)", () => {
    const f = new PiiFilter();
    const input = {
      password: "hunter2",
      keep: "ok",
      nested: { token: "abc", arr: [{ secret: "s" }, { plain: 1 }] },
    };
    const once = f.apply(input);
    const twice = f.apply(once as Record<string, JsonValue>);
    expect(twice).toEqual(once);
    // And the sensitive values really are the sentinel, not the original.
    expect((once as Record<string, JsonValue>)["password"]).toBe("[REDACTED]");
  });

  it("idempotent under the drop strategy (second pass removes nothing new)", () => {
    const f = new PiiFilter({ strategy: "drop" });
    const input = { password: "x", keep: "y", nested: { token: "t", ok: "z" } };
    const once = f.apply(input);
    const twice = f.apply(once as Record<string, JsonValue>);
    expect(twice).toEqual(once);
    expect(once).not.toHaveProperty("password");
  });

  it("property: apply(apply(x)) === apply(x) for arbitrary nested JSON", () => {
    const f = new PiiFilter();
    const valueArb: fc.Arbitrary<JsonValue> = fc.letrec((tie) => ({
      json: fc.oneof(
        { depthSize: "small" },
        fc.string(),
        fc.integer(),
        fc.boolean(),
        fc.constant(null),
        fc.array(tie("json") as fc.Arbitrary<JsonValue>, { maxLength: 3 }),
        fc.dictionary(
          // Bias the key space toward known PII keys so redaction actually fires.
          fc.oneof(fc.constantFrom(...DEFAULT_PII_KEYS), fc.string({ minLength: 1, maxLength: 8 })),
          tie("json") as fc.Arbitrary<JsonValue>,
          { maxKeys: 4 },
        ),
      ),
    })).json as fc.Arbitrary<JsonValue>;
    const objArb = fc.dictionary(
      fc.oneof(fc.constantFrom(...DEFAULT_PII_KEYS), fc.string({ minLength: 1, maxLength: 8 })),
      valueArb,
      { maxKeys: 5 },
    );
    fc.assert(
      fc.property(objArb, (obj) => {
        const once = f.apply(obj);
        const twice = f.apply(once as Record<string, JsonValue>);
        expect(twice).toEqual(once);
      }),
      { numRuns: 300, seed: 0xc0ffee },
    );
  });
});

describe("PiiFilter — property based", () => {
  it("a key matching the default denylist is always redacted, no matter the depth", () => {
    const f = new PiiFilter();
    const piiKeys = [...DEFAULT_PII_KEYS];

    const valueArb: fc.Arbitrary<JsonValue> = fc.letrec((tie) => ({
      json: fc.oneof(
        { depthSize: "small" },
        fc.string(),
        fc.integer(),
        fc.boolean(),
        fc.constant(null),
        fc.array(tie("json") as fc.Arbitrary<JsonValue>, { maxLength: 3 }),
        fc.dictionary(
          fc.string({ minLength: 1, maxLength: 8 }),
          tie("json") as fc.Arbitrary<JsonValue>,
          {
            maxKeys: 3,
          },
        ),
      ),
    })).json as fc.Arbitrary<JsonValue>;

    // Generate a random nested object with one path that contains a PII
    // key at a known depth; assert the value at that key is redacted.
    fc.assert(
      fc.property(
        fc.constantFrom(...piiKeys),
        fc.string(),
        valueArb,
        (piiKey, secretVal, surrounding) => {
          const input = {
            outer: {
              inner: {
                [piiKey]: secretVal,
                noise: surrounding,
              },
            },
          };
          const out = f.apply(input);
          const inner = (out["outer"] as { inner: Record<string, JsonValue> }).inner;
          expect(inner[piiKey]).toBe("[REDACTED]");
        },
      ),
      { numRuns: 200, seed: 0xc0ffee },
    );
  });
});
