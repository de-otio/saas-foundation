/**
 * auth-verify (redeem endpoint) — the invariants it owns
 * (dot-notes doc/topics/passwordless-sign-in-aws/02-spec.md):
 *
 *   signin_link_single_use                    one binding → at most one sign-in, even concurrently
 *   signin_link_expires_10min                 a row at/after expires_at is refused (no reliance on TTL deletion)
 *   signin_link_bound_to_requesting_browser   no cookie / unknown cookie → 401, Cognito NEVER called, nothing consumed
 *   signin_redeem_requires_user_gesture       (endpoint half) POST only, JSON only, same-origin only
 *   signin_latest_request_wins                a newer request supersedes the older link
 *   signin_secrets_never_logged
 *
 * The binding store is a FakeDynamo with real conditional-delete semantics.
 * Cognito is a small stateful fake: it answers a challenge only for the exact
 * (session, answer) pair that was issued, like the real Verify trigger does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { mockClient } from "aws-sdk-client-mock";
import {
  CognitoIdentityProviderClient,
  NotAuthorizedException,
  RespondToAuthChallengeCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import type { AttributeValue, DynamoDBClient } from "@aws-sdk/client-dynamodb";

import {
  createAuthVerifyHandler,
  type LambdaFunctionUrlEvent,
} from "../../../../src/lambda/handlers/auth-verify/index.js";
import { RuntimeEnv } from "../../../../src/lambda/shared/runtime-env.js";
import {
  BINDING_COOKIE_NAME,
  TTL_ATTRIBUTE,
  hashBindingSecret,
} from "../../../../src/lambda/shared/signin.js";
import { FakeDynamo } from "../../fakes/fake-dynamo.js";

const cognitoMock = mockClient(CognitoIdentityProviderClient);

const DOMAIN = "app.example.com";
const CLIENT_ID = "test-client-id";
const BINDING_TABLE = "binding";
const T0_MS = 1_700_000_000_000;
const TTL_S = 600;

let store: FakeDynamo;
let nowMs: number;
/** session → the answer Cognito will accept for it. */
let issuedAnswers: Map<string, string>;

function handler() {
  return createAuthVerifyHandler({
    cognitoClient: cognitoMock as unknown as CognitoIdentityProviderClient,
    dynamodb: store as unknown as DynamoDBClient,
    nowMs: () => nowMs,
  });
}

/** What auth-login leaves behind for one request; returns the browser's cookie secret. */
function pendingRequest(
  secret: string,
  opts: { session?: string | null; answer?: string; expiresAtSeconds?: number } = {},
) {
  const session = opts.session === undefined ? `session-for-${secret}` : opts.session;
  const row: Record<string, AttributeValue> = {
    binding_hash: { S: hashBindingSecret(secret) },
    [TTL_ATTRIBUTE]: { N: String(opts.expiresAtSeconds ?? T0_MS / 1000 + TTL_S) },
  };
  if (session !== null) {
    row["session"] = { S: session };
    row["username"] = { S: `user-of-${secret}` };
    issuedAnswers.set(session, opts.answer ?? `answer-${secret}`);
  }
  store.seed(BINDING_TABLE, row);
  return { secret, answer: opts.answer ?? `answer-${secret}` };
}

function req(
  answer: unknown,
  opts: {
    cookie?: string | null;
    cookieVia?: "header" | "cookies";
    method?: string;
    origin?: string | null;
    contentType?: string | null;
    rawBody?: string;
  } = {},
): LambdaFunctionUrlEvent {
  const headers: Record<string, string | undefined> = {};
  if (opts.origin !== null) headers["origin"] = opts.origin ?? `https://${DOMAIN}`;
  if (opts.contentType !== null) headers["content-type"] = opts.contentType ?? "application/json";
  const cookie = opts.cookie === undefined ? null : opts.cookie;
  const kv = cookie === null ? undefined : `${BINDING_COOKIE_NAME}=${cookie}`;
  if (kv !== undefined && opts.cookieVia === "header") headers["cookie"] = kv;
  return {
    headers,
    ...(kv !== undefined && opts.cookieVia !== "header" ? { cookies: [kv] } : {}),
    body: opts.rawBody ?? JSON.stringify({ answer }),
    requestContext: { http: { method: opts.method ?? "POST" } },
  };
}

const cognitoCalls = () => cognitoMock.commandCalls(RespondToAuthChallengeCommand);

