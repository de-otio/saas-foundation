/**
 * Tests for `DynamoTokenBucketLimiter`.
 *
 * Uses `aws-sdk-client-mock` against `@aws-sdk/client-dynamodb`.
 *
 * Coverage:
 *   - first-call grants (no existing item)
 *   - under-limit grants
 *   - over-limit denies
 *   - retry-after is positive on deny
 *   - concurrency: ConditionalCheckFailedException triggers retry
 *   - reset deletes the row
 *   - peek is informational (no write)
 *   - unknownKeyStrategy: reject, shared-bucket, allow
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  ConditionalCheckFailedException,
} from "@aws-sdk/client-dynamodb";
import { mockClient, type AwsClientStub } from "aws-sdk-client-mock";
import { marshall } from "@aws-sdk/util-dynamodb";

import { DynamoTokenBucketLimiter } from "../../src/rate-limit/dynamo-limiter.js";
import { RateLimitConfigError } from "../../src/rate-limit/errors.js";
import type { TokenBucketConfig } from "../../src/rate-limit/types.js";

const FROZEN_EPOCH_MS = 1_779_611_415_000;
const TABLE = "test-rate-limit";
const NS = "ratelimit";
const CONFIG: TokenBucketConfig = { capacity: 5, refillRate: 1 };

function makeLimiter(
  client: DynamoDBClient,
  opts?: Partial<ConstructorParameters<typeof DynamoTokenBucketLimiter>[1]>,
): DynamoTokenBucketLimiter {
  return new DynamoTokenBucketLimiter(client, {
    tableName: TABLE,
    namespace: NS,
    defaultConfig: CONFIG,
    ...opts,
  });
}

function fullBucketItem(): Record<string, unknown> {
  return marshall({ PK: `${NS}#key`, tokens: 5, lastRefillMs: FROZEN_EPOCH_MS });
}

function partialBucketItem(tokens: number): Record<string, unknown> {
  return marshall({ PK: `${NS}#key`, tokens, lastRefillMs: FROZEN_EPOCH_MS });
}

describe("DynamoTokenBucketLimiter — construction", () => {
  it("throws RateLimitConfigError on empty tableName", () => {
    expect(
      () =>
        new DynamoTokenBucketLimiter(new DynamoDBClient({}), {
          tableName: "",
          namespace: NS,
        }),
    ).toThrow(RateLimitConfigError);
  });

  it("throws RateLimitConfigError on empty namespace", () => {
    expect(
      () =>
        new DynamoTokenBucketLimiter(new DynamoDBClient({}), {
          tableName: TABLE,
          namespace: "",
        }),
    ).toThrow(RateLimitConfigError);
  });

  it("throws RateLimitConfigError on invalid defaultConfig", () => {
    expect(
      () =>
        new DynamoTokenBucketLimiter(new DynamoDBClient({}), {
          tableName: TABLE,
          namespace: NS,
          defaultConfig: { capacity: 0, refillRate: 1 },
        }),
    ).toThrow(RateLimitConfigError);
  });
});

describe("DynamoTokenBucketLimiter — consume: happy path", () => {
  let mock: AwsClientStub<DynamoDBClient>;
  let client: DynamoDBClient;
  let limiter: DynamoTokenBucketLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
    mock = mockClient(DynamoDBClient);
    client = new DynamoDBClient({});
    limiter = makeLimiter(client);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("first call (no existing item) is granted", async () => {
    // GetItem returns no item → bucket doesn't exist → full bucket assumed.
    mock.on(GetItemCommand).resolves({ Item: undefined });
    mock.on(UpdateItemCommand).resolves({});

    const result = await limiter.consume("key", 1);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("under-limit call is allowed and issues exactly one GetItem + one UpdateItem", async () => {
    mock.on(GetItemCommand).resolves({ Item: fullBucketItem() });
    mock.on(UpdateItemCommand).resolves({});

    const result = await limiter.consume("key", 2);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(3);

    expect(mock.commandCalls(GetItemCommand)).toHaveLength(1);
    expect(mock.commandCalls(UpdateItemCommand)).toHaveLength(1);
  });

  it("over-limit call is denied", async () => {
    mock.on(GetItemCommand).resolves({ Item: partialBucketItem(1) });
    mock.on(UpdateItemCommand).resolves({});

    const result = await limiter.consume("key", 5);
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("UpdateItem uses attribute_not_exists condition for new item", async () => {
    mock.on(GetItemCommand).resolves({ Item: undefined });
    mock.on(UpdateItemCommand).resolves({});

    await limiter.consume("key", 1);

    const updateCall = mock.commandCalls(UpdateItemCommand)[0]!;
    expect(updateCall.args[0].input.ConditionExpression).toBe("attribute_not_exists(PK)");
  });

  it("UpdateItem uses lastRefillMs condition for existing item", async () => {
    mock.on(GetItemCommand).resolves({ Item: fullBucketItem() });
    mock.on(UpdateItemCommand).resolves({});

    await limiter.consume("key", 1);

    const updateCall = mock.commandCalls(UpdateItemCommand)[0]!;
    expect(updateCall.args[0].input.ConditionExpression).toBe("lastRefillMs = :prevLastRefillMs");
  });
});

describe("DynamoTokenBucketLimiter — concurrency retry", () => {
  // Use REAL timers for this describe block: the retry logic uses
  // `setTimeout` internally and the backoff delays (10–40 ms) are too
  // short to bother with fake-timer advancement.
  it("retries on ConditionalCheckFailedException and eventually succeeds", async () => {
    const mock = mockClient(DynamoDBClient);
    const client = new DynamoDBClient({});
    const limiter = makeLimiter(client);

    mock.on(GetItemCommand).resolves({ Item: fullBucketItem() });
    // Fail first UpdateItem, then succeed on second.
    mock
      .on(UpdateItemCommand)
      .rejectsOnce(new ConditionalCheckFailedException({ $metadata: {}, message: "conflict" }))
      .resolves({});

    const result = await limiter.consume("key", 1);
    // After the retry, we expect the result to be allowed.
    expect(result.allowed).toBe(true);
    // Two UpdateItem calls (initial + one retry).
    expect(mock.commandCalls(UpdateItemCommand).length).toBeGreaterThanOrEqual(2);
  }, 5_000); // 5 s is plenty for the 10 ms real-timer backoff
});

describe("DynamoTokenBucketLimiter — reset", () => {
  let mock: AwsClientStub<DynamoDBClient>;
  let client: DynamoDBClient;
  let limiter: DynamoTokenBucketLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
    mock = mockClient(DynamoDBClient);
    client = new DynamoDBClient({});
    limiter = makeLimiter(client);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reset issues a DeleteItemCommand", async () => {
    mock.on(DeleteItemCommand).resolves({});
    await limiter.reset("key");
    expect(mock.commandCalls(DeleteItemCommand)).toHaveLength(1);
  });

  it("reset uses the correct namespaced key", async () => {
    mock.on(DeleteItemCommand).resolves({});
    await limiter.reset("my-key");
    const deleteCall = mock.commandCalls(DeleteItemCommand)[0]!;
    expect(JSON.stringify(deleteCall.args[0].input.Key)).toContain(`${NS}#my-key`);
  });
});

describe("DynamoTokenBucketLimiter — peek", () => {
  let mock: AwsClientStub<DynamoDBClient>;
  let client: DynamoDBClient;
  let limiter: DynamoTokenBucketLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
    mock = mockClient(DynamoDBClient);
    client = new DynamoDBClient({});
    limiter = makeLimiter(client);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("peek issues only a GetItemCommand (no UpdateItem)", async () => {
    mock.on(GetItemCommand).resolves({ Item: fullBucketItem() });

    await limiter.peek("key");

    expect(mock.commandCalls(GetItemCommand)).toHaveLength(1);
    expect(mock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it("peek shows full bucket for new key", async () => {
    mock.on(GetItemCommand).resolves({ Item: undefined });

    const result = await limiter.peek("key");
    expect(result.remaining).toBe(CONFIG.capacity);
    expect(result.allowed).toBe(true);
  });
});

describe("DynamoTokenBucketLimiter — unknownKeyStrategy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reject: returns denied without DynamoDB round-trip", async () => {
    const mock = mockClient(DynamoDBClient);
    const client = new DynamoDBClient({});
    const limiter = makeLimiter(client, { unknownKeyStrategy: "reject" });

    const result = await limiter.consume("ip:unknown", 1);
    expect(result.allowed).toBe(false);
    expect(mock.commandCalls(GetItemCommand)).toHaveLength(0);
    expect(mock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it("shared-bucket: unknown-key calls hit DynamoDB (shared row)", async () => {
    const mock = mockClient(DynamoDBClient);
    mock.on(GetItemCommand).resolves({ Item: undefined });
    mock.on(UpdateItemCommand).resolves({});

    const client = new DynamoDBClient({});
    const limiter = makeLimiter(client, { unknownKeyStrategy: "shared-bucket" });

    const result = await limiter.consume("ip:unknown", 1);
    expect(result.allowed).toBe(true);
    expect(mock.commandCalls(GetItemCommand)).toHaveLength(1);
  });
});
