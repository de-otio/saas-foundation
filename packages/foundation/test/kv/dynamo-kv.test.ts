/**
 * Unit tests for DynamoKv.
 *
 * Uses `aws-sdk-client-mock` to mock the DynamoDB SDK client at the SDK
 * boundary. No real network calls.
 *
 * Time: all time-sensitive assertions use vi.useFakeTimers() with a deterministic
 * frozen epoch (1_700_000_000 seconds = 2023-11-14T22:13:20Z).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { mockClient, type AwsClientStub } from "aws-sdk-client-mock";
import {
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { DynamoKv } from "../../src/kv/dynamo-kv.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABLE = "test-table";
const NS = "test-ns";

/** Deterministic frozen time: 2023-11-14T22:13:20Z in epoch seconds */
const FROZEN_EPOCH_S = 1_700_000_000;
const FROZEN_EPOCH_MS = FROZEN_EPOCH_S * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKv(cursorSecret?: string): DynamoKv {
  const client = new DynamoDBClient({});
  return new DynamoKv(client, { tableName: TABLE, namespace: NS, cursorSecret });
}

/** Build a marshalled DynamoDB item for a KV entry. */
function makeItem(
  key: string,
  value: string,
  opts?: { ttl?: number; metadata?: string },
): ReturnType<typeof marshall> {
  const item: Record<string, unknown> = {
    pk: `${NS}:${key}`,
    sk: "v",
    value,
  };
  if (opts?.ttl !== undefined) item["ttl"] = opts.ttl;
  if (opts?.metadata !== undefined) item["metadata"] = opts.metadata;
  return marshall(item);
}

// ---------------------------------------------------------------------------
// get — hit / miss
// ---------------------------------------------------------------------------

