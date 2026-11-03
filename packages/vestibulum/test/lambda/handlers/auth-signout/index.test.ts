/**
 * auth-signout — the sign-out invariants (dot-notes
 * doc/topics/passwordless-sign-in-aws/02-spec.md, 01-evidence #14, U10):
 *
 *   - the user to sign out comes from a VERIFIED ID token, never an unverified cookie;
 *   - revocation works with only the ID-token cookie (the refresh cookie is
 *     scoped to /auth-verify and never reaches this endpoint);
 *   - a failed revocation is reported (metric + closed-enum log), not swallowed —
 *     but the cookies are cleared regardless.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";

import {
  createAuthSignoutHandler,
  type LambdaFunctionUrlEvent,
} from "../../../../src/lambda/handlers/auth-signout/index.js";
import { ID_TOKEN_COOKIE_NAME, REFRESH_TOKEN_COOKIE_NAME } from "../../../../src/lambda/shared/cookie-names.js";
import { RuntimeEnv } from "../../../../src/lambda/shared/runtime-env.js";

const cognitoMock = mockClient(CognitoIdentityProviderClient);

const DOMAIN = "app.example.com";
const POOL = "eu-central-1_TESTPOOL";
const CLIENT = "client-1";

let emitted: string[];

function event(opts: {
  idToken?: string;
  refreshToken?: string;
  via?: "header" | "cookies";
  origin?: string | null;
} = {}): LambdaFunctionUrlEvent {
  const pairs: string[] = [];
  if (opts.idToken !== undefined) pairs.push(`${ID_TOKEN_COOKIE_NAME}=${opts.idToken}`);
  if (opts.refreshToken !== undefined) pairs.push(`${REFRESH_TOKEN_COOKIE_NAME}=${opts.refreshToken}`);
  const headers: Record<string, string | undefined> = {};
  if (opts.origin !== null) headers["origin"] = opts.origin ?? `https://${DOMAIN}`;
  if (opts.via === "header") headers["cookie"] = pairs.join("; ");
  return { headers, ...(opts.via === "header" || pairs.length === 0 ? {} : { cookies: pairs }) };
}

const verifies = (username: string) => () => Promise.resolve({ username });
const rejects = () => Promise.reject(new Error("bad signature for secret.value.here"));

const outcomes = () =>
  emitted
    .filter((l) => l.includes("SignOutRevocation"))
    .map((l) => (JSON.parse(l) as { outcome: string }).outcome);

beforeEach(() => {
  cognitoMock.reset();
  cognitoMock.on(AdminUserGlobalSignOutCommand).resolves({});
  emitted = [];
  process.env[RuntimeEnv.DOMAIN] = DOMAIN;
  process.env[RuntimeEnv.COGNITO_USER_POOL_ID] = POOL;
  process.env[RuntimeEnv.COGNITO_CLIENT_ID] = CLIENT;
  vi.spyOn(process.stdout, "write").mockImplementation((c) => (emitted.push(String(c)), true));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void emitted.push(a.join(" ")));
});

afterEach(() => vi.restoreAllMocks());

function handler(verifyIdToken: (t: string) => Promise<{ username: string }>) {
  return createAuthSignoutHandler({
    cognitoClient: cognitoMock as unknown as CognitoIdentityProviderClient,
    verifyIdToken,
  });
}

const signOuts = () => cognitoMock.commandCalls(AdminUserGlobalSignOutCommand);

describe("revocation", () => {
  it("signs out the user in the verified ID token via AdminUserGlobalSignOut on this pool", async () => {
    const res = await handler(verifies("the-username"))(event({ idToken: "id.jwt.value" }));
    expect(res.statusCode).toBe(200);
    expect(signOuts()).toHaveLength(1);
    expect(signOuts()[0]!.args[0].input).toEqual({ UserPoolId: POOL, Username: "the-username" });
    expect(outcomes()).toEqual(["revoked"]);
  });

  it("works with ONLY the ID-token cookie — the refresh cookie never reaches /auth-signout", async () => {
    // Regression: revocation used to be gated on the refresh cookie, which the
    // browser never sends here (Path=/auth-verify), so it never ran at all.
    await handler(verifies("u"))(event({ idToken: "id.jwt.value" }));
    expect(signOuts()).toHaveLength(1);
  });

  it("reads cookies from the Function URL `cookies` array and from a `cookie` header", async () => {
    for (const via of ["cookies", "header"] as const) {
      cognitoMock.resetHistory();
      await handler(verifies("u"))(event({ idToken: "id.jwt.value", via }));
      expect(signOuts()).toHaveLength(1);
    }
  });

  it("passes the raw cookie value to the verifier (it, not this code, decides validity)", async () => {
    const seen: string[] = [];
    await handler((t) => (seen.push(t), Promise.resolve({ username: "u" })))(
      event({ idToken: "exactly.this.token" }),
    );
    expect(seen).toEqual(["exactly.this.token"]);
  });
});

describe("never acts on an unverified token (01-evidence #14)", () => {
  it("a token that fails verification signs NOBODY out, but cookies are still cleared", async () => {
    const forged = `h.${Buffer.from(JSON.stringify({ sub: "victim-sub" })).toString("base64url")}.s`;
    const res = await handler(rejects)(event({ idToken: forged }));
    expect(res.statusCode).toBe(200);
    expect(signOuts()).toHaveLength(0);
    expect(outcomes()).toEqual(["unverified"]);
    expect(res.cookies).toHaveLength(2);
    expect(res.cookies!.every((c) => c.includes("Max-Age=0"))).toBe(true);
  });

  it("the default verifier rejects a malformed token without calling Cognito", async () => {
    const real = createAuthSignoutHandler({
      cognitoClient: cognitoMock as unknown as CognitoIdentityProviderClient,
    });
    const res = await real(event({ idToken: "not-a-jwt" }));
    expect(res.statusCode).toBe(200);
    expect(signOuts()).toHaveLength(0);
    expect(outcomes()).toEqual(["unverified"]);
  });

  it("no ID-token cookie → nothing to revoke, reported as such", async () => {
    const res = await handler(verifies("u"))(event({ refreshToken: "r" }));
    expect(res.statusCode).toBe(200);
    expect(signOuts()).toHaveLength(0);
    expect(outcomes()).toEqual(["no_id_token"]);
  });
});

describe("a failed revocation is reported, not swallowed", () => {
  it("emits an `error` outcome and still clears the cookies", async () => {
    cognitoMock.on(AdminUserGlobalSignOutCommand).rejects(new Error("AccessDeniedException"));
    const res = await handler(verifies("u"))(event({ idToken: "id.jwt.value" }));
    expect(res.statusCode).toBe(200);
    expect(outcomes()).toEqual(["error"]);
    expect(emitted.join("\n")).toContain("revocation error");
    expect(res.cookies).toHaveLength(2);
  });

  it("a misconfigured function (no pool id) reports `error` and does not call Cognito", async () => {
    Reflect.deleteProperty(process.env, RuntimeEnv.COGNITO_USER_POOL_ID);
    const res = await handler(verifies("u"))(event({ idToken: "id.jwt.value" }));
    expect(res.statusCode).toBe(200);
    expect(signOuts()).toHaveLength(0);
    expect(outcomes()).toEqual(["error"]);
  });
});

describe("CSRF and secrets", () => {
  it.each([[null], ["https://evil.example"]])("Origin %s → 403 and nothing is revoked", async (origin) => {
    const res = await handler(verifies("u"))(event({ idToken: "id.jwt.value", origin }));
    expect(res.statusCode).toBe(403);
    expect(signOuts()).toHaveLength(0);
  });

  it("logs no token, username or error text", async () => {
    cognitoMock.on(AdminUserGlobalSignOutCommand).rejects(new Error("failed for the-username"));
    await handler(verifies("the-username"))(event({ idToken: "SECRET.JWT.VALUE-abcdefghijklmnop" }));
    await handler(rejects)(event({ idToken: "SECRET.JWT.VALUE-abcdefghijklmnop" }));
    const scanned = emitted.map((l) => l.replace(/"Timestamp":\d+/g, '"Timestamp":0')).join("\n");
    expect(scanned).not.toContain("SECRET.JWT.VALUE");
    expect(scanned).not.toContain("the-username");
    expect(scanned).not.toContain("secret.value.here");
    expect(scanned).not.toMatch(/\d{6,}/);
  });
});
