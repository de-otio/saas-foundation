/**
 * Tests for the SINGLE-TENANT Lambda@Edge `check-auth` handler
 * (`src/lambda/edge/check-auth/index.ts`).
 *
 * This is a live edge-auth security surface — it had no test coverage
 * before this file (Phase 2 gap-fill). The threat (06 § Edge-auth bypass):
 * a request must never reach the protected origin without a valid session.
 *
 * Asserts the load-bearing fail-closed properties:
 *   - No cookie            → 302 /login (never pass-through).
 *   - Valid ID token       → pass-through (original request returned).
 *   - Tampered signature   → 302 (single-bit flip in the signature).
 *   - Wrong key            → 302.
 *   - Expired token        → 302.
 *   - Wrong issuer         → 302.
 *   - Wrong audience       → 302.
 *   - alg: none / HS256    → 302 (alg allow-list = RS256 only).
 *   - token_use=access     → 302 (ID tokens only).
 *   - Malformed event      → 302.
 *   - Placeholder config   → 302 (fail-closed on misconfig).
 *
 * The decisive non-tautology check throughout: an admitted request is the
 * ORIGINAL request object (has `.method`), a denied one is a 302 response
 * (has `.status === '302'`). We assert the deny shape explicitly so a test
 * cannot pass by the handler silently doing nothing.
 *
 * Determinism: clock frozen via fake timers; RSA keys generated in
 * beforeAll; JWKS seeded via the `__seedJwksForTests` seam — no network.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, createSign, createHmac, type KeyObject } from "node:crypto";

import {
  handler,
  __resetForTests,
  __seedJwksForTests,
  type CloudFrontRequestEvent,
  type CheckAuthResult,
} from "../../../src/lambda/edge/check-auth/index.js";
import { resolveCognitoEndpoint } from "../../../src/lambda/edge/check-auth/jwks-region-resolver.js";

// A real, well-formed Cognito pool ID so resolveCognitoEndpoint succeeds.
const USER_POOL_ID = "eu-central-1_aBcDeFgHi";
const CLIENT_ID = "test-website-client";
const COOKIE_NAME = "vestibulum_id_token";
const LOGIN_PATH = "/login";

const ENDPOINT = resolveCognitoEndpoint(USER_POOL_ID)!;
const ISSUER = ENDPOINT.issuer;
const JWKS_URI = ENDPOINT.jwksUri;

const FIXED_NOW_SEC = 1_700_000_000;
const FIXED_NOW_MS = FIXED_NOW_SEC * 1000;

interface TestKey {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function b64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function makeKey(kid: string): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  return {
    kid,
    privateKey,
    jwk: { kid, kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", use: "sig" },
  };
}

interface SignOpts {
  key: TestKey;
  alg?: string;
  kid?: string;
  claims?: Record<string, unknown>;
  /** Sign with a different private key (forge). */
  signWith?: KeyObject;
}

