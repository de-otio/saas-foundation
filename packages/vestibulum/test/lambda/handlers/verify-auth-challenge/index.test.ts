/**
 * VerifyAuthChallengeResponse — the invariants it owns.
 *
 * Test names carry the invariant ids from dot-notes
 * `doc/topics/passwordless-sign-in-aws/02-spec.md` verbatim:
 *   signin_link_single_use, signin_link_expires_10min,
 *   signin_answer_compare_constant_time, and 01-evidence #17
 *   ("compare before consume").
 *
 * State lives in a FakeDynamo with real conditional-write semantics, so the
 * assertions are about what is LEFT in the table — a mock that returns "ok"
 * would pass a handler that burns tokens in the wrong order.
 */

import { createHash } from "crypto";
import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import type { AttributeValue, DynamoDBClient } from "@aws-sdk/client-dynamodb";

import {
  createVerifyAuthChallengeResponseHandler,
  type VerifyAuthChallengeEvent,
} from "../../../../src/lambda/handlers/verify-auth-challenge/index.js";
import { hmacEmail } from "../../../../src/lambda/shared/email-hmac.js";
import { RuntimeEnv } from "../../../../src/lambda/shared/runtime-env.js";
import { FakeDynamo } from "../../fakes/fake-dynamo.js";

const TABLE = "tokens";
const HMAC_KEY = "test-hmac-key-not-a-secret";
const EMAIL = "person@example.com";
const T0_MS = 1_700_000_000_000;
const TTL_S = 600;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

let store: FakeDynamo;
let nowMs: number;

function handler() {
  return createVerifyAuthChallengeResponseHandler({
    dynamodb: store as unknown as DynamoDBClient,
    resolveHmacKey: () => Promise.resolve(HMAC_KEY),
    nowMs: () => nowMs,
  });
}

/** What CreateAuthChallenge leaves behind for one issued link. */
function issue(token: string, opts: { expiresAtSeconds?: number | null; email?: string } = {}) {
  const email = opts.email ?? EMAIL;
  const row: Record<string, AttributeValue> = {
    token_hash: { S: sha256(token) },
    email_hmac: { S: hmacEmail(email, HMAC_KEY) },
    created_at: { N: String(T0_MS / 1000) },
  };
  if (opts.expiresAtSeconds !== null) {
    row["expires_at"] = { N: String(opts.expiresAtSeconds ?? T0_MS / 1000 + TTL_S) };
  }
  store.seed(TABLE, row);
  // privateChallengeParameters of THIS session.
  return { token_hash: sha256(token), email, quarantined: "false" };
}

function event(
  privateParams: Record<string, string>,
  answer: string,
): VerifyAuthChallengeEvent {
  return {
    userPoolId: "eu-central-1_test",
    userName: "user-1",
    request: {
      userAttributes: { email: EMAIL },
      privateChallengeParameters: privateParams,
      challengeAnswer: answer,
      session: [],
    },
    response: {},
  };
}

beforeEach(() => {
  store = new FakeDynamo({ keys: { [TABLE]: "token_hash" } });
  nowMs = T0_MS;
  process.env[RuntimeEnv.TOKEN_TABLE_NAME] = TABLE;
});

describe("signin_link_single_use", () => {
  it("accepts the right token once; the second redemption fails", async () => {
    const params = issue("token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const first = await handler()(event(params, "token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    const second = await handler()(event(params, "token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    expect(first.response.answerCorrect).toBe(true);
    expect(second.response.answerCorrect).toBe(false);
    expect(store.count(TABLE)).toBe(0);
  });

  it("P: of N concurrent redemptions of one token, exactly one succeeds", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 12 }), async (n) => {
        store = new FakeDynamo({ keys: { [TABLE]: "token_hash" } });
        const token = "t".repeat(43);
        const params = issue(token);
        const results = await Promise.all(
          Array.from({ length: n }, () => handler()(event(params, token))),
        );
        expect(results.filter((r) => r.response.answerCorrect === true)).toHaveLength(1);
      }),
      { numRuns: 40 },
    );
  });
});