beforeEach(() => {
  store = new FakeDynamo({ keys: { [BINDING_TABLE]: "binding_hash" } });
  nowMs = T0_MS;
  issuedAnswers = new Map();
  cognitoMock.reset();
  cognitoMock.on(RespondToAuthChallengeCommand).callsFake((input: {
    Session?: string;
    ChallengeResponses?: Record<string, string>;
  }) => {
    const ok =
      input.Session !== undefined &&
      issuedAnswers.get(input.Session) === input.ChallengeResponses?.["ANSWER"];
    if (!ok) throw new NotAuthorizedException({ message: "wrong", $metadata: {} });
    issuedAnswers.delete(input.Session!); // one answer per session
    return {
      AuthenticationResult: { IdToken: "id.token.value", RefreshToken: "refresh-token-value" },
    };
  });
  process.env[RuntimeEnv.DOMAIN] = DOMAIN;
  process.env[RuntimeEnv.COGNITO_CLIENT_ID] = CLIENT_ID;
  process.env[RuntimeEnv.BINDING_TABLE_NAME] = BINDING_TABLE;
  Reflect.deleteProperty(process.env, RuntimeEnv.REFRESH_TOKEN_VALIDITY_SECONDS);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  cognitoMock.reset();
});

describe("the 8-digit typed code (U16) passes the same validation as the link token", () => {
  it.each([["43-char link token", "T".repeat(43)], ["8-digit code", "04271983"]])(
    "a %s reaches Cognito as the ANSWER, unchanged",
    async (_n, form) => {
      const { secret } = pendingRequest("code1", { answer: form });
      const res = await handler()(req(form, { cookie: secret }));
      expect(res.statusCode).toBe(200);
      expect(cognitoCalls()[0]!.args[0].input.ChallengeResponses?.["ANSWER"]).toBe(form);
    },
  );

  it("is a string answer: a JSON number (a code with its leading zero lost) is refused before Cognito", async () => {
    const { secret } = pendingRequest("code2", { answer: "04271983" });
    const res = await handler()(req(4271983, { cookie: secret }));
    expect(res.statusCode).toBe(401);
    expect(cognitoCalls()).toHaveLength(0);
  });
});

describe("redeem success", () => {
  it("completes with the stored session + username + the answer, sets auth cookies and clears the binding cookie", async () => {
    const { secret, answer } = pendingRequest("s1");
    const res = await handler()(req(answer, { cookie: secret }));

    expect(res.statusCode).toBe(200);
    expect(cognitoCalls()).toHaveLength(1);
    expect(cognitoCalls()[0]!.args[0].input).toMatchObject({
      ChallengeName: "CUSTOM_CHALLENGE",
      ClientId: CLIENT_ID,
      Session: "session-for-s1",
      ChallengeResponses: { USERNAME: "user-of-s1", ANSWER: answer },
    });
    const cookies = res.cookies ?? [];
    expect(cookies.some((c) => c.includes("id.token.value"))).toBe(true);
    expect(cookies.some((c) => c.startsWith(`${BINDING_COOKIE_NAME}=;`) && c.includes("Max-Age=0"))).toBe(true);
    expect(res.headers?.["Cache-Control"]).toBe("no-store");
    expect(store.count(BINDING_TABLE)).toBe(0);
  });

  it("reads the cookie from the Function URL `cookies` array and from a `cookie` header", async () => {
    for (const via of ["cookies", "header"] as const) {
      store = new FakeDynamo({ keys: { [BINDING_TABLE]: "binding_hash" } });
      const { secret, answer } = pendingRequest(`via-${via}`);
      const res = await handler()(req(answer, { cookie: secret, cookieVia: via }));
      expect(res.statusCode).toBe(200);
    }
  });
});

