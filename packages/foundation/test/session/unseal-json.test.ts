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
});
