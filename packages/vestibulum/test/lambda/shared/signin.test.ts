/**
 * Pure helpers behind the sign-in invariants (src/lambda/shared/signin.ts).
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  BINDING_COOKIE_NAME,
  buildBindingCookie,
  clearBindingCookie,
  hashBindingSecret,
  newBindingSecret,
  parseMs,
  parseTokenTtlMinutes,
  readCookie,
  withFloor,
} from "../../../src/lambda/shared/signin.js";

describe("parseTokenTtlMinutes (signin_link_expires_10min bounds)", () => {
  it("defaults to 10 when unset or empty", () => {
    expect(parseTokenTtlMinutes(undefined)).toBe(10);
    expect(parseTokenTtlMinutes("")).toBe(10);
  });

  it("P: defined iff the string is an integer in [3, 15]", () => {
    fc.assert(
      fc.property(fc.oneof(fc.integer({ min: -50, max: 100 }).map(String), fc.string()), (raw) => {
        const parsed = parseTokenTtlMinutes(raw);
        const isInt = /^\d+$/.test(raw);
        const n = Number.parseInt(raw, 10);
        const valid = raw === "" || (isInt && n >= 3 && n <= 15);
        expect(parsed !== undefined).toBe(valid);
        if (parsed !== undefined && raw !== "") expect(parsed).toBe(n);
      }),
      { numRuns: 500 },
    );
  });

  it.each(["2", "16", "-5", "1e1", "10.0", " 10", "0x0a", "٣"])("rejects %j", (raw) => {
    expect(parseTokenTtlMinutes(raw)).toBeUndefined();
  });
});

describe("parseMs", () => {
  it("uses the fallback for unset or non-numeric values", () => {
    expect(parseMs(undefined, 7)).toBe(7);
    expect(parseMs("abc", 7)).toBe(7);
    expect(parseMs("-1", 7)).toBe(7);
    expect(parseMs("900", 7)).toBe(900);
  });
});

describe("binding secret and cookie (signin_link_bound_to_requesting_browser)", () => {
  it("secrets are 256-bit, base64url, and distinct", () => {
    const a = newBindingSecret();
    const b = newBindingSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it("H(b) is a stable SHA-256 hex and never contains b", () => {
    const b = newBindingSecret();
    const h = hashBindingSecret(b);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(hashBindingSecret(b));
    expect(h).not.toContain(b);
  });

  it("the cookie satisfies the __Host- prefix rules and the spec's attributes", () => {
    const c = buildBindingCookie("abc", 600);
    const attrs = c.split(";").map((p) => p.trim());
    expect(attrs[0]).toBe(`${BINDING_COOKIE_NAME}=abc`);
    expect(BINDING_COOKIE_NAME.startsWith("__Host-")).toBe(true);
    expect(attrs).toEqual(
      expect.arrayContaining(["Secure", "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=600"]),
    );
    expect(c).not.toMatch(/Domain/i); // forbidden by __Host-
  });

  it("clearing uses the same attributes with Max-Age=0 and an empty value", () => {
    const c = clearBindingCookie();
    expect(c.startsWith(`${BINDING_COOKIE_NAME}=;`)).toBe(true);
    expect(c).toContain("Max-Age=0");
    expect(c).toContain("Path=/");
    expect(c).not.toMatch(/Domain/i);
  });
});

describe("readCookie", () => {
  const name = BINDING_COOKIE_NAME;

  it("reads from the `cookies` array, the `cookie` header, or both", () => {
    expect(readCookie({ cookies: [`${name}=v1`] }, name)).toBe("v1");
    expect(readCookie({ headers: { cookie: `a=1; ${name}=v2; b=2` } }, name)).toBe("v2");
    expect(readCookie({ cookies: ["a=1"], headers: { cookie: `${name}=v3` } }, name)).toBe("v3");
  });

  it("returns undefined when absent or empty, and does not match by prefix or suffix", () => {
    expect(readCookie({}, name)).toBeUndefined();
    expect(readCookie({ cookies: [`${name}=`] }, name)).toBeUndefined();
    expect(readCookie({ cookies: [`x${name}=v`, `${name}x=v`] }, name)).toBeUndefined();
  });

  it("keeps '=' inside a value", () => {
    expect(readCookie({ cookies: [`${name}=a=b==`] }, name)).toBe("a=b==");
  });
});

describe("withFloor", () => {
  const harness = () => {
    let t = 1000;
    const slept: number[] = [];
    return {
      slept,
      advance: (ms: number) => void (t += ms),
      now: () => t,
      sleep: (ms: number) => (slept.push(ms), Promise.resolve()),
    };
  };

  it("sleeps the remainder after fast work", async () => {
    const h = harness();
    const out = await withFloor(500, h.now, h.sleep, () => (h.advance(120), Promise.resolve("ok")));
    expect(out).toBe("ok");
    expect(h.slept).toEqual([380]);
  });

  it("does not sleep when the work already took longer than the floor", async () => {
    const h = harness();
    await withFloor(500, h.now, h.sleep, () => (h.advance(900), Promise.resolve()));
    expect(h.slept).toEqual([]);
  });

  it("holds the floor on a thrown error, then rethrows it", async () => {
    const h = harness();
    await expect(
      withFloor(500, h.now, h.sleep, () => (h.advance(100), Promise.reject(new Error("boom")))),
    ).rejects.toThrow("boom");
    expect(h.slept).toEqual([400]);
  });
});
