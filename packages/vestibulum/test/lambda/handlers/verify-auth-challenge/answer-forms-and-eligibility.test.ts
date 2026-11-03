/**
 * VerifyAuthChallengeResponse — the second answer form and the eligibility
 * re-check (dot-notes doc/topics/passwordless-sign-in-aws/02-spec.md):
 *
 *   signin_answer_compare_constant_time   the answer is the 43-char token OR exactly 8 ASCII digits; anything else
 *                                         is false without throwing; compared on equal-length buffers (P)
 *   signin_link_single_use                the link and the code are two forms of ONE secret: using either spends both
 *   signin_redeem_rechecks_eligibility    a subject disabled between request and redemption does not get in (I8);
 *                                         an unavailable allow-list is false (I15)
 *   signin_secrets_never_logged           no answer, address or subject in any log line
 *
 * State lives in a FakeDynamo with real conditional-write semantics, so the
 * assertions are about what is LEFT in the table.
 */

import { createHash } from "node:crypto";

import type { AttributeValue, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createVerifyAuthChallengeResponseHandler,
  type VerifyAuthChallengeEvent,
} from "../../../../src/lambda/handlers/verify-auth-challenge/index.js";
import { hmacEmail } from "../../../../src/lambda/shared/email-hmac.js";
import { RuntimeEnv } from "../../../../src/lambda/shared/runtime-env.js";
import { classifyAnswer } from "../../../../src/lambda/shared/signin.js";
import { FakeAllowList } from "../../fakes/fake-allow-list.js";
import { FakeDynamo } from "../../fakes/fake-dynamo.js";

const TABLE = "tokens";
const HMAC_KEY = "test-hmac-key-not-a-secret";
const EMAIL = "person@example.com";
const SUBJECT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const T0_MS = 1_700_000_000_000;
const TTL_S = 600;
const TOKEN = "T".repeat(43);
const CODE = "04271983";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

let store: FakeDynamo;
let allow: FakeAllowList;
let nowMs: number;
let lines: string[];

function handler() {
  return createVerifyAuthChallengeResponseHandler({
    dynamodb: store as unknown as DynamoDBClient,
    resolveHmacKey: () => Promise.resolve(HMAC_KEY),
    nowMs: () => nowMs,
    allowList: allow,
  });
}

/** What Create leaves behind: the token row, and this session's private parameters. */
function issue(opts: { rowCodeHash?: string | null } = {}) {
  const row: Record<string, AttributeValue> = {
    token_hash: { S: sha256(TOKEN) },
    email_hmac: { S: hmacEmail(EMAIL, HMAC_KEY) },
    created_at: { N: String(T0_MS / 1000) },
    expires_at: { N: String(T0_MS / 1000 + TTL_S) },
  };
  if (opts.rowCodeHash !== null) row["code_hash"] = { S: opts.rowCodeHash ?? sha256(CODE) };
  store.seed(TABLE, row);
  return { token_hash: sha256(TOKEN), code_hash: sha256(CODE), email: EMAIL, quarantined: "false" };
}

function event(params: Record<string, string>, answer: string): VerifyAuthChallengeEvent {
  return {
    userPoolId: "eu-central-1_test",
    userName: SUBJECT,
    request: {
      userAttributes: { email: EMAIL },
      privateChallengeParameters: params,
      challengeAnswer: answer,
      session: [],
    },
    response: {},
  };
}

beforeEach(() => {
  store = new FakeDynamo({ keys: { [TABLE]: "token_hash" } });
  allow = new FakeAllowList().add(SUBJECT, EMAIL);
  nowMs = T0_MS;
  lines = [];
  process.env[RuntimeEnv.TOKEN_TABLE_NAME] = TABLE;
  Reflect.deleteProperty(process.env, RuntimeEnv.ENROLLMENT);
  Reflect.deleteProperty(process.env, RuntimeEnv.COGNITO_USER_POOL_ID);
  vi.spyOn(process.stdout, "write").mockImplementation((c) => (lines.push(String(c)), true));
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
});

afterEach(() => vi.restoreAllMocks());