function signIdJwt(opts: SignOpts): string {
  const header = { alg: opts.alg ?? "RS256", typ: "JWT", kid: opts.kid ?? opts.key.kid };
  const claims: Record<string, unknown> = {
    iss: ISSUER,
    aud: CLIENT_ID,
    token_use: "id",
    sub: "test-sub",
    "cognito:username": "test-user",
    iat: FIXED_NOW_SEC,
    nbf: FIXED_NOW_SEC - 5,
    exp: FIXED_NOW_SEC + 3600,
    auth_time: FIXED_NOW_SEC,
    ...opts.claims,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const sig = signer.sign(opts.signWith ?? opts.key.privateKey);
  return `${signingInput}.${b64url(sig)}`;
}

function signHs256(claims: Record<string, unknown>): string {
  const header = { alg: "HS256", typ: "JWT", kid: "hs-kid" };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = createHmac("sha256", "shared-secret").update(input).digest();
  return `${input}.${b64url(sig)}`;
}

function signNone(claims: Record<string, unknown>): string {
  const header = { alg: "none", typ: "JWT", kid: "none-kid" };
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}.`;
}

function makeEvent(cookie?: string): CloudFrontRequestEvent {
  const headers: Record<string, Array<{ key?: string; value: string }>> = {};
  if (cookie !== undefined) {
    headers["cookie"] = [{ key: "Cookie", value: cookie }];
  }
  return {
    Records: [{ cf: { request: { uri: "/private", method: "GET", querystring: "", headers } } }],
  };
}

/** True if the result is a 302-to-login DENY (not a pass-through). */
function isLoginRedirect(r: CheckAuthResult): boolean {
  const res = r as { status?: string; headers?: Record<string, Array<{ value: string }>> };
  return res.status === "302" && res.headers?.["location"]?.[0]?.value === LOGIN_PATH;
}

/** True if the result is the admitted ORIGINAL request (pass-through). */
function isPassThrough(r: CheckAuthResult): boolean {
  const req = r as { method?: string; status?: string };
  return req.status === undefined && req.method === "GET";
}

let primary: TestKey;

beforeAll(() => {
  vi.useFakeTimers({ now: FIXED_NOW_MS });
  primary = makeKey("primary-kid");
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  // Reset module state to a VALID config and seed the JWKS at the resolved URI.
  __resetForTests({
    userPoolId: USER_POOL_ID,
    clientId: CLIENT_ID,
    homeRegion: "eu-central-1",
    idTokenCookieName: COOKIE_NAME,
    loginPath: LOGIN_PATH,
  });
  __seedJwksForTests(JWKS_URI, { keys: [primary.jwk] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("single-tenant edge check-auth", () => {
  it("admits a fully-valid ID token (pass-through)", async () => {
    const token = signIdJwt({ key: primary });
    const r = await handler(makeEvent(`${COOKIE_NAME}=${token}`));
    expect(isPassThrough(r)).toBe(true);
    expect(isLoginRedirect(r)).toBe(false);
  });

  it("redirects to /login when no cookie is present (never pass-through)", async () => {
    const r = await handler(makeEvent());
    expect(isLoginRedirect(r)).toBe(true);
    expect(isPassThrough(r)).toBe(false);
  });

  it("redirects when the id-token cookie is empty", async () => {
    const r = await handler(makeEvent(`${COOKIE_NAME}=`));
    expect(isLoginRedirect(r)).toBe(true);
  });

  it("redirects when a different cookie is present but the id-token cookie is absent", async () => {
    const r = await handler(makeEvent("some_other_cookie=value"));
    expect(isLoginRedirect(r)).toBe(true);
  });

  it("DENIES a token whose signature was tampered (single-bit flip)", async () => {
    const token = signIdJwt({ key: primary });
    const parts = token.split(".");
    const sig = Buffer.from(parts[2]!, "base64");
    sig[0] = sig[0]! ^ 0x01; // flip one bit
    const tampered = `${parts[0]}.${parts[1]}.${b64url(sig)}`;
    const r = await handler(makeEvent(`${COOKIE_NAME}=${tampered}`));
    expect(isLoginRedirect(r)).toBe(true);
    expect(isPassThrough(r)).toBe(false);
  });

  it("DENIES a token signed by a key not in the JWKS", async () => {
    const intruder = makeKey("primary-kid"); // same kid, different key material
    const token = signIdJwt({ key: primary, signWith: intruder.privateKey });
    const r = await handler(makeEvent(`${COOKIE_NAME}=${token}`));
    expect(isLoginRedirect(r)).toBe(true);
  });

  it("DENIES an expired token", async () => {
    const token = signIdJwt({
      key: primary,
      claims: { exp: FIXED_NOW_SEC - 3600, nbf: FIXED_NOW_SEC - 3660, iat: FIXED_NOW_SEC - 3660 },
    });
    const r = await handler(makeEvent(`${COOKIE_NAME}=${token}`));
    expect(isLoginRedirect(r)).toBe(true);
  });

  it("DENIES a not-yet-valid token (nbf far in the future)", async () => {
    const future = FIXED_NOW_SEC + 7200;
    const token = signIdJwt({
      key: primary,
      claims: { nbf: future, iat: future, exp: future + 3600 },
    });
    const r = await handler(makeEvent(`${COOKIE_NAME}=${token}`));
    expect(isLoginRedirect(r)).toBe(true);
  });

  it("DENIES a token with a foreign issuer", async () => {
    const token = signIdJwt({ key: primary, claims: { iss: "https://attacker.example.com/pool" } });
    const r = await handler(makeEvent(`${COOKIE_NAME}=${token}`));
    expect(isLoginRedirect(r)).toBe(true);
  });

  it("DENIES a token with the wrong audience", async () => {
    const token = signIdJwt({ key: primary, claims: { aud: "a-different-client" } });
    const r = await handler(makeEvent(`${COOKIE_NAME}=${token}`));
    expect(isLoginRedirect(r)).toBe(true);
  });

  it("DENIES an alg: none token", async () => {
    const token = signNone({
      iss: ISSUER,
      aud: CLIENT_ID,
      token_use: "id",
      sub: "x",
      exp: FIXED_NOW_SEC + 3600,
    });
    const r = await handler(makeEvent(`${COOKIE_NAME}=${token}`));
    expect(isLoginRedirect(r)).toBe(true);
  });

  it("DENIES an HS256 token (alg allow-list = RS256 only)", async () => {
    const token = signHs256({
      iss: ISSUER,
      aud: CLIENT_ID,
      token_use: "id",
      sub: "x",
      exp: FIXED_NOW_SEC + 3600,
    });
    const r = await handler(makeEvent(`${COOKIE_NAME}=${token}`));
    expect(isLoginRedirect(r)).toBe(true);
  });

  it("DENIES an access token (token_use must be 'id')", async () => {
    const token = signIdJwt({ key: primary, claims: { token_use: "access" } });
    const r = await handler(makeEvent(`${COOKIE_NAME}=${token}`));
    expect(isLoginRedirect(r)).toBe(true);
  });

  it("DENIES a structurally-garbage token", async () => {
    const r = await handler(makeEvent(`${COOKIE_NAME}=not.a.jwt`));
    expect(isLoginRedirect(r)).toBe(true);
  });

  it("redirects on a malformed event with no Records[0]", async () => {
    const r = await handler({ Records: [] });
    expect(isLoginRedirect(r)).toBe(true);
  });

  it("fails closed (302) when the config still holds the invalid placeholder pool ID", async () => {
    // resolveCognitoEndpoint returns undefined for the placeholder pool ID,
    // so getVerifier() returns undefined and the handler redirects — it must
    // never authenticate against a guessed/wrong pool.
    __resetForTests({
      userPoolId: "PLACEHOLDER_USER_POOL_ID",
      clientId: CLIENT_ID,
      homeRegion: "eu-central-1",
      idTokenCookieName: COOKIE_NAME,
      loginPath: LOGIN_PATH,
    });
    const token = signIdJwt({ key: primary });
    const r = await handler(makeEvent(`${COOKIE_NAME}=${token}`));
    expect(isLoginRedirect(r)).toBe(true);
    expect(isPassThrough(r)).toBe(false);
  });
});
