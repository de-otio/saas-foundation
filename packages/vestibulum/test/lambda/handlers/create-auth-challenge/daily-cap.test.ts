/**
 * The per-address daily cap (dot-notes doc/topics/passwordless-sign-in-aws/02-spec.md,
 * `signin_attempts_bounded`: at most 20 challenges per address per UTC day,
 * enforced in Create — `signin_caps_enforced_in_trigger`).
 *
 * The counter is a conditional UpdateItem; a small stateful fake reproduces its
 * semantics, so the 20/21 boundary and the UTC-midnight reset are observed on
 * state, with a pinned clock.
 */

import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SENDS_PER_DAY,
  tryConsumeDailyCap,
  utcDate,
} from "../../../../src/lambda/handlers/create-auth-challenge/daily-cap.js";

const ddb = mockClient(DynamoDBClient);
const KEY = "test-hmac-key-not-a-secret";
const ADDRESS = "person@example.com";
const DAY_MS = 86_400_000;
/** 2023-11-14T22:13:20Z */
const T0 = 1_700_000_000_000;
const MIDNIGHT = Math.floor(T0 / DAY_MS) * DAY_MS + DAY_MS; // 2023-11-15T00:00:00Z

/** The counter table: bucket id -> count, with the real condition's semantics. */
let counts: Map<string, number>;
let expiries: Map<string, number>;

function install() {
  ddb.reset();
  counts = new Map();
  expiries = new Map();
  ddb.on(UpdateItemCommand).callsFake((input: {
    Key: { bucket_id: { S: string } };
    ExpressionAttributeValues: Record<string, { N: string }>;
  }) => {
    const id = input.Key.bucket_id.S;
    const limit = Number(input.ExpressionAttributeValues[":limit"]!.N);
    const n = counts.get(id);
    if (n !== undefined && n >= limit) {
      throw new ConditionalCheckFailedException({ message: "over", $metadata: {} });
    }
    counts.set(id, (n ?? 0) + 1);
    expiries.set(id, Number(input.ExpressionAttributeValues[":ttl"]!.N));
    return {};
  });
}

const consume = (nowMs: number, address = ADDRESS, limit = DEFAULT_SENDS_PER_DAY, key = KEY) =>
  tryConsumeDailyCap({
    client: ddb as unknown as DynamoDBClient,
    tableName: "rate",
    address,
    hmacKey: key,
    limit,
    nowMs,
  });

beforeEach(install);

describe("the cap", () => {
  it("defaults to 20", () => {
    expect(DEFAULT_SENDS_PER_DAY).toBe(20);
  });

  it("the 20th challenge of a UTC day is allowed and the 21st is not (boundary)", async () => {
    for (let i = 1; i <= 20; i++) expect(await consume(T0), `challenge ${i}`).toBe(true);
    expect(await consume(T0)).toBe(false);
    expect(await consume(T0)).toBe(false);
    expect([...counts.values()]).toEqual([20]); // sorted-ok: one row. A refused request does not step the counter
  });

  it("P: for any limit n, exactly n challenges pass and every later one is refused", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 30 }), async (n) => {
        install();
        const results: boolean[] = [];
        for (let i = 0; i < n + 3; i++) results.push(await consume(T0, ADDRESS, n));
        expect(results.filter(Boolean)).toHaveLength(n);
        expect(results.slice(0, n).every(Boolean)).toBe(true);
      }),
      { numRuns: 40 },
    );
  });

  it("another address has its own counter", async () => {
    for (let i = 0; i < 20; i++) await consume(T0);
    expect(await consume(T0)).toBe(false);
    expect(await consume(T0, "other@example.com")).toBe(true);
  });

  it("the address is case-insensitive (the normalised form is what is counted)", async () => {
    for (let i = 0; i < 20; i++) await consume(T0, "Person@Example.COM");
    expect(await consume(T0, ADDRESS)).toBe(false);
  });
});

describe("the UTC day", () => {
  it("utcDate is the UTC calendar date", () => {
    expect(utcDate(T0)).toBe("2023-11-14");
    expect(utcDate(MIDNIGHT - 1)).toBe("2023-11-14");
    expect(utcDate(MIDNIGHT)).toBe("2023-11-15");
  });

  it("the counter resets at UTC midnight: 23:59:59.999 is still yesterday's, 00:00:00.000 starts a new count", async () => {
    for (let i = 0; i < 20; i++) expect(await consume(MIDNIGHT - 1)).toBe(true);
    expect(await consume(MIDNIGHT - 1)).toBe(false); // the 21st, one millisecond before midnight
    expect(await consume(MIDNIGHT)).toBe(true); // a new UTC day
    for (let i = 1; i < 20; i++) expect(await consume(MIDNIGHT)).toBe(true);
    expect(await consume(MIDNIGHT)).toBe(false); // and it is capped again
  });

  it("uses two distinct rows across midnight", async () => {
    await consume(MIDNIGHT - 1);
    await consume(MIDNIGHT);
    expect(counts.size).toBe(2);
  });

  it("the row expires after the end of ITS UTC day (one hour of slack), never before", async () => {
    for (const now of [T0, MIDNIGHT - 1, MIDNIGHT, MIDNIGHT + DAY_MS - 1]) {
      install();
      await consume(now);
      const endOfDayS = (Math.floor(now / DAY_MS) * DAY_MS + DAY_MS) / 1000;
      expect([...expiries.values()]).toEqual([endOfDayS + 3600]); // sorted-ok: one row
    }
  });
});

describe("the bucket id", () => {
  const idOf = async (nowMs: number, address = ADDRESS, key = KEY) => {
    install();
    await consume(nowMs, address, DEFAULT_SENDS_PER_DAY, key);
    return [...counts.keys()][0]!;
  };

  it("is a secret-keyed hash: it contains no address, and another secret gives another id", async () => {
    const id = await idOf(T0);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toContain("person");
    expect(await idOf(T0, ADDRESS, "another-secret")).not.toBe(id);
  });

  it("is stable within a day and different across days and addresses", async () => {
    expect(await idOf(T0)).toBe(await idOf(T0 + 1000));
    expect(await idOf(T0)).not.toBe(await idOf(T0 + DAY_MS));
    expect(await idOf(T0)).not.toBe(await idOf(T0, "x@example.com"));
  });

  it("is not the id the window limiter uses for the same address", async () => {
    const { createHash } = await import("node:crypto");
    const windowId = createHash("sha256").update(`${ADDRESS}#${Math.floor(T0 / 900_000) * 900_000}`).digest("hex");
    expect(await idOf(T0)).not.toBe(windowId);
  });
});

describe("errors fail closed", () => {
  it("any error other than the failed condition propagates (the caller treats it as unanswerable)", async () => {
    ddb.on(UpdateItemCommand).rejects(new Error("throttled"));
    await expect(consume(T0)).rejects.toThrow("throttled");
  });

  it("sends the conditional write the cap relies on", async () => {
    await consume(T0);
    const input = ddb.commandCalls(UpdateItemCommand)[0]!.args[0].input;
    expect(input.ConditionExpression).toBe("attribute_not_exists(#c) OR #c < :limit");
    expect(input.ExpressionAttributeNames?.["#ttl"]).toBe("expires_at");
    expect(input.TableName).toBe("rate");
  });
});