describe("classifyAnswer", () => {
  it("accepts exactly the two forms", () => {
    expect(classifyAnswer("A".repeat(43))).toBe("token");
    expect(classifyAnswer("a-_9".repeat(10) + "abc")).toBe("token");
    expect(classifyAnswer("00000000")).toBe("code");
    expect(classifyAnswer("12345678")).toBe("code");
  });

  it.each([
    ["empty", ""],
    ["7 digits", "1234567"],
    ["9 digits", "123456789"],
    ["digits with a space", "1234 5678"],
    ["Arabic-Indic digits (not ASCII)", "١٢٣٤٥٦٧٨"],
    ["fullwidth digits", "１２３４５６７８"],
    ["trailing newline", "12345678\n"],
    ["42-char token", "A".repeat(42)],
    ["44-char token", "A".repeat(44)],
    ["43 chars with a '+' (not base64url)", "A".repeat(42) + "+"],
    ["43 chars with '='", "A".repeat(42) + "="],
    ["43 chars with a newline", "A".repeat(42) + "\n"],
  ])("rejects %s", (_n, answer) => {
    expect(classifyAnswer(answer)).toBeUndefined();
  });

  it("rejects a non-string without throwing", () => {
    for (const v of [undefined, null, 12345678, {}, []]) expect(classifyAnswer(v)).toBeUndefined();
  });
});

describe("the code form", () => {
  it("redeems with the 8-digit code (same session, same row)", async () => {
    const params = issue();
    const result = await handler()(event(params, CODE));
    expect(result.response.answerCorrect).toBe(true);
    expect(store.count(TABLE)).toBe(0); // consumed
  });

  it("the link and the code are one secret: the code spends the link, and the link spends the code", async () => {
    let params = issue();
    expect((await handler()(event(params, CODE))).response.answerCorrect).toBe(true);
    expect((await handler()(event(params, TOKEN))).response.answerCorrect).toBe(false);

    store = new FakeDynamo({ keys: { [TABLE]: "token_hash" } });
    params = issue();
    expect((await handler()(event(params, TOKEN))).response.answerCorrect).toBe(true);
    expect((await handler()(event(params, CODE))).response.answerCorrect).toBe(false);
  });

  it("P: of N concurrent redemptions mixing both forms, exactly one succeeds", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.boolean(), { minLength: 2, maxLength: 10 }), async (useCode) => {
        store = new FakeDynamo({ keys: { [TABLE]: "token_hash" } });
        const params = issue();
        const results = await Promise.all(
          useCode.map((c) => handler()(event(params, c ? CODE : TOKEN))),
        );
        expect(results.filter((r) => r.response.answerCorrect === true)).toHaveLength(1);
      }),
      { numRuns: 40 },
    );
  });

  it("a wrong code fails and does not burn the row (compare before consume)", async () => {
    const params = issue();
    store.calls.length = 0;
    const result = await handler()(event(params, "00000000"));
    expect(result.response.answerCorrect).toBe(false);
    expect(store.calls).toEqual([]);
    expect(store.count(TABLE)).toBe(1);
  });

  it("the code of ANOTHER session fails and is not burned", async () => {
    const mine = issue();
    const other = { ...mine, code_hash: sha256("99999999") };
    const result = await handler()(event(other, CODE));
    expect(result.response.answerCorrect).toBe(false);
    expect(store.count(TABLE)).toBe(1);
    expect((await handler()(event(mine, CODE))).response.answerCorrect).toBe(true);
  });

  it("the row's own code_hash must match too: a row with a different or missing code hash refuses the code", async () => {
    for (const rowCodeHash of [sha256("99999999"), null]) {
      store = new FakeDynamo({ keys: { [TABLE]: "token_hash" } });
      const params = issue({ rowCodeHash });
      const result = await handler()(event(params, CODE));
      expect(result.response.answerCorrect).toBe(false);
    }
  });

  it("the token form does not need the row's code_hash (a link issued without one still works)", async () => {
    const params = issue({ rowCodeHash: null });
    expect((await handler()(event(params, TOKEN))).response.answerCorrect).toBe(true);
  });

  it("a session with no code_hash parameter refuses every code and still accepts the token", async () => {
    const { code_hash: _omit, ...params } = issue();
    void _omit;
    expect((await handler()(event(params, CODE))).response.answerCorrect).toBe(false);
    expect((await handler()(event(params, TOKEN))).response.answerCorrect).toBe(true);
  });

  it("an expired row refuses the code like it refuses the token", async () => {
    const params = issue();
    nowMs = T0_MS + TTL_S * 1000;
    expect((await handler()(event(params, CODE))).response.answerCorrect).toBe(false);
  });

  it("the unanswerable (quarantined) challenge refuses even a matching code", async () => {
    const params = { ...issue(), quarantined: "true" };
    expect((await handler()(event(params, CODE))).response.answerCorrect).toBe(false);
  });
});

