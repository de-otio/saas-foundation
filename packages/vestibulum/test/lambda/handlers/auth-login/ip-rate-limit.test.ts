/**
 * Tests for the per-client-IP login rate limiter
 * (`src/lambda/handlers/auth-login/ip-rate-limit.ts`).
 *
 * Same conditional-UpdateItem mechanism as the per-email limiter; the cases
 * that matter:
 *   - Under the limit                 → allowed (true).
 *   - Over the limit (DynamoDB rejects via ConditionalCheckFailedException)
 *                                     → denied (false), NOT a throw.
 *   - Window reset via INJECTED clock → a new window key is used.
 *   - Any other DynamoDB error        → propagates (fail-loud).
 *   - Keyspace isolation              → the hashed PK is prefixed with
 *                                       `login-ip:`, disjoint from the email
 *                                       limiter's keyspace.
 *
 * Determinism: clock is injected via `nowMs`; no real Date. Network is mocked
 * at the SDK boundary via aws-sdk-client-mock.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { createHash } from "crypto";

import {
  tryConsumeIpRateLimit,
  IP_RATE_LIMIT_WINDOW_MS,
  DEFAULT_LOGINS_PER_WINDOW,
} from "../../../../src/lambda/handlers/auth-login/ip-rate-limit.js";

const ddbMock = mockClient(DynamoDBClient);
const TABLE = "magic-link-rate-limit";
const IP = "203.0.113.7";
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

describe("tryConsumeIpRateLimit", () => {
  it("allows an attempt when the conditional UpdateItem succeeds (under limit)", async () => {
    ddbMock.on(UpdateItemCommand).resolves({});
    const allowed = await tryConsumeIpRateLimit({
      client: makeClient(),
      tableName: TABLE,
      ip: IP,
      limit: DEFAULT_LOGINS_PER_WINDOW,
      nowMs: FIXED_NOW_MS,
    });
    expect(allowed).toBe(true);
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(1);
  });

  it("DENIES (returns false, not throws) when the limit is hit — ConditionalCheckFailed", async () => {
    ddbMock.on(UpdateItemCommand).rejects(
      new ConditionalCheckFailedException({ message: "over limit", $metadata: {} }),
    );
    const allowed = await tryConsumeIpRateLimit({
      client: makeClient(),
      tableName: TABLE,
      ip: IP,
      limit: DEFAULT_LOGINS_PER_WINDOW,
      nowMs: FIXED_NOW_MS,
    });
    expect(allowed).toBe(false);
  });

  it("pins the limit into the conditional expression (boundary enforced server-side)", async () => {
    ddbMock.on(UpdateItemCommand).resolves({});
    await tryConsumeIpRateLimit({
      client: makeClient(),
      tableName: TABLE,
      ip: IP,
      limit: 10,
      nowMs: FIXED_NOW_MS,
    });
    const call = ddbMock.commandCalls(UpdateItemCommand)[0]!;
    const input = call.args[0].input;
    expect(input.ConditionExpression).toContain("#c < :limit");
    expect(input.ExpressionAttributeValues?.[":limit"]).toEqual({ N: "10" });
  });

  it("hashes the bucket_id under a `login-ip:` prefix (disjoint from the email keyspace)", async () => {
    ddbMock.on(UpdateItemCommand).resolves({});
    await tryConsumeIpRateLimit({
      client: makeClient(),
      tableName: TABLE,
      ip: IP,
      limit: 10,
      nowMs: FIXED_NOW_MS,
    });
    const call = ddbMock.commandCalls(UpdateItemCommand)[0]!;
    const key = (call.args[0].input.Key as { bucket_id: { S: string } }).bucket_id.S;

    const windowStart = Math.floor(FIXED_NOW_MS / IP_RATE_LIMIT_WINDOW_MS) * IP_RATE_LIMIT_WINDOW_MS;
    const expected = createHash("sha256").update(`login-ip:${IP}#${windowStart}`).digest("hex");
    expect(key).toBe(expected);

    // It must NOT equal the email-limiter's unprefixed hash for the same value.
    const emailStyle = createHash("sha256").update(`${IP}#${windowStart}`).digest("hex");
    expect(key).not.toBe(emailStyle);
  });

  it("maps the same nowMs to a stable window key (no sub-window clock jitter evasion)", async () => {
    ddbMock.on(UpdateItemCommand).resolves({});
    const windowStart = Math.floor(FIXED_NOW_MS / IP_RATE_LIMIT_WINDOW_MS) * IP_RATE_LIMIT_WINDOW_MS;
    const midWindow = windowStart + Math.floor(IP_RATE_LIMIT_WINDOW_MS / 2);
    await tryConsumeIpRateLimit({
      client: makeClient(),
      tableName: TABLE,
      ip: IP,
      limit: 10,
      nowMs: windowStart + 1,
    });
    await tryConsumeIpRateLimit({
      client: makeClient(),
      tableName: TABLE,
      ip: IP,
      limit: 10,
      nowMs: midWindow,
    });
    const calls = ddbMock.commandCalls(UpdateItemCommand);
    const key0 = (calls[0]!.args[0].input.Key as { bucket_id: { S: string } }).bucket_id.S;
    const key1 = (calls[1]!.args[0].input.Key as { bucket_id: { S: string } }).bucket_id.S;
    expect(key0).toBe(key1);
    expect(calls[0]!.args[0].input.ExpressionAttributeValues?.[":ws"]).toEqual({
      N: String(windowStart),
    });
  });

  it("uses a DIFFERENT window key after the window rolls over (injected clock)", async () => {
    ddbMock.on(UpdateItemCommand).resolves({});
    await tryConsumeIpRateLimit({
      client: makeClient(),
      tableName: TABLE,
      ip: IP,
      limit: 10,
      nowMs: FIXED_NOW_MS,
    });
    await tryConsumeIpRateLimit({
      client: makeClient(),
      tableName: TABLE,
      ip: IP,
      limit: 10,
      nowMs: FIXED_NOW_MS + IP_RATE_LIMIT_WINDOW_MS,
    });
    const calls = ddbMock.commandCalls(UpdateItemCommand);
    const key0 = (calls[0]!.args[0].input.Key as { bucket_id: { S: string } }).bucket_id.S;
    const key1 = (calls[1]!.args[0].input.Key as { bucket_id: { S: string } }).bucket_id.S;
    expect(key0).not.toBe(key1);
  });

  it("honours a custom windowMs override", async () => {
    ddbMock.on(UpdateItemCommand).resolves({});
    const customWindow = 60_000;
    await tryConsumeIpRateLimit({
      client: makeClient(),
      tableName: TABLE,
      ip: IP,
      limit: 10,
      nowMs: FIXED_NOW_MS,
      windowMs: customWindow,
    });
    const windowStart = Math.floor(FIXED_NOW_MS / customWindow) * customWindow;
    const call = ddbMock.commandCalls(UpdateItemCommand)[0]!;
    expect(call.args[0].input.ExpressionAttributeValues?.[":ws"]).toEqual({
      N: String(windowStart),
    });
  });

  it("propagates non-conditional DynamoDB errors (fail-loud, never silently allow)", async () => {
    ddbMock.on(UpdateItemCommand).rejects(new Error("ProvisionedThroughputExceeded"));
    await expect(
      tryConsumeIpRateLimit({
        client: makeClient(),
        tableName: TABLE,
        ip: IP,
        limit: 10,
        nowMs: FIXED_NOW_MS,
      }),
    ).rejects.toThrow(/ProvisionedThroughputExceeded/);
  });
});
