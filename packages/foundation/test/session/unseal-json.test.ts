/**
 * `unsealJson<T>` schema-validation tests (review S-Sec3).
 *
 * The schema parameter is REQUIRED. On a decrypted payload that fails
 * the schema, `unsealJson` throws `UnsealError`. On a decrypted
 * payload that parses and validates, it returns the typed object.
 * On a token that does not decrypt at all, it returns `null`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { MIN_SALT_LENGTH, MIN_SECRET_LENGTH, SessionCookie } from "../../src/session/cookie.js";
import { UnsealError } from "../../src/session/errors.js";

const SECRET = "k".repeat(MIN_SECRET_LENGTH);
const SALT = "s".repeat(MIN_SALT_LENGTH);

const SessionSchema = z.object({
  userId: z.string(),
  role: z.enum(["admin", "user"]),
  expiresAt: z.number(),
});

type Session = z.infer<typeof SessionSchema>;

describe("unsealJson<T>(token, schema)", () => {
  let cookie: SessionCookie;
  beforeAll(() => {
    cookie = new SessionCookie({ primarySecret: SECRET, salt: SALT });
  });

  it("returns the typed object on schema match", async () => {
    const session: Session = { userId: "u1", role: "admin", expiresAt: 9999 };
    const sealed = await cookie.sealJson(session);
    const unsealed = await cookie.unsealJson(sealed, SessionSchema);
    expect(unsealed).toEqual(session);
    if (unsealed === null) throw new Error("expected unsealJson to succeed");
    // TypeScript narrows — exercise the typed access:
    expect(unsealed.role).toBe("admin");
  });

  it("returns null when the token cannot be decrypted", async () => {
    const bogus = Buffer.from(new Uint8Array(64)).toString("base64");
    const unsealed = await cookie.unsealJson(bogus, SessionSchema);
    expect(unsealed).toBeNull();
  });

  it("throws UnsealError when the decrypted payload is not JSON", async () => {
    const sealed = await cookie.seal("not-json-just-a-string-XYZ");
    await expect(cookie.unsealJson(sealed, SessionSchema)).rejects.toBeInstanceOf(UnsealError);
  });

  it("throws UnsealError when the decrypted JSON fails schema validation", async () => {
    // Seal an object that decrypts fine but violates the schema:
    const wrong = { userId: 42, role: "superadmin" };
    const sealed = await cookie.sealJson(wrong);
    await expect(cookie.unsealJson(sealed, SessionSchema)).rejects.toBeInstanceOf(UnsealError);
  });

  it("UnsealError preserves the underlying ZodError as `cause`", async () => {
    const wrong = { totally: "different" };
    const sealed = await cookie.sealJson(wrong);
    try {
      await cookie.unsealJson(sealed, SessionSchema);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsealError);
      expect((err as UnsealError).cause).toBeDefined();
    }
  });

  it("returns null (not throws) for empty string token", async () => {
    const unsealed = await cookie.unsealJson("", SessionSchema);
    expect(unsealed).toBeNull();
  });

  describe("expiry enforcement at the schema seam (injected clock)", () => {
    // Session crypto is payload-opaque: expiry is the consumer's policy,
    // enforced via a Zod refinement at the unseal seam. We pin that an
    // expired payload is rejected and a still-valid one is accepted, using
    // a FIXED injected "now" (no real Date — determinism rule P2).
    const FIXED_NOW = 1_700_000_000;
    const expiringSchema = (now: number) =>
      SessionSchema.refine((s) => s.expiresAt > now, {
        message: "session expired",
        path: ["expiresAt"],
      });

    it("rejects a payload whose expiresAt is in the past (UnsealError)", async () => {
      const expired: Session = { userId: "u1", role: "user", expiresAt: FIXED_NOW - 1 };
      const sealed = await cookie.sealJson(expired);
      await expect(
        cookie.unsealJson(sealed, expiringSchema(FIXED_NOW)),
      ).rejects.toBeInstanceOf(UnsealError);
    });

    it("rejects a payload that expires exactly at now (boundary, not in the future)", async () => {
      const atBoundary: Session = { userId: "u1", role: "user", expiresAt: FIXED_NOW };
      const sealed = await cookie.sealJson(atBoundary);
      // expiresAt > now is false when equal → expired.
      await expect(
        cookie.unsealJson(sealed, expiringSchema(FIXED_NOW)),
      ).rejects.toBeInstanceOf(UnsealError);
    });

    it("accepts a payload that is still valid (expiresAt in the future)", async () => {
      const valid: Session = { userId: "u1", role: "admin", expiresAt: FIXED_NOW + 3600 };
      const sealed = await cookie.sealJson(valid);
      const unsealed = await cookie.unsealJson(sealed, expiringSchema(FIXED_NOW));
      expect(unsealed).toEqual(valid);
    });
  });
});