describe("signin_answer_compare_constant_time (I14) — arbitrary answers", () => {
  it("P: never throws, and succeeds only for the token or the code", async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.string({ maxLength: 120 }), fc.stringMatching(/^[0-9]{0,10}$/)), async (answer) => {
        store = new FakeDynamo({ keys: { [TABLE]: "token_hash" } });
        const params = issue();
        const result = await handler()(event(params, answer));
        expect(result.response.answerCorrect).toBe(answer === TOKEN || answer === CODE);
      }),
      { numRuns: 300 },
    );
  });

  it("P: any answer that is not one of the two forms never reaches the store", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 100 }), async (answer) => {
        fc.pre(classifyAnswer(answer) === undefined);
        store = new FakeDynamo({ keys: { [TABLE]: "token_hash" } });
        const params = issue();
        store.calls.length = 0;
        const result = await handler()(event(params, answer));
        expect(result.response.answerCorrect).toBe(false);
        expect(store.calls).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it("a non-string answer is false without throwing", async () => {
    const params = issue();
    for (const answer of [undefined, null, 12345678, {}]) {
      const result = await handler()(event(params, answer as never));
      expect(result.response.answerCorrect).toBe(false);
    }
  });

  it("a malformed stored code hash is false without throwing", async () => {
    const params = { ...issue(), code_hash: "zz-not-hex" };
    expect((await handler()(event(params, CODE))).response.answerCorrect).toBe(false);
  });
});

describe("signin_redeem_rechecks_eligibility (I8)", () => {
  it("issue, then disable on the allow-list, then redeem: false (both forms)", async () => {
    for (const answer of [TOKEN, CODE]) {
      store = new FakeDynamo({ keys: { [TABLE]: "token_hash" } });
      allow = new FakeAllowList().add(SUBJECT, EMAIL);
      const params = issue();
      allow.setActive(SUBJECT, false);
      const result = await handler()(event(params, answer));
      expect(result.response.answerCorrect).toBe(false);
    }
  });

  it("a subject removed from the allow-list does not get in", async () => {
    const params = issue();
    allow.remove(SUBJECT);
    expect((await handler()(event(params, TOKEN))).response.answerCorrect).toBe(false);
  });

  it("an ineligible redemption has SPENT the link (documented: the link is spent; request a new one)", async () => {
    const params = issue();
    allow.setActive(SUBJECT, false);
    await handler()(event(params, TOKEN));
    expect(store.count(TABLE)).toBe(0);
    // Even once the person is re-enabled, the old link and code are gone.
    allow.setActive(SUBJECT, true);
    expect((await handler()(event(params, TOKEN))).response.answerCorrect).toBe(false);
    expect((await handler()(event(params, CODE))).response.answerCorrect).toBe(false);
  });

  it("asks about the event's own username, exactly once, after the hash compare matched", async () => {
    const params = issue();
    await handler()(event(params, "W".repeat(43)));
    expect(allow.gets).toEqual([]); // a mismatch never reaches the allow-list
    await handler()(event(params, TOKEN));
    expect(allow.gets).toEqual([SUBJECT]);
  });

  it("signin_fails_closed: an unavailable allow-list is false, never true", async () => {
    const params = issue();
    allow.unavailable = true;
    expect((await handler()(event(params, TOKEN))).response.answerCorrect).toBe(false);
  });

  it("signin_fails_closed: an allow-list that throws is false, never an exception", async () => {
    const params = issue();
    const throwing = createVerifyAuthChallengeResponseHandler({
      dynamodb: store as unknown as DynamoDBClient,
      resolveHmacKey: () => Promise.resolve(HMAC_KEY),
      nowMs: () => nowMs,
      allowList: { lookup: () => Promise.reject(new Error("x")), get: () => Promise.reject(new Error("x")) },
    });
    expect((await throwing(event(params, TOKEN))).response.answerCorrect).toBe(false);
  });

  it("self-signup mode does not consult the allow-list", async () => {
    process.env[RuntimeEnv.ENROLLMENT] = "self-signup";
    allow.remove(SUBJECT);
    const params = issue();
    expect((await handler()(event(params, TOKEN))).response.answerCorrect).toBe(true);
    expect(allow.calls).toEqual([]);
  });

  it.each(["self_signup", "open", "none"])(
    "an unknown enrolment value (%s) is a deployment error and never approves",
    async (bad) => {
      process.env[RuntimeEnv.ENROLLMENT] = bad;
      const params = issue();
      await expect(handler()(event(params, TOKEN))).rejects.toThrow();
      expect(store.count(TABLE)).toBe(1);
    },
  );
});