describe("the ID-token cookie lives as long as the refresh token (so sign-out can still revoke)", () => {
  const idCookie = (res: { cookies?: string[] }) =>
    (res.cookies ?? []).find((c) => c.startsWith("id-token="))!;

  it("Max-Age is VESTIBULUM_REFRESH_TOKEN_VALIDITY_SECONDS", async () => {
    process.env[RuntimeEnv.REFRESH_TOKEN_VALIDITY_SECONDS] = "86400";
    const { secret, answer } = pendingRequest("m1");
    const res = await handler()(req(answer, { cookie: secret }));
    expect(res.statusCode).toBe(200);
    expect(idCookie(res)).toContain("Max-Age=86400");
  });

  it("defaults to 30 days when unset (Cognito's own refresh default)", async () => {
    const { secret, answer } = pendingRequest("m2");
    const res = await handler()(req(answer, { cookie: secret }));
    expect(idCookie(res)).toContain(`Max-Age=${30 * 86400}`);
  });

  it.each(["abc", "0", "-5", "1.5", "1e9", " 86400"])(
    "a malformed value (%j) fails closed: 401, nothing consumed, Cognito never called, no cookie set",
    async (bad) => {
      process.env[RuntimeEnv.REFRESH_TOKEN_VALIDITY_SECONDS] = bad;
      const { secret, answer } = pendingRequest("m3");
      const res = await handler()(req(answer, { cookie: secret }));
      expect(res.statusCode).toBe(401);
      expect(cognitoCalls()).toHaveLength(0);
      expect(store.count(BINDING_TABLE)).toBe(1);
      expect((res.cookies ?? []).some((c) => c.startsWith("id-token="))).toBe(false);
    },
  );

  it("is still HttpOnly, Secure, Path=/ (the attributes sign-out must match to clear it)", async () => {
    const { secret, answer } = pendingRequest("m4");
    const res = await handler()(req(answer, { cookie: secret }));
    const c = idCookie(res);
    for (const attr of ["HttpOnly", "Secure", "Path=/", `Domain=${DOMAIN}`, "SameSite=Lax"]) {
      expect(c).toContain(attr);
    }
  });
});

describe("signin_redeem_requires_user_gesture (endpoint half)", () => {
  it.each(["GET", "PUT", "DELETE", "HEAD", "OPTIONS"])("%s cannot redeem and never reaches Cognito", async (method) => {
    const { secret, answer } = pendingRequest("g1");
    const res = await handler()(req(answer, { cookie: secret, method }));
    expect(res.statusCode).toBe(405);
    expect(cognitoCalls()).toHaveLength(0);
    expect(store.count(BINDING_TABLE)).toBe(1); // nothing consumed
  });

  it("a missing method is not treated as POST", async () => {
    const { secret, answer } = pendingRequest("g2");
    const event = req(answer, { cookie: secret });
    const { requestContext: _drop, ...noMethod } = event;
    void _drop;
    const res = await handler()(noMethod);
    expect(res.statusCode).toBe(405);
    expect(cognitoCalls()).toHaveLength(0);
  });

  it.each([
    ["text/plain", 415],
    ["application/x-www-form-urlencoded", 415],
    ["multipart/form-data", 415],
  ])("content-type %s is refused (a cross-site <form> cannot send JSON)", async (ct, status) => {
    const { secret, answer } = pendingRequest("g3");
    const res = await handler()(req(answer, { cookie: secret, contentType: ct }));
    expect(res.statusCode).toBe(status);
    expect(cognitoCalls()).toHaveLength(0);
    expect(store.count(BINDING_TABLE)).toBe(1);
  });

  it("a missing content-type is refused", async () => {
    const { secret, answer } = pendingRequest("g4");
    const res = await handler()(req(answer, { cookie: secret, contentType: null }));
    expect(res.statusCode).toBe(415);
  });

  it.each([[null], ["https://evil.example"], ["http://app.example.com"]])(
    "Origin %s is refused",
    async (origin) => {
      const { secret, answer } = pendingRequest("g5");
      const res = await handler()(req(answer, { cookie: secret, origin }));
      expect(res.statusCode).toBe(403);
      expect(cognitoCalls()).toHaveLength(0);
      expect(store.count(BINDING_TABLE)).toBe(1);
    },
  );
});

describe("signin_link_bound_to_requesting_browser", () => {
  it("no cookie → 401, Cognito is never called, and the pending request is untouched", async () => {
    const { answer } = pendingRequest("b1");
    const res = await handler()(req(answer, { cookie: null }));
    expect(res.statusCode).toBe(401);
    expect(cognitoCalls()).toHaveLength(0);
    expect(store.count(BINDING_TABLE)).toBe(1);
    // Not even a lookup: with no cookie there is no key to look up.
    expect(store.calls).toEqual([]);
  });

  it("an unknown cookie → 401, Cognito is never called, and nobody's request is consumed", async () => {
    const { answer } = pendingRequest("b2");
    const res = await handler()(req(answer, { cookie: "an-unrelated-secret" }));
    expect(res.statusCode).toBe(401);
    expect(cognitoCalls()).toHaveLength(0);
    expect(store.count(BINDING_TABLE)).toBe(1);
  });

  it("opened in a second browser (no cookie) fails WITHOUT consuming; the first browser then succeeds", async () => {
    const { secret, answer } = pendingRequest("b3");
    const other = await handler()(req(answer, { cookie: null }));
    expect(other.statusCode).toBe(401);
    expect(cognitoCalls()).toHaveLength(0);

    const original = await handler()(req(answer, { cookie: secret }));
    expect(original.statusCode).toBe(200);
  });

  it("another user's valid answer with MY cookie does not sign anyone in", async () => {
    const mine = pendingRequest("mine");
    const theirs = pendingRequest("theirs");
    const res = await handler()(req(theirs.answer, { cookie: mine.secret }));
    expect(res.statusCode).toBe(401);
    // and the other person's pending request is still redeemable by them.
    const ok = await handler()(req(theirs.answer, { cookie: theirs.secret }));
    expect(ok.statusCode).toBe(200);
  });

  it("a binding with no Cognito session (request was rate limited / failed) fails like a wrong answer", async () => {
    pendingRequest("nosess", { session: null });
    const wrong = await handler()(req("whatever", { cookie: "nosess" }));
    expect(wrong.statusCode).toBe(401);
    expect(cognitoCalls()).toHaveLength(0);
  });

  it("every failure answers the same generic 401 body", async () => {
    pendingRequest("same-a");
    pendingRequest("same-b", { session: null });
    pendingRequest("same-c", { expiresAtSeconds: T0_MS / 1000 - 1 });
    const bodies = new Set<string | undefined>();
    for (const c of [null, "unknown", "same-a", "same-b", "same-c"]) {
      const r = await handler()(req("wrong-answer", { cookie: c }));
      expect(r.statusCode).toBe(401);
      bodies.add(r.body);
    }
    expect(bodies.size).toBe(1);
  });
});

