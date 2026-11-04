/**
 * auth-signout after the ID token has expired (dot-notes
 * doc/topics/passwordless-sign-in-aws/02-spec.md, `disable_ends_sessions`):
 *
 * The refresh cookie never reaches `/auth-signout` and the ID token lapses long
 * before the refresh token does, so a user whose ID token expired could not
 * revoke their refresh token. The default verifier therefore accepts an ID
 * token whose signature, issuer, audience and `token_use` are valid but whose
 * `exp` has passed — up to the app client's refresh-token validity in the past
 * (`VESTIBULUM_REFRESH_TOKEN_VALIDITY_SECONDS`, default 30 days).
 *
 * These tests use the REAL verifier (aws-jwt-verify) against a locally
 * generated RSA key: signature checks are exercised, not stubbed.
 */

import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";

import {
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { mockClient } from "aws-sdk-client-mock";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_REFRESH_TOKEN_VALIDITY_SECONDS,
  createAuthSignoutHandler,
  parseRefreshTokenValiditySeconds,
  type LambdaFunctionUrlEvent,
} from "../../../../src/lambda/handlers/auth-signout/index.js";
import { ID_TOKEN_COOKIE_NAME } from "../../../../src/lambda/shared/cookie-names.js";
import { RuntimeEnv } from "../../../../src/lambda/shared/runtime-env.js";

const cognitoMock = mockClient(CognitoIdentityProviderClient);

const DOMAIN = "app.example.com";
const POOL = "eu-central-1_TESTPOOL";
const CLIENT = "client-1";
const KID = "kid-1";
const DAY = 24 * 60 * 60;
// The real clock on purpose: aws-jwt-verify reads Date.now() itself, so the tokens
// are built relative to it (margins of 60 s or more keep the tests deterministic).
// eslint-disable-next-line no-restricted-globals
const nowS = () => Math.floor(Date.now() / 1000);

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherPair = generateKeyPairSync("rsa", { modulusLength: 2048 });

const jwks = {
  keys: [
    {
      ...(pair.publicKey.export({ format: "jwk" }) as Record<string, string>),
      kid: KID,
      alg: "RS256",
      use: "sig",
    },
  ],
} as never;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

function jwt(
  claims: Record<string, unknown>,
  opts: { key?: KeyObject; alg?: string; kid?: string } = {},
): string {
  const header = { alg: opts.alg ?? "RS256", kid: opts.kid ?? KID, typ: "JWT" };
  const payload = {
    sub: "sub-1",
    "cognito:username": "the-username",
    iss: `https://cognito-idp.eu-central-1.amazonaws.com/${POOL}`,
    aud: CLIENT,
    token_use: "id",
    iat: nowS() - 3600,
    exp: nowS() + 900,
    ...claims,
  };
  const data = `${b64(header)}.${b64(payload)}`;
  const sig = createSign("RSA-SHA256").update(data).sign(opts.key ?? pair.privateKey);
  return `${data}.${sig.toString("base64url")}`;
}

function event(idToken: string): LambdaFunctionUrlEvent {
  return {
    headers: { origin: `https://${DOMAIN}`, "content-type": "application/json" },
    requestContext: { http: { method: "POST" } },
    cookies: [`${ID_TOKEN_COOKIE_NAME}=${idToken}`],
  };
}

let emitted: string[];

const outcome = () =>
  emitted
    .filter((l) => l.includes("SignOutRevocation"))
    .map((l) => (JSON.parse(l) as { outcome: string }).outcome);
const signOuts = () => cognitoMock.commandCalls(AdminUserGlobalSignOutCommand);

function realHandler() {
  return createAuthSignoutHandler({
    cognitoClient: cognitoMock as unknown as CognitoIdentityProviderClient,
    jwks,
  });
}

beforeEach(() => {
  cognitoMock.reset();
  cognitoMock.on(AdminUserGlobalSignOutCommand).resolves({});
  emitted = [];
  process.env[RuntimeEnv.DOMAIN] = DOMAIN;
  process.env[RuntimeEnv.COGNITO_USER_POOL_ID] = POOL;
  process.env[RuntimeEnv.COGNITO_CLIENT_ID] = CLIENT;
  process.env[RuntimeEnv.REFRESH_TOKEN_VALIDITY_SECONDS] = String(DAY);
  vi.spyOn(process.stdout, "write").mockImplementation((c) => (emitted.push(String(c)), true));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void emitted.push(a.join(" ")));
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(process.env, RuntimeEnv.REFRESH_TOKEN_VALIDITY_SECONDS);
});