describe("signin_fails_closed — Verify's own dependencies (Secrets Manager, DynamoDB)", () => {
  const SDK_TEXT = `AccessDeniedException: not authorized to secretsmanager:GetSecretValue for ${EMAIL} ${SUBJECT}`;

  it("a Secrets Manager failure is answerCorrect=false — it does not throw", async () => {
    const params = issue();
    const h = createVerifyAuthChallengeResponseHandler({
      dynamodb: store as unknown as DynamoDBClient,
      resolveHmacKey: () => Promise.reject(new Error(SDK_TEXT)),
      nowMs: () => nowMs,
      allowList: allow,
    });
    const result = await h(event(params, TOKEN));
    expect(result.response.answerCorrect).toBe(false);
    expect(store.count(TABLE)).toBe(1); // nothing consumed
  });

  it("a token-store read failure is answerCorrect=false — it does not throw", async () => {
    const params = issue();
    const faulty = new FakeDynamo({
      keys: { [TABLE]: "token_hash" },
      fault: (cmd) => (cmd === "GetItem" ? new Error(SDK_TEXT) : undefined),
    });
    faulty.seed(TABLE, store.peek(TABLE, sha256(TOKEN))!);
    const h = createVerifyAuthChallengeResponseHandler({
      dynamodb: faulty as unknown as DynamoDBClient,
      resolveHmacKey: () => Promise.resolve(HMAC_KEY),
      nowMs: () => nowMs,
      allowList: allow,
    });
    for (const answer of [TOKEN, CODE]) {
      const result = await h(event(params, answer));
      expect(result.response.answerCorrect).toBe(false);
    }
    expect(faulty.count(TABLE)).toBe(1);
  });

  it("both end in one closed-enum log line, and no SDK error text, address or subject reaches stdout or stderr", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
    const params = issue();
    const faulty = new FakeDynamo({
      keys: { [TABLE]: "token_hash" },
      fault: (cmd) => (cmd === "GetItem" ? new Error(SDK_TEXT) : undefined),
    });
    faulty.seed(TABLE, store.peek(TABLE, sha256(TOKEN))!);
    const noKey = createVerifyAuthChallengeResponseHandler({
      dynamodb: store as unknown as DynamoDBClient,
      resolveHmacKey: () => Promise.reject(new Error(SDK_TEXT)),
      allowList: allow,
    });
    const noStore = createVerifyAuthChallengeResponseHandler({
      dynamodb: faulty as unknown as DynamoDBClient,
      resolveHmacKey: () => Promise.resolve(HMAC_KEY),
      nowMs: () => nowMs,
      allowList: allow,
    });
    await noKey(event(params, TOKEN));
    await noStore(event(params, TOKEN));
    const scanned = [...lines, ...errors].join("\n");
    expect(lines.filter((l) => l.includes("dependency_error"))).toHaveLength(2);
    for (const forbidden of ["AccessDenied", "secretsmanager", EMAIL, SUBJECT, TOKEN, CODE]) {
      expect(scanned).not.toContain(forbidden);
    }
    expect(scanned).not.toMatch(/@/);
    expect(scanned).not.toMatch(/[A-Za-z0-9_-]{20,}/);
    expect(errors).toEqual([]);
  });
});

describe("signin_secrets_never_logged (I12) — the Verify paths", () => {
  it("logs no answer, address or subject on success or on any failure", async () => {
    const arrangements: Array<() => { params: Record<string, string>; answer: string }> = [
      () => ({ params: issue(), answer: TOKEN }),
      () => ({ params: issue(), answer: CODE }),
      () => ({ params: issue(), answer: "00000000" }),
      () => ({ params: issue(), answer: "x".repeat(10) }),
      () => {
        const params = issue();
        allow.setActive(SUBJECT, false);
        return { params, answer: CODE };
      },
      () => {
        const params = issue();
        allow.unavailable = true;
        return { params, answer: TOKEN };
      },
    ];
    for (const arrange of arrangements) {
      store = new FakeDynamo({ keys: { [TABLE]: "token_hash" } });
      allow = new FakeAllowList().add(SUBJECT, EMAIL);
      const { params, answer } = arrange();
      await handler()(event(params, answer));
    }
    const scanned = lines.join("\n");
    expect(scanned.length).toBeGreaterThan(0);
    expect(scanned).not.toMatch(/@/);
    expect(scanned).not.toMatch(/\d{6,}/);
    expect(scanned).not.toMatch(/[A-Za-z0-9_-]{20,}/);
    for (const secret of [EMAIL, SUBJECT, TOKEN, CODE, sha256(TOKEN), sha256(CODE)]) {
      expect(scanned).not.toContain(secret);
    }
  });
});