describe("signin_link_single_use", () => {
  it("the same answer + cookie replayed after success gets 401", async () => {
    const { secret, answer } = pendingRequest("u1");
    expect((await handler()(req(answer, { cookie: secret }))).statusCode).toBe(200);
    expect((await handler()(req(answer, { cookie: secret }))).statusCode).toBe(401);
    expect(cognitoCalls()).toHaveLength(1);
  });

  it("P: of N concurrent redemptions of one binding exactly one signs in, and Cognito is called once", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 12 }), async (n) => {
        store = new FakeDynamo({ keys: { [BINDING_TABLE]: "binding_hash" } });
        issuedAnswers = new Map();
        cognitoMock.resetHistory();
        const { secret, answer } = pendingRequest("conc");
        const results = await Promise.all(
          Array.from({ length: n }, () => handler()(req(answer, { cookie: secret }))),
        );
        expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
        expect(results.filter((r) => r.statusCode === 401)).toHaveLength(n - 1);
        expect(cognitoCalls()).toHaveLength(1);
      }),
      { numRuns: 40 },
    );
  });

  it("a wrong answer ends the attempt: the correct answer afterwards also fails (one answer per session)", async () => {
    const { secret, answer } = pendingRequest("u2");
    expect((await handler()(req("not-it", { cookie: secret }))).statusCode).toBe(401);
    expect((await handler()(req(answer, { cookie: secret }))).statusCode).toBe(401);
  });
});

describe("signin_link_expires_10min", () => {
  it("succeeds at 9:59.999 and fails at 10:00.000 (the binding row's expires_at)", async () => {
    const a = pendingRequest("x1");
    nowMs = T0_MS + (TTL_S - 1) * 1000 + 999;
    expect((await handler()(req(a.answer, { cookie: a.secret }))).statusCode).toBe(200);

    store = new FakeDynamo({ keys: { [BINDING_TABLE]: "binding_hash" } });
    const b = pendingRequest("x2");
    nowMs = T0_MS + TTL_S * 1000;
    const late = await handler()(req(b.answer, { cookie: b.secret }));
    expect(late.statusCode).toBe(401);
    expect(cognitoCalls()).toHaveLength(1); // only the first, in-time redemption reached Cognito
  });

  it("does not rely on DynamoDB TTL deletion", async () => {
    const { secret, answer } = pendingRequest("x3");
    nowMs = T0_MS + 5 * 3600 * 1000;
    expect(store.count(BINDING_TABLE)).toBe(1); // the expired row is still there
    expect((await handler()(req(answer, { cookie: secret }))).statusCode).toBe(401);
  });

  it("fails closed on a row with no / malformed expires_at", async () => {
    store.seed(BINDING_TABLE, {
      binding_hash: { S: hashBindingSecret("x4") },
      session: { S: "s" },
      username: { S: "u" },
    });
    expect((await handler()(req("a", { cookie: "x4" }))).statusCode).toBe(401);
    store.seed(BINDING_TABLE, {
      binding_hash: { S: hashBindingSecret("x5") },
      expires_at: { N: "soon" },
      session: { S: "s" },
      username: { S: "u" },
    });
    expect((await handler()(req("a", { cookie: "x5" }))).statusCode).toBe(401);
    expect(cognitoCalls()).toHaveLength(0);
  });
});