/** The response a caller sees is the same whether or not anything was revoked. */
function expectGenericSignedOutResponse(res: Awaited<ReturnType<ReturnType<typeof realHandler>>>) {
  expect(res.statusCode).toBe(200);
  expect(res.cookies).toHaveLength(2);
  expect(res.cookies!.every((c) => c.includes("Max-Age=0"))).toBe(true);
  expect(res.body).toBeUndefined();
}

describe("a valid ID token", () => {
  it("still signs the user out (the real verifier, end to end)", async () => {
    const res = await realHandler()(event(jwt({})));
    expectGenericSignedOutResponse(res);
    expect(signOuts()).toHaveLength(1);
    expect(signOuts()[0]!.args[0].input).toEqual({ UserPoolId: POOL, Username: "the-username" });
    expect(outcome()).toEqual(["revoked"]);
  });
});

describe("an expired ID token within the refresh-token validity", () => {
  it("revokes: signature, issuer, audience and token_use are valid, only exp has passed", async () => {
    const res = await realHandler()(event(jwt({ exp: nowS() - 3600 })));
    expectGenericSignedOutResponse(res);
    expect(signOuts()).toHaveLength(1);
    expect(outcome()).toEqual(["revoked"]);
  });

  it("revokes just inside the window (exp = now - window + 60 s)", async () => {
    await realHandler()(event(jwt({ exp: nowS() - DAY + 60 })));
    expect(signOuts()).toHaveLength(1);
  });

  it("does NOT revoke just beyond the window (exp = now - window - 60 s): generic response, `unverified`", async () => {
    const res = await realHandler()(event(jwt({ exp: nowS() - DAY - 60 })));
    expectGenericSignedOutResponse(res);
    expect(signOuts()).toHaveLength(0);
    expect(outcome()).toEqual(["unverified"]);
  });

  it("the window defaults to 30 days when the env var is unset", async () => {
    Reflect.deleteProperty(process.env, RuntimeEnv.REFRESH_TOKEN_VALIDITY_SECONDS);
    expect(DEFAULT_REFRESH_TOKEN_VALIDITY_SECONDS).toBe(30 * DAY);
    await realHandler()(event(jwt({ exp: nowS() - 20 * DAY })));
    expect(signOuts()).toHaveLength(1);

    cognitoMock.resetHistory();
    await realHandler()(event(jwt({ exp: nowS() - 40 * DAY })));
    expect(signOuts()).toHaveLength(0);
  });

  it("P: revokes iff the token expired no more than the window ago (clear of the boundary)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 60 * DAY }),
        fc.integer({ min: 2 * DAY, max: 45 * DAY }),
        async (age, windowS) => {
          fc.pre(Math.abs(age - windowS) > 120); // stay clear of the real-clock boundary
          cognitoMock.resetHistory();
          process.env[RuntimeEnv.REFRESH_TOKEN_VALIDITY_SECONDS] = String(windowS);
          await realHandler()(event(jwt({ exp: nowS() - age })));
          expect(signOuts()).toHaveLength(age < windowS ? 1 : 0);
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe("an expired ID token must still be a genuine one — nothing else is relaxed", () => {
  const expired = { exp: nowS() - 3600 };

  it("a bad signature (another key, same kid) revokes nobody, expired or not", async () => {
    for (const claims of [{}, expired]) {
      cognitoMock.resetHistory();
      const res = await realHandler()(event(jwt(claims, { key: otherPair.privateKey })));
      expectGenericSignedOutResponse(res);
      expect(signOuts()).toHaveLength(0);
    }
  });

  it.each([
    ["wrong issuer", { iss: "https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_OTHER" }],
    ["wrong audience", { aud: "someone-elses-client" }],
    ["an access token (token_use)", { token_use: "access", client_id: CLIENT }],
  ])("%s revokes nobody, expired or not", async (_n, claims) => {
    for (const extra of [{}, { exp: nowS() - 3600 }]) {
      cognitoMock.resetHistory();
      const res = await realHandler()(event(jwt({ ...claims, ...extra })));
      expectGenericSignedOutResponse(res);
      expect(signOuts()).toHaveLength(0);
    }
  });

  it("an unsigned (alg none) token revokes nobody", async () => {
    const data = `${b64({ alg: "none", kid: KID })}.${b64({
      sub: "x",
      "cognito:username": "victim",
      iss: `https://cognito-idp.eu-central-1.amazonaws.com/${POOL}`,
      aud: CLIENT,
      token_use: "id",
      exp: nowS() - 3600,
    })}.`;
    await realHandler()(event(data));
    expect(signOuts()).toHaveLength(0);
  });

  it("an unknown kid revokes nobody", async () => {
    await realHandler()(event(jwt(expired, { kid: "kid-unknown" })));
    expect(signOuts()).toHaveLength(0);
  });

  it("garbage in the cookie revokes nobody", async () => {
    await realHandler()(event("not-a-jwt"));
    expect(signOuts()).toHaveLength(0);
    expect(outcome()).toEqual(["unverified"]);
  });
});

describe("a misconfigured window fails closed (it must never widen to 'accept anything')", () => {
  it.each(["abc", "0", "-5", "1.5", "1e9", " 86400"])(
    "VESTIBULUM_REFRESH_TOKEN_VALIDITY_SECONDS=%j: no revocation, reported as an error",
    async (bad) => {
      process.env[RuntimeEnv.REFRESH_TOKEN_VALIDITY_SECONDS] = bad;
      const res = await realHandler()(event(jwt({})));
      expectGenericSignedOutResponse(res);
      expect(signOuts()).toHaveLength(0);
      expect(outcome()).toEqual(["error"]);
    },
  );

  it("parseRefreshTokenValiditySeconds", () => {
    expect(parseRefreshTokenValiditySeconds(undefined)).toBe(30 * DAY);
    expect(parseRefreshTokenValiditySeconds("")).toBe(30 * DAY);
    expect(parseRefreshTokenValiditySeconds("86400")).toBe(86400);
    expect(parseRefreshTokenValiditySeconds("0")).toBeUndefined();
    expect(parseRefreshTokenValiditySeconds("-1")).toBeUndefined();
    expect(parseRefreshTokenValiditySeconds("12abc")).toBeUndefined();
  });
});

describe("sign-out clears the (now long-lived) ID-token cookie", () => {
  it("the cleared id-token cookie has the attributes auth-verify sets it with, so the browser really drops it", async () => {
    const res = await realHandler()(event(jwt({ exp: nowS() - 3600 })));
    const cleared = res.cookies!.find((c) => c.startsWith(`${ID_TOKEN_COOKIE_NAME}=`))!;
    expect(cleared).toContain("Max-Age=0");
    for (const attr of ["HttpOnly", "Secure", "Path=/", `Domain=${DOMAIN}`, "SameSite=Lax"]) {
      expect(cleared).toContain(attr);
    }
  });

  it("it is cleared whether or not anything was revoked (bad token, no token)", async () => {
    for (const e of [
      event("not-a-jwt"),
      {
        headers: { origin: `https://${DOMAIN}`, "content-type": "application/json" },
        requestContext: { http: { method: "POST" } },
      },
    ]) {
      const res = await realHandler()(e);
      expect(res.cookies!.some((c) => c.startsWith(`${ID_TOKEN_COOKIE_NAME}=;`))).toBe(true);
    }
  });
});

