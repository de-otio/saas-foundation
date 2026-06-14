/**
 * `SessionCookie` round-trip + cookie header parse/serialize tests.
 *
 * One `SessionCookie` instance is built per describe-block so the
 * 600k-PBKDF2 cost is paid once and the derived key is cached for the
 * suite.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  MIN_SALT_LENGTH,
  MIN_SECRET_LENGTH,
  SessionCookie,
  parseCookieHeader,
  serializeSetCookie,
} from "../../src/session/cookie.js";
import { SealError, SessionCookieConfigError } from "../../src/session/errors.js";

const SECRET_A = "a".repeat(MIN_SECRET_LENGTH);
const SECRET_B = "b".repeat(MIN_SECRET_LENGTH);
const SALT = "s".repeat(MIN_SALT_LENGTH);

describe("SessionCookie — constructor validation", () => {
  it("rejects a primarySecret shorter than MIN_SECRET_LENGTH", () => {
    expect(() => new SessionCookie({ primarySecret: "short", salt: SALT })).toThrow(
      SessionCookieConfigError,
    );
  });

  it("rejects a missing salt", () => {
    expect(() => new SessionCookie({ primarySecret: SECRET_A, salt: "tooshort" })).toThrow(
      SessionCookieConfigError,
    );
  });

  it("rejects a non-string primarySecret", () => {
    expect(
      () =>
        new SessionCookie({
          primarySecret: 42 as unknown as string,
          salt: SALT,
        }),
    ).toThrow(SessionCookieConfigError);
  });

  it("rejects a fallbackSecret shorter than MIN_SECRET_LENGTH", () => {
    expect(
      () =>
        new SessionCookie({
          primarySecret: SECRET_A,
          fallbackSecret: "short",
          salt: SALT,
        }),
    ).toThrow(SessionCookieConfigError);
  });

  it("rejects iterations below DEFAULT_PBKDF2_ITERATIONS", () => {
    expect(
      () =>
        new SessionCookie({
          primarySecret: SECRET_A,
          salt: SALT,
          iterations: 1000,
        }),
    ).toThrow(SessionCookieConfigError);
  });

  it("rejects non-integer iterations", () => {
    expect(
      () =>
        new SessionCookie({
          primarySecret: SECRET_A,
          salt: SALT,
          iterations: 600_000.5,
        }),
    ).toThrow(SessionCookieConfigError);
  });

  it("accepts iterations exactly at the OWASP minimum", () => {
    expect(
      () =>
        new SessionCookie({
          primarySecret: SECRET_A,
          salt: SALT,
          iterations: 600_000,
        }),
    ).not.toThrow();
  });
});

describe("SessionCookie — seal/unseal round-trip", () => {
  let cookie: SessionCookie;
  beforeAll(() => {
    cookie = new SessionCookie({ primarySecret: SECRET_A, salt: SALT });
  });

  it("seal then unseal returns the original payload", async () => {
    const sealed = await cookie.seal("hello world");
    const unsealed = await cookie.unseal(sealed);
    expect(unsealed).toBe("hello world");
  });

  it("unseal returns null for unrelated random base64", async () => {
    const bogus = Buffer.from(new Uint8Array(64)).toString("base64");
    const unsealed = await cookie.unseal(bogus);
    expect(unsealed).toBeNull();
  });

  it("unseal returns null for an empty token", async () => {
    expect(await cookie.unseal("")).toBeNull();
  });

  it("sealing the same payload twice yields different ciphertext", async () => {
    const a = await cookie.seal("x");
    const b = await cookie.seal("x");
    expect(a).not.toBe(b);
  });
});

describe("SessionCookie — sealJson / unsealJson", () => {
  let cookie: SessionCookie;
  beforeAll(() => {
    cookie = new SessionCookie({ primarySecret: SECRET_A, salt: SALT });
  });

  it("sealJson then unseal+JSON.parse round-trips a plain object", async () => {
    const obj = { userId: "u1", role: "admin" };
    const sealed = await cookie.sealJson(obj);
    const unsealed = await cookie.unseal(sealed);
    if (unsealed === null) throw new Error("expected unseal to succeed");
    expect(JSON.parse(unsealed)).toEqual(obj);
  });

  it("sealJson throws on a circular reference (non-serialisable input)", async () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    await expect(cookie.sealJson(obj)).rejects.toBeInstanceOf(SealError);
  });

  it("sealJson throws SealError when JSON.stringify returns undefined", async () => {
    // A function value alone serialises to undefined in JSON.stringify.
    const fn = (): void => undefined;
    await expect(cookie.sealJson(fn)).rejects.toBeInstanceOf(SealError);
  });
});

describe("SessionCookie — secret rotation (primary + fallback)", () => {
  it("a cookie sealed with old primary unsealable via new instance's fallback", async () => {
    const oldCookie = new SessionCookie({ primarySecret: SECRET_A, salt: SALT });
    const sealed = await oldCookie.seal("payload-from-v1");

    const newCookie = new SessionCookie({
      primarySecret: SECRET_B,
      fallbackSecret: SECRET_A,
      salt: SALT,
    });
    const unsealed = await newCookie.unseal(sealed);
    expect(unsealed).toBe("payload-from-v1");
  });

  it("new cookies are sealed with the primary, not the fallback", async () => {
    const newCookie = new SessionCookie({
      primarySecret: SECRET_B,
      fallbackSecret: SECRET_A,
      salt: SALT,
    });
    const oldCookie = new SessionCookie({ primarySecret: SECRET_A, salt: SALT });
    const sealedByNew = await newCookie.seal("hi");
    // Should NOT decrypt with the old (which was demoted to fallback).
    expect(await oldCookie.unseal(sealedByNew)).toBeNull();
  });

  it("returns null when neither primary nor fallback matches", async () => {
    const v1 = new SessionCookie({ primarySecret: SECRET_A, salt: SALT });
    const sealed = await v1.seal("payload");
    const v3 = new SessionCookie({
      primarySecret: "c".repeat(MIN_SECRET_LENGTH),
      fallbackSecret: "d".repeat(MIN_SECRET_LENGTH),
      salt: SALT,
    });
    expect(await v3.unseal(sealed)).toBeNull();
  });
});

describe("parseCookieHeader", () => {
  it("parses a single cookie", () => {
    const result = parseCookieHeader("session=abc123");
    expect(result.session).toBe("abc123");
  });

  it("parses multiple cookies", () => {
    const result = parseCookieHeader("a=1; b=2; c=3");
    expect(result).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("returns an empty record for null", () => {
    const result = parseCookieHeader(null);
    expect(result).toEqual({});
  });

  it("returns an empty record for undefined", () => {
    const result = parseCookieHeader(undefined);
    expect(result).toEqual({});
  });

  it("returns an empty record for empty string", () => {
    const result = parseCookieHeader("");
    expect(result).toEqual({});
  });

  it("decodes URL-encoded values", () => {
    const result = parseCookieHeader("name=hello%20world");
    expect(result.name).toBe("hello world");
  });

  it("returns a frozen object", () => {
    const result = parseCookieHeader("a=1");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("handles malformed entries by skipping them", () => {
    // The cookie package gracefully ignores entirely-malformed segments.
    const result = parseCookieHeader("=novalue; valid=ok");
    expect(result.valid).toBe("ok");
  });
});

describe("serializeSetCookie", () => {
  it("emits HttpOnly, Secure, SameSite=Lax, Path=/ by default", () => {
    const out = serializeSetCookie("session", "abc");
    expect(out).toContain("session=abc");
    expect(out).toContain("HttpOnly");
    expect(out).toContain("Secure");
    expect(out).toContain("SameSite=Lax");
    expect(out).toContain("Path=/");
  });

  it("honours httpOnly: false", () => {
    const out = serializeSetCookie("session", "abc", { httpOnly: false });
    expect(out).not.toContain("HttpOnly");
  });

  it("honours secure: false", () => {
    const out = serializeSetCookie("session", "abc", { secure: false });
    expect(out).not.toContain("Secure");
  });

  it("honours sameSite=strict", () => {
    const out = serializeSetCookie("session", "abc", { sameSite: "strict" });
    expect(out).toContain("SameSite=Strict");
  });

  it("honours sameSite=none", () => {
    const out = serializeSetCookie("session", "abc", { sameSite: "none" });
    expect(out).toContain("SameSite=None");
  });

  it("emits Domain when set", () => {
    const out = serializeSetCookie("session", "abc", { domain: "example.com" });
    expect(out).toContain("Domain=example.com");
  });

  it("emits Max-Age when set", () => {
    const out = serializeSetCookie("session", "abc", { maxAge: 3600 });
    expect(out).toContain("Max-Age=3600");
  });

  it("emits Expires when set", () => {
    // The Date global is banned in tests by the determinism rules. Use
    // vi.useFakeTimers + a pinned epoch so the constructed Date is
    // deterministic and the lint rule has a justified exception.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      // eslint-disable-next-line no-restricted-globals
      const fixedDate = new Date();
      const out = serializeSetCookie("session", "abc", { expires: fixedDate });
      expect(out).toContain("Expires=");
    } finally {
      vi.useRealTimers();
    }
  });

  it("honours a custom path", () => {
    const out = serializeSetCookie("session", "abc", { path: "/api" });
    expect(out).toContain("Path=/api");
  });

  it("URL-encodes the value", () => {
    const out = serializeSetCookie("session", "hello world");
    expect(out).toContain("hello%20world");
  });
});

describe("parseCookieHeader / serializeSetCookie — round-trip", () => {
  it("a serialized value round-trips through the parser", () => {
    const serialized = serializeSetCookie("token", "base64+something/here=");
    // Set-Cookie includes attributes; extract the `name=value` prefix.
    const valuePart = serialized.split(";")[0];
    if (valuePart === undefined) throw new Error("expected at least one segment");
    const parsed = parseCookieHeader(valuePart);
    expect(parsed.token).toBe("base64+something/here=");
  });
});