describe("compare before consume (01-evidence #17)", () => {
  it("a valid token presented against ANOTHER session fails and is not burned", async () => {
    const tokenA = "a".repeat(43);
    const tokenB = "b".repeat(43);
    const sessionA = issue(tokenA);
    const sessionB = issue(tokenB);

    // The link for session A is presented in session B.
    const crossed = await handler()(event(sessionB, tokenA));
    expect(crossed.response.answerCorrect).toBe(false);

    // Token A's row is still there ...
    expect(store.peek(TABLE, sha256(tokenA))).toBeDefined();
    // ... and its real owner can still redeem it.
    const owner = await handler()(event(sessionA, tokenA));
    expect(owner.response.answerCorrect).toBe(true);
  });

  it("a wrong guess does not touch the token store at all", async () => {
    const params = issue("c".repeat(43));
    store.calls.length = 0;
    const result = await handler()(event(params, "z".repeat(43)));
    expect(result.response.answerCorrect).toBe(false);
    expect(store.calls).toEqual([]);
  });
});

describe("signin_link_expires_10min", () => {
  const token = "e".repeat(43);

  it("succeeds at 9:59 and fails at 10:00 (the row's own expires_at)", async () => {
    const params = issue(token);
    nowMs = T0_MS + (TTL_S - 1) * 1000 + 999; // 9:59.999
    const early = await handler()(event(params, token));
    expect(early.response.answerCorrect).toBe(true);

    store = new FakeDynamo({ keys: { [TABLE]: "token_hash" } });
    const params2 = issue(token);
    nowMs = T0_MS + TTL_S * 1000; // exactly 10:00
    const late = await handler()(event(params2, token));
    expect(late.response.answerCorrect).toBe(false);
  });

  it("does not rely on DynamoDB TTL deletion: an expired row that is still present fails", async () => {
    const params = issue(token);
    nowMs = T0_MS + 3 * 3600 * 1000; // TTL deletion lags by hours
    expect(store.peek(TABLE, sha256(token))).toBeDefined();
    const result = await handler()(event(params, token));
    expect(result.response.answerCorrect).toBe(false);
  });

  it("fails closed when the row has no expires_at (e.g. written under the old `ttl` name)", async () => {
    const params = issue(token, { expiresAtSeconds: null });
    const result = await handler()(event(params, token));
    expect(result.response.answerCorrect).toBe(false);
  });

  it("fails closed when expires_at is not a number", async () => {
    const params = issue(token);
    store.seed(TABLE, {
      token_hash: { S: sha256(token) },
      email_hmac: { S: hmacEmail(EMAIL, HMAC_KEY) },
      expires_at: { N: "not-a-number" },
    });
    const result = await handler()(event(params, token));
    expect(result.response.answerCorrect).toBe(false);
  });
});

describe("signin_answer_compare_constant_time", () => {
  it("P: arbitrary answers never throw and never succeed against a random token", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 200 }), async (answer) => {
        store = new FakeDynamo({ keys: { [TABLE]: "token_hash" } });
        const token = "q".repeat(43);
        const params = issue(token);
        const result = await handler()(event(params, answer));
        expect(result.response.answerCorrect).toBe(answer === token);
      }),
      { numRuns: 200 },
    );
  });

  it("rejects an over-long answer without touching the store", async () => {
    const params = issue("l".repeat(43));
    store.calls.length = 0;
    const result = await handler()(event(params, "x".repeat(10_000)));
    expect(result.response.answerCorrect).toBe(false);
    expect(store.calls).toEqual([]);
  });

  it("rejects a malformed stored hash without throwing", async () => {
    const result = await handler()(
      event({ token_hash: "not-hex", email: EMAIL, quarantined: "false" }, "y".repeat(43)),
    );
    expect(result.response.answerCorrect).toBe(false);
  });
});

describe("fail closed", () => {
  it("a token-store read error is not answerCorrect", async () => {
    const token = "f".repeat(43);
    const params = issue(token);
    store = new FakeDynamo({
      keys: { [TABLE]: "token_hash" },
      fault: (cmd) => (cmd === "GetItem" ? new Error("ddb down") : undefined),
    });
    store.seed(TABLE, {
      token_hash: { S: sha256(token) },
      email_hmac: { S: hmacEmail(EMAIL, HMAC_KEY) },
      expires_at: { N: String(T0_MS / 1000 + TTL_S) },
    });
    // The handler may throw (Cognito then fails the challenge) but must never approve.
    const outcome = await handler()(event(params, token)).then(
      (r) => r.response.answerCorrect,
      () => false,
    );
    expect(outcome).toBe(false);
  });

  it("a quarantined challenge never succeeds even with a correct token", async () => {
    const token = "g".repeat(43);
    const params = { ...issue(token), quarantined: "true" };
    const result = await handler()(event(params, token));
    expect(result.response.answerCorrect).toBe(false);
  });
});
