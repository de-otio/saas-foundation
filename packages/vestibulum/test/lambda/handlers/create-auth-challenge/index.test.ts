/**
 * Enumeration-hardening regression test for the CreateAuthChallenge handler.
 *
 * When the website app client has PreventUserExistenceErrors enabled, Cognito
 * invokes this trigger with a phantom user (no `email` attribute) for an
 * address that does not exist. The handler MUST NOT throw on that path —
 * throwing surfaces a 400 (UserLambdaValidationException) for unknown addresses
 * while real ones get a 200 + Session, turning the public InitiateAuth endpoint
 * into a user-existence oracle. Instead it returns a normal-looking challenge
 * that fails verification, and — critically — sends no mail.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { SESClient } from "@aws-sdk/client-ses";

import {
  createCreateAuthChallengeHandler,
  type CreateAuthChallengeEvent,
} from "../../../../src/lambda/handlers/create-auth-challenge/index.js";
import { RuntimeEnv } from "../../../../src/lambda/shared/runtime-env.js";
import { FakeAllowList } from "../../fakes/fake-allow-list.js";

const ddbMock = mockClient(DynamoDBClient);
const sesMock = mockClient(SESClient);

function phantomUserEvent(userName: string): CreateAuthChallengeEvent {
  return {
    userPoolId: "eu-central-1_test",
    userName,
    request: { userAttributes: {} }, // no `email` — the unknown-user shape
    response: {},
  };
}

describe("createCreateAuthChallengeHandler — unknown user (no email attribute)", () => {
  beforeEach(() => {
    process.env[RuntimeEnv.TOKEN_TABLE_NAME] = "tokens";
    process.env[RuntimeEnv.RATE_LIMIT_TABLE_NAME] = "ratelimit";
    process.env[RuntimeEnv.DENYLIST_TABLE_NAME] = "denylist";
    process.env[RuntimeEnv.SES_FROM] = "login@example.com";
    process.env[RuntimeEnv.DOMAIN] = "app.example.com";
    ddbMock.on(GetItemCommand).resolves({});
    ddbMock.on(UpdateItemCommand).resolves({});
  });

  afterEach(() => {
    ddbMock.reset();
    sesMock.reset();
  });

  function handlerUnderTest() {
    return createCreateAuthChallengeHandler({
      dynamodb: ddbMock as unknown as DynamoDBClient,
      ses: sesMock as unknown as SESClient,
      sleep: () => Promise.resolve(), // no real response floor in this test
      resolveHmacKey: () => Promise.resolve("test-hmac-key-not-a-secret"),
      allowList: new FakeAllowList(), // nobody is on it: the phantom is not found
    });
  }

  it("returns a fail-closed challenge instead of throwing (no 400 enumeration oracle)", async () => {
    const result = await handlerUnderTest()(phantomUserEvent("nobody@probe.example"));

    // Same shape as the denylist / rate-limit fail-closed paths: looks normal,
    // but the verifier rejects it (token_hash "denied").
    expect(result.response.challengeMetadata).toBe("MAGIC_LINK");
    expect(result.response.privateChallengeParameters).toMatchObject({
      quarantined: "true",
    });
    // ... with hashes of values nobody holds, in the real challenge's shape.
    expect(result.response.privateChallengeParameters?.["token_hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(result.response.privateChallengeParameters?.["code_hash"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sends no email and writes no token for an unknown address", async () => {
    await handlerUnderTest()(phantomUserEvent("nobody@probe.example"));

    // The privacy property: an attacker pumping InitiateAuth for arbitrary
    // addresses triggers zero SES sends and zero token-table writes.
    expect(sesMock.calls()).toHaveLength(0);
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
  });

  it("does the same reads as a real caller (denylist lookup + both counter writes), so it is not faster", async () => {
    // Previously this path returned before any DynamoDB call, which made unknown
    // addresses measurably faster than real ones (signin_request_indistinguishable).
    await handlerUnderTest()(phantomUserEvent("nobody@probe.example"));
    expect(ddbMock.calls().map((c) => c.args[0].constructor.name)).toEqual([
      "GetItemCommand",
      "UpdateItemCommand", // the 15-minute window counter
      "UpdateItemCommand", // the daily counter
    ]);
  });

  it("does not throw (the pre-fix behaviour was a thrown error → 400)", async () => {
    await expect(handlerUnderTest()(phantomUserEvent("nobody@probe.example"))).resolves.toBeDefined();
  });
});