describe("DynamoKv.get", () => {
  let mock: AwsClientStub<DynamoDBClient>;
  let kv: DynamoKv;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
    mock = mockClient(DynamoDBClient);
    kv = makeKv();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null on miss", async () => {
    mock.on(GetItemCommand).resolves({ Item: undefined });
    expect(await kv.get("missing-key")).toBeNull();
  });

  it("returns string value on hit", async () => {
    mock.on(GetItemCommand).resolves({ Item: makeItem("my-key", "hello") });
    expect(await kv.get("my-key")).toBe("hello");
  });

  it("returns null for expired item (TTL in the past)", async () => {
    const pastTtl = FROZEN_EPOCH_S - 10;
    mock.on(GetItemCommand).resolves({ Item: makeItem("expired-key", "val", { ttl: pastTtl }) });
    expect(await kv.get("expired-key")).toBeNull();
  });

  it("returns value for item whose TTL is in the future", async () => {
    const futureTtl = FROZEN_EPOCH_S + 3600;
    mock.on(GetItemCommand).resolves({ Item: makeItem("live-key", "val", { ttl: futureTtl }) });
    expect(await kv.get("live-key")).toBe("val");
  });

  it("parses JSON when type='json'", async () => {
    mock.on(GetItemCommand).resolves({
      Item: makeItem("json-key", JSON.stringify({ x: 1 })),
    });
    const result = await kv.get("json-key", "json");
    expect(result).toEqual({ x: 1 } as unknown as string);
  });

  it("get<T>(key, 'json') returns the caller-pinned type (no unknown cast required)", async () => {
    interface Prefs {
      theme: "light" | "dark";
      density: number;
    }
    mock.on(GetItemCommand).resolves({
      Item: makeItem("prefs", JSON.stringify({ theme: "dark", density: 2 })),
    });
    const prefs = await kv.get<Prefs>("prefs", "json");
    // The generic overload returns Promise<Prefs | null>, so prefs?.theme
    // typechecks without a cast — the regression the trellis 1.A.3 cutover
    // would hit if this overload stops working.
    expect(prefs?.theme).toBe("dark");
    expect(prefs?.density).toBe(2);
  });

  it("returns null for malformed JSON when type='json'", async () => {
    mock.on(GetItemCommand).resolves({ Item: makeItem("bad-json", "not-json{") });
    expect(await kv.get("bad-json", "json")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getWithMetadata
// ---------------------------------------------------------------------------

describe("DynamoKv.getWithMetadata", () => {
  let mock: AwsClientStub<DynamoDBClient>;
  let kv: DynamoKv;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
    mock = mockClient(DynamoDBClient);
    kv = makeKv();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns { value: null, metadata: null } on miss", async () => {
    mock.on(GetItemCommand).resolves({ Item: undefined });
    const result = await kv.getWithMetadata("missing");
    expect(result).toEqual({ value: null, metadata: null });
  });

  it("returns value and metadata when present", async () => {
    const meta = JSON.stringify({ role: "admin" });
    mock.on(GetItemCommand).resolves({
      Item: makeItem("k", "v", { metadata: meta }),
    });
    const result = await kv.getWithMetadata<{ role: string }>("k");
    expect(result.value).toBe("v");
    expect(result.metadata).toEqual({ role: "admin" });
  });

  it("returns null metadata when field absent", async () => {
    mock.on(GetItemCommand).resolves({ Item: makeItem("k", "v") });
    const result = await kv.getWithMetadata("k");
    expect(result.metadata).toBeNull();
  });

  it("returns { value: null, metadata: null } for expired item", async () => {
    const pastTtl = FROZEN_EPOCH_S - 1;
    mock.on(GetItemCommand).resolves({
      Item: makeItem("k", "v", { ttl: pastTtl }),
    });
    const result = await kv.getWithMetadata("k");
    expect(result).toEqual({ value: null, metadata: null });
  });
});

// ---------------------------------------------------------------------------
// put
// ---------------------------------------------------------------------------

describe("DynamoKv.put", () => {
  let mock: AwsClientStub<DynamoDBClient>;
  let kv: DynamoKv;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
    mock = mockClient(DynamoDBClient);
    kv = makeKv();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("puts a string value without options", async () => {
    mock.on(PutItemCommand).resolves({});
    await expect(kv.put("k", "v")).resolves.toBeUndefined();
    const calls = mock.commandCalls(PutItemCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    const item = input.Item!;
    // pk should be namespace:key
    expect(item["pk"]).toEqual({ S: `${NS}:k` });
    expect(item["sk"]).toEqual({ S: "v" });
    expect(item["value"]).toEqual({ S: "v" });
    // no ttl
    expect(item["ttl"]).toBeUndefined();
  });

  it("sets absolute TTL from expiration option", async () => {
    mock.on(PutItemCommand).resolves({});
    const expiration = FROZEN_EPOCH_S + 3600;
    await kv.put("k", "v", { expiration });
    const input = mock.commandCalls(PutItemCommand)[0]!.args[0].input;
    expect(input.Item!["ttl"]).toEqual({ N: String(expiration) });
  });

  it("sets relative TTL from expirationTtl option", async () => {
    mock.on(PutItemCommand).resolves({});
    await kv.put("k", "v", { expirationTtl: 60 });
    const input = mock.commandCalls(PutItemCommand)[0]!.args[0].input;
    const expectedTtl = FROZEN_EPOCH_S + 60;
    expect(input.Item!["ttl"]).toEqual({ N: String(expectedTtl) });
  });

  it("stores metadata as JSON string", async () => {
    mock.on(PutItemCommand).resolves({});
    await kv.put("k", "v", { metadata: { foo: "bar" } });
    const input = mock.commandCalls(PutItemCommand)[0]!.args[0].input;
    expect(input.Item!["metadata"]).toEqual({ S: JSON.stringify({ foo: "bar" }) });
  });

  it("converts ArrayBuffer to utf-8 string", async () => {
    mock.on(PutItemCommand).resolves({});
    // Use TextEncoder to produce a clean ArrayBuffer (exact 5 bytes, no pool padding).
    // Buffer.from("hello").buffer returns the Node.js internal pool (8192 bytes), not
    // a 5-byte buffer — it is not a valid test input for an ArrayBuffer API.
    const buf = new TextEncoder().encode("hello").buffer;
    await kv.put("k", buf);
    const input = mock.commandCalls(PutItemCommand)[0]!.args[0].input;
    expect(input.Item!["value"]).toEqual({ S: "hello" });
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("DynamoKv.delete", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends DeleteItemCommand with correct key", async () => {
    const mock = mockClient(DynamoDBClient);
    mock.on(DeleteItemCommand).resolves({});
    const kv = makeKv();
    await kv.delete("my-key");
    const calls = mock.commandCalls(DeleteItemCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.Key!["pk"]).toEqual({ S: `${NS}:my-key` });
    expect(input.Key!["sk"]).toEqual({ S: "v" });
  });
});

// ---------------------------------------------------------------------------
// list — pagination
// ---------------------------------------------------------------------------

describe("DynamoKv.list", () => {
  let mock: AwsClientStub<DynamoDBClient>;
  let kv: DynamoKv;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
    mock = mockClient(DynamoDBClient);
    kv = makeKv();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty list when no items", async () => {
    mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });
    const result = await kv.list();
    expect(result.keys).toHaveLength(0);
    expect(result.list_complete).toBe(true);
    expect(result.cursor).toBeUndefined();
  });

  it("returns keys with names stripped of namespace prefix", async () => {
    mock.on(QueryCommand).resolves({
      Items: [makeItem("key-a", "v"), makeItem("key-b", "v")],
      LastEvaluatedKey: undefined,
    });
    const result = await kv.list();
    const names = result.keys.map((k) => k.name);
    expect(names).toContain("key-a");
    expect(names).toContain("key-b");
  });

  it("filters expired items from list results", async () => {
    const pastTtl = FROZEN_EPOCH_S - 10;
    const futureTtl = FROZEN_EPOCH_S + 3600;
    mock.on(QueryCommand).resolves({
      Items: [
        makeItem("live", "v", { ttl: futureTtl }),
        makeItem("expired", "v", { ttl: pastTtl }),
      ],
      LastEvaluatedKey: undefined,
    });
    const result = await kv.list();
    expect(result.keys.map((k) => k.name)).toEqual(["live"]);
  });

  it("returns cursor when LastEvaluatedKey is set", async () => {
    const lek = marshall({ pk: `${NS}:last-key`, sk: "v" });
    mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: lek });
    const result = await kv.list();
    expect(result.list_complete).toBe(false);
    expect(result.cursor).toBeDefined();
  });

  it("passes cursor back as ExclusiveStartKey on next page", async () => {
    // First page returns a cursor
    const lek = marshall({ pk: `${NS}:last-key`, sk: "v" });
    mock
      .on(QueryCommand)
      .resolvesOnce({ Items: [], LastEvaluatedKey: lek })
      .resolvesOnce({ Items: [], LastEvaluatedKey: undefined });

    const page1 = await kv.list();
    expect(page1.cursor).toBeDefined();

    const page2 = await kv.list({ cursor: page1.cursor });
    expect(page2.list_complete).toBe(true);
    // Second QueryCommand should have ExclusiveStartKey set
    const secondCall = mock.commandCalls(QueryCommand)[1]!;
    expect(secondCall.args[0].input.ExclusiveStartKey).toBeDefined();
  });

  it("treats invalid cursor as no cursor (restart from beginning)", async () => {
    mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });
    const result = await kv.list({ cursor: "INVALID_CURSOR_!!!!" });
    // Should succeed (no throw) and ExclusiveStartKey should be undefined
    const call = mock.commandCalls(QueryCommand)[0]!;
    expect(call.args[0].input.ExclusiveStartKey).toBeUndefined();
    expect(result.list_complete).toBe(true);
  });

  it("forwards prefix in list options", async () => {
    mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });
    await kv.list({ prefix: "user:" });
    const call = mock.commandCalls(QueryCommand)[0]!;
    const exprValues = call.args[0].input.ExpressionAttributeValues!;
    // The prefix passed to Dynamo should be namespace:user:
    expect(exprValues[":prefix"]).toEqual({ S: `${NS}:user:` });
  });
});