describe("signin_latest_request_wins", () => {
  it("after a second request the older link fails and the newer one succeeds", async () => {
    // The browser's cookie is overwritten by request 2, so it presents secret2 with BOTH links.
    const r1 = pendingRequest("req1");
    const r2 = pendingRequest("req2");
    const older = await handler()(req(r1.answer, { cookie: r2.secret }));
    expect(older.statusCode).toBe(401);

    store = new FakeDynamo({ keys: { [BINDING_TABLE]: "binding_hash" } });
    issuedAnswers = new Map();
    pendingRequest("req1");
    const r2b = pendingRequest("req2");
    const newer = await handler()(req(r2b.answer, { cookie: r2b.secret }));
    expect(newer.statusCode).toBe(200);
  });
});

describe("input bounds and fail-closed", () => {
  it.each([
    ["missing answer", JSON.stringify({})],
    ["non-string answer", JSON.stringify({ answer: 12345678 })],
    ["empty answer", JSON.stringify({ answer: "" })],
    ["over-long answer", JSON.stringify({ answer: "x".repeat(65) })],
    ["malformed JSON", "{nope"],
    ["empty body", ""],
  ])("%s → 401 and the pending request is not consumed", async (_n, rawBody) => {
    const { secret } = pendingRequest("bd");
    const res = await handler()(req(undefined, { cookie: secret, rawBody }));
    expect(res.statusCode).toBe(401);
    expect(cognitoCalls()).toHaveLength(0);
    expect(store.count(BINDING_TABLE)).toBe(1);
  });

  it("the session and email are NOT taken from the body (extra fields are ignored)", async () => {
    const { secret, answer } = pendingRequest("ig");
    const res = await handler()(
      req(undefined, {
        cookie: secret,
        rawBody: JSON.stringify({ answer, session: "attacker-session", email: "evil@example.com" }),
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(cognitoCalls()[0]!.args[0].input.Session).toBe("session-for-ig");
    expect(JSON.stringify(cognitoCalls()[0]!.args[0].input)).not.toContain("attacker-session");
  });

  it("a binding-store error fails closed and never reaches Cognito", async () => {
    store = new FakeDynamo({
      keys: { [BINDING_TABLE]: "binding_hash" },
      fault: () => new Error("ddb down"),
    });
    const res = await handler()(req("a", { cookie: "whatever" }));
    expect(res.statusCode).toBe(401);
    expect(cognitoCalls()).toHaveLength(0);
  });

  it("a Cognito error → 401 and the binding is spent (terminal)", async () => {
    const { secret, answer } = pendingRequest("ce");
    cognitoMock.on(RespondToAuthChallengeCommand).rejects(new Error("throttled"));
    expect((await handler()(req(answer, { cookie: secret }))).statusCode).toBe(401);
    expect(store.count(BINDING_TABLE)).toBe(0);
  });

  it("a success response with no ID token is a failure", async () => {
    const { secret, answer } = pendingRequest("nt");
    cognitoMock.on(RespondToAuthChallengeCommand).resolves({ AuthenticationResult: {} });
    expect((await handler()(req(answer, { cookie: secret }))).statusCode).toBe(401);
  });

  it("always clears the binding cookie on failure", async () => {
    const res = await handler()(req("a", { cookie: "nothing" }));
    expect(res.cookies?.[0]).toMatch(new RegExp(`^${BINDING_COOKIE_NAME}=;.*Max-Age=0`));
  });
});

describe("signin_secrets_never_logged", () => {
  it("emits no secret, session, answer or digit run on success or failure", async () => {
    const lines: string[] = [];
    vi.restoreAllMocks();
    vi.spyOn(process.stdout, "write").mockImplementation((c) => (lines.push(String(c)), true));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));

    const ok = pendingRequest("log1", { answer: "THE-ANSWER-VALUE" });
    await handler()(req(ok.answer, { cookie: ok.secret }));
    await handler()(req("wrong", { cookie: "log1" }));
    await handler()(req("wrong", { cookie: null }));

    const scanned = lines.map((l) => l.replace(/"Timestamp":\d+/g, '"Timestamp":0')).join("\n");
    expect(scanned).not.toMatch(/@/);
    expect(scanned).not.toMatch(/\d{6,}/);
    expect(scanned).not.toMatch(/[A-Za-z0-9_-]{20,}/);
    for (const forbidden of ["THE-ANSWER-VALUE", "session-for-log1", "log1", "token=", "#t="]) {
      expect(scanned).not.toContain(forbidden);
    }
  });
});
