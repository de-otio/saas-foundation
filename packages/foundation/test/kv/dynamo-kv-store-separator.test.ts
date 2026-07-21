/**
 * Focused test for the F4 separator guard + its `allowSeparatorInKey` opt-out
 * (ws1-kv-port-plan §3.1/§3.3). Uses aws-sdk-client-mock at the SDK boundary.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { DynamoKvStore, type DynamoKvLayout } from "../../src/kv/dynamo-kv-store.js";

const ddbMock = mockClient(DynamoDBClient);

/** Frozen clock (epoch ms) injected into the store — no real Date global. */
const FROZEN_MS = 1_700_000_000_000;
const now = (): number => FROZEN_MS;

const baseLayout: Omit<DynamoKvLayout, "allowSeparatorInKey"> = {
  tableName: "t",
  pkPrefix: "costtrack",
  pkSeparator: ":",
  skName: "sk",
  skValue: "v",
  ttlAttr: "ttl",
  versionAttr: "_v",
  nativeNumberFields: ["units"],
};

beforeEach(() => {
  ddbMock.reset();
  ddbMock.onAnyCommand().resolves({});
});

describe("DynamoKvStore F4 separator guard", () => {
  it("rejects a colon key by default (user-controlled-key namespaces)", async () => {
    const store = new DynamoKvStore(new DynamoDBClient({}), baseLayout, { now });
    await expect(store.put("2026-07-18:openai", { units: 1 })).rejects.toBeInstanceOf(TypeError);
  });

  it("allowSeparatorInKey composes the byte-compat composite pk", async () => {
    const store = new DynamoKvStore(
      new DynamoDBClient({}),
      { ...baseLayout, allowSeparatorInKey: true },
      { now },
    );
    ddbMock.on(PutItemCommand).resolves({});
    await store.put("2026-07-18:openai", { units: 1 });
    const putCall = ddbMock.commandCalls(PutItemCommand)[0];
    const item = unmarshall(putCall!.args[0].input.Item!);
    // Byte-compat: pk === `costtrack:{date}:{service}` (the composite is preserved).
    expect(item.pk).toBe("costtrack:2026-07-18:openai");
    expect(item.sk).toBe("v");
  });
});
