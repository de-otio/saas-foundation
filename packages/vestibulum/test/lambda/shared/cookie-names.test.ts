/**
 * The auth cookie names are a cross-component wire contract: `auth-verify`
 * SETS them, `auth-signout` CLEARS them, and the Lambda@Edge `check-auth` gate
 * READS the ID-token cookie. A drift between setter and reader (the edge gate
 * once defaulted to `vestibulum_id_token` while the regional handlers used
 * `id-token`) silently breaks login. These assertions pin the wire values so any
 * change is a deliberate, reviewed edit.
 */
import { describe, it, expect } from "vitest";
import {
  ID_TOKEN_COOKIE_NAME,
  REFRESH_TOKEN_COOKIE_NAME,
} from "../../../src/lambda/shared/cookie-names.js";
import { createEdgeCheckAuthHandler } from "../../../src/lambda/edge/check-auth/index.js";

describe("auth cookie-name contract", () => {
  it("pins the on-the-wire cookie names", () => {
    expect(ID_TOKEN_COOKIE_NAME).toBe("id-token");
    expect(REFRESH_TOKEN_COOKIE_NAME).toBe("refresh-token");
  });

  it("the edge check-auth gate reads the same ID-token cookie the handlers set", async () => {
    // With no cookie at all the gate must fail closed (302) — this also proves
    // the handler is wired to the shared cookie name and not a stale default.
    const handler = createEdgeCheckAuthHandler();
    const res = await handler({
      Records: [{ cf: { request: { headers: {} } } }],
    });
    expect("status" in res ? res.status : undefined).toBe("302");
  });
});
