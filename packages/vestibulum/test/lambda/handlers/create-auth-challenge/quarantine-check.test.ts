/**
 * Regression tests for the denylist read (quarantine-check) — proving it now
 * agrees with the bounce-handler write.
 *
 * The original bug: bounce-handler WROTE the denylist key as a keyed HMAC of the
 * raw (not lowercased) address, while quarantine-check READ it as a plain
 * unkeyed sha256 of the lowercased address. The two could never match, so a
 * bounced/complained address was never actually blocked. Both sides now funnel
 * through the one canonical `hmacEmail`.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { createHash } from "crypto";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";

import { isDenylisted } from "../../../../src/lambda/handlers/create-auth-challenge/quarantine-check.js";
// Both the bounce-handler WRITE and the quarantine-check READ funnel through
// this one canonical hmacEmail (shared module), so keys cannot drift.
import { hmacEmail as sharedHmac } from "../../../../src/lambda/shared/email-hmac.js";

const ddbMock = mockClient(DynamoDBClient);
const KEY = "the-shared-pepper";

function denylistKeyOfLastGet(): string | undefined {
  const call = ddbMock.commandCalls(GetItemCommand)[0];
  const input = call?.args[0].input as { Key?: { email_hmac?: { S?: string } } };
  return input.Key?.email_hmac?.S;
}

describe("isDenylisted (denylist read)", () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it("queries with the KEYED HMAC, not a plain unkeyed sha256 (the bug)", async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: { email_hmac: { S: "x" } } });
    const client = new DynamoDBClient({});

    await isDenylisted(client, "Denylist", "user@example.com", KEY);

    const queried = denylistKeyOfLastGet();
    expect(queried).toBe(sharedHmac("user@example.com", KEY));
    // The old, broken read value must NOT be what we query with.
    const oldUnkeyed = createHash("sha256").update("user@example.com").digest("hex");
    expect(queried).not.toBe(oldUnkeyed);
  });

  it("matches a bounce-handler write across mixed-case (lowercasing on both sides)", async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: { email_hmac: { S: "x" } } });
    const client = new DynamoDBClient({});

    // Read side gets a mixed-case address; write side stored the lowercased one.
    await isDenylisted(client, "Denylist", "User@Example.COM", KEY);

    const queried = denylistKeyOfLastGet();
    const written = sharedHmac("user@example.com", KEY);
    expect(queried).toBe(written);
  });

  it("treats a hit (Item present) as denylisted, a miss as allowed", async () => {
    const client = new DynamoDBClient({});

    ddbMock.on(GetItemCommand).resolves({ Item: { email_hmac: { S: "x" } } });
    expect(await isDenylisted(client, "Denylist", "a@b.com", KEY)).toBe(true);

    ddbMock.reset();
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    expect(await isDenylisted(client, "Denylist", "a@b.com", KEY)).toBe(false);
  });

  it("is disabled (no DDB call) when the table name is unset", async () => {
    const client = new DynamoDBClient({});
    expect(await isDenylisted(client, undefined, "a@b.com", KEY)).toBe(false);
    expect(await isDenylisted(client, "", "a@b.com", KEY)).toBe(false);
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(0);
  });
});