describe("nothing else about sign-out changed", () => {
  it("is still POST-origin-checked: a wrong Origin revokes nobody and gets a 403", async () => {
    const res = await realHandler()({
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      requestContext: { http: { method: "POST" } },
      cookies: [`${ID_TOKEN_COOKIE_NAME}=${jwt({})}`],
    });
    expect(res.statusCode).toBe(403);
    expect(signOuts()).toHaveLength(0);
  });

  it("a failed revocation of an expired-but-valid token is reported, and the cookies are still cleared", async () => {
    cognitoMock.on(AdminUserGlobalSignOutCommand).rejects(new Error("AccessDenied"));
    const res = await realHandler()(event(jwt({ exp: nowS() - 3600 })));
    expectGenericSignedOutResponse(res);
    expect(outcome()).toEqual(["error"]);
  });

  it("logs no token, username or key material", async () => {
    const token = jwt({ exp: nowS() - 3600 });
    await realHandler()(event(token));
    await realHandler()(event(jwt({}, { key: otherPair.privateKey })));
    const scanned = emitted.map((l) => l.replace(/"Timestamp":\d+/g, '"Timestamp":0')).join("\n");
    expect(scanned).not.toContain(token);
    expect(scanned).not.toContain("the-username");
    expect(scanned).not.toMatch(/[A-Za-z0-9_-]{30,}/);
  });
});