// ---------------------------------------------------------------------------
// list — cursor signing
// ---------------------------------------------------------------------------

describe("DynamoKv.list cursor signing", () => {
  let mock: AwsClientStub<DynamoDBClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
    mock = mockClient(DynamoDBClient);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("signs cursor when cursorSecret is set", async () => {
    const lek = marshall({ pk: `${NS}:a`, sk: "v" });
    mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: lek });

    const kv = new DynamoKv(new DynamoDBClient({}), {
      tableName: TABLE,
      namespace: NS,
      cursorSecret: "super-secret",
    });
    const result = await kv.list();
    // Signed cursor should contain a dot separator
    expect(result.cursor).toContain(".");
  });

  it("rejects tampered signed cursor (safe-fail: restart from beginning)", async () => {
    mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });

    const kv = new DynamoKv(new DynamoDBClient({}), {
      tableName: TABLE,
      namespace: NS,
      cursorSecret: "super-secret",
    });

    // Tampered: valid base64 but wrong signature
    const fakePayload = Buffer.from(JSON.stringify({ pk: "evil", sk: "v" })).toString("base64");
    const tamperedCursor = `${fakePayload}.deadbeef`;

    const result = await kv.list({ cursor: tamperedCursor });
    // Should not throw; ExclusiveStartKey should be absent (restart)
    const call = mock.commandCalls(QueryCommand)[0]!;
    expect(call.args[0].input.ExclusiveStartKey).toBeUndefined();
    expect(result.list_complete).toBe(true);
  });
});
