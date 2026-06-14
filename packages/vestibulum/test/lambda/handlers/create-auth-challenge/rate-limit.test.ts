/**
 * Tests for the single-tenant magic-link send rate limiter
 * (`src/lambda/handlers/create-auth-challenge/rate-limit.ts`).
 *
 * This is a cost-DoS / enumeration surface (06 § Rate-limit and cost-DoS
 * evasion) that had no dedicated test before this file (Phase 2 gap-fill).
 *
 * The limiter is enforced via a conditional DynamoDB UpdateItem; the abuse
 * cases that matter:
 *   - Under the limit                → allowed (true).
 *   - Over the limit (the DB rejects via ConditionalCheckFailedException)
 *                                    → denied (false), NOT a throw — so the
 *                                      caller can return the same generic
 *                                      challenge (no enumeration oracle).
 *   - Window reset via INJECTED clock → a new window key is used, so a fresh
 *                                      send is allowed even if the prior
 *                                      window was exhausted; and the same
 *                                      nowMs always maps to the same window
 *                                      (not evadable by sub-window clock
 *                                      jitter).
 *   - Any other DynamoDB error        → propagates (fail-loud, not silently
 *                                      allow).
 *
 * Determinism: clock is injected via `nowMs`; no real Date. Network is
 * mocked at the SDK boundary via aws-sdk-client-mock.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import {
  tryConsumeRateLimit,
  RATE_LIMIT_WINDOW_MS,
  DEFAULT_SENDS_PER_WINDOW,
} from "../../../../src/lambda/handlers/create-auth-challenge/rate-limit.js";

const ddbMock = mockClient(DynamoDBClient);
const TABLE = "magic-link-rate-limit";
const EMAIL = "user@example.com";
// A fixed epoch (no real Date) that sits at a clean window boundary offset.
const FIXED_NOW_MS = 1_700_000_000_000;

function makeClient(): DynamoDBClient {
  return new DynamoDBClient({ region: "eu-central-1" });
}

beforeEach(() => {
  ddbMock.reset();
});

afterEach(() => {
  ddbMock.reset();
});

describe("tryConsumeRateLimit", () => {
  it("allows a send when the conditional UpdateItem succeeds (under limit)", async () => {
    ddbMock.on(UpdateItemCommand).resolves({});
    const allowed = await tryConsumeRateLimit({
      client: makeClient(),
      tableName: TABLE,
      email: EMAIL,
      limit: DEFAULT_SENDS_PER_WINDOW,
      nowMs: FIXED_NOW_MS,
    });
    expect(allowed).toBe(true);
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(1);
  });

  it("DENIES (returns false, not throws) when the limit is hit — ConditionalCheckFailed", async () => {
    // DynamoDB rejects the atomic increment because `#c < :limit` is false:
    // the email is over its per-window send budget. The limiter must return
    // false (so the caller emits the same generic challenge — no enumeration),
    // never propagate the rejection.
    ddbMock.on(UpdateItemCommand).rejects(
      new ConditionalCheckFailedException({ message: "over limit", $metadata: {} }),
    );
    const allowed = await tryConsumeRateLimit({
      client: makeClient(),
      tableName: TABLE,
      email: EMAIL,
      limit: DEFAULT_SENDS_PER_WINDOW,
      nowMs: FIXED_NOW_MS,
    });
    expect(allowed).toBe(false);
  });

  it("pins the limit into the conditional expression (the boundary is enforced server-side)", async () => {
    // The off-by-one boundary lives in the DynamoDB ConditionExpression
    // (`#c < :limit`). We can't run real DynamoDB here, but we pin that the
    // configured `limit` is the value placed in `:limit` and that the
    // condition is exactly the strict-less-than form — so a server-side eval
    // admits the Nth send and rejects the (N+1)th.
    ddbMock.on(UpdateItemCommand).resolves({});
    await tryConsumeRateLimit({
      client: makeClient(),
      tableName: TABLE,
      email: EMAIL,
      limit: 3,
      nowMs: FIXED_NOW_MS,
    });
    const call = ddbMock.commandCalls(UpdateItemCommand)[0]!;
    const input = call.args[0].input;
    expect(input.ConditionExpression).toContain("#c < :limit");
    expect(input.ExpressionAttributeValues?.[":limit"]).toEqual({ N: "3" });
  });

  it("maps the same nowMs to a stable window key (no sub-window clock jitter evasion)", async () => {
    ddbMock.on(UpdateItemCommand).resolves({});
    // Two calls anywhere inside the same window must use the same rate_key
    // (window-start hash) — so an attacker nudging the clock within a window
    // cannot reset their counter.
    const windowStart = Math.floor(FIXED_NOW_MS / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;
    const midWindow = windowStart + Math.floor(RATE_LIMIT_WINDOW_MS / 2);
    await tryConsumeRateLimit({
      client: makeClient(),
      tableName: TABLE,
      email: EMAIL,
      limit: 3,
      nowMs: windowStart + 1,
    });
    await tryConsumeRateLimit({
      client: makeClient(),
      tableName: TABLE,
      email: EMAIL,
      limit: 3,
      nowMs: midWindow,
    });
    const calls = ddbMock.commandCalls(UpdateItemCommand);
    const key0 = (calls[0]!.args[0].input.Key as { rate_key: { S: string } }).rate_key.S;
    const key1 = (calls[1]!.args[0].input.Key as { rate_key: { S: string } }).rate_key.S;
    expect(key0).toBe(key1);
    // And the window_start value written matches the bucket they share.
    expect(calls[0]!.args[0].input.ExpressionAttributeValues?.[":ws"]).toEqual({
      N: String(windowStart),
    });
  });

  it("uses a DIFFERENT window key after the window rolls over (injected clock)", async () => {
    ddbMock.on(UpdateItemCommand).resolves({});
    await tryConsumeRateLimit({
      client: makeClient(),
      tableName: TABLE,
      email: EMAIL,
      limit: 3,
      nowMs: FIXED_NOW_MS,
    });
    // One full window later → a fresh window bucket (the key must differ).
    await tryConsumeRateLimit({
      client: makeClient(),
      tableName: TABLE,
      email: EMAIL,
      limit: 3,
      nowMs: FIXED_NOW_MS + RATE_LIMIT_WINDOW_MS,
    });
    const calls = ddbMock.commandCalls(UpdateItemCommand);
    const key0 = (calls[0]!.args[0].input.Key as { rate_key: { S: string } }).rate_key.S;
    const key1 = (calls[1]!.args[0].input.Key as { rate_key: { S: string } }).rate_key.S;
    expect(key0).not.toBe(key1);
  });

  it("treats the email case-insensitively (Mixed-case maps to the same bucket)", async () => {
    ddbMock.on(UpdateItemCommand).resolves({});
    await tryConsumeRateLimit({
      client: makeClient(),
      tableName: TABLE,
      email: "User@Example.COM",
      limit: 3,
      nowMs: FIXED_NOW_MS,
    });
    await tryConsumeRateLimit({
      client: makeClient(),
      tableName: TABLE,
      email: "user@example.com",
      limit: 3,
      nowMs: FIXED_NOW_MS,
    });
    const calls = ddbMock.commandCalls(UpdateItemCommand);
    const key0 = (calls[0]!.args[0].input.Key as { rate_key: { S: string } }).rate_key.S;
    const key1 = (calls[1]!.args[0].input.Key as { rate_key: { S: string } }).rate_key.S;
    expect(key0).toBe(key1);
  });

  it("propagates non-conditional DynamoDB errors (fail-loud, never silently allow)", async () => {
    ddbMock.on(UpdateItemCommand).rejects(new Error("ProvisionedThroughputExceeded"));
    await expect(
      tryConsumeRateLimit({
        client: makeClient(),
        tableName: TABLE,
        email: EMAIL,
        limit: 3,
        nowMs: FIXED_NOW_MS,
      }),
    ).rejects.toThrow(/ProvisionedThroughputExceeded/);
  });
});
