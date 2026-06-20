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

import { afterEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SESClient } from "@aws-sdk/client-ses";

import {
  createCreateAuthChallengeHandler,
  type CreateAuthChallengeEvent,
} from "../../../../src/lambda/handlers/create-auth-challenge/index.js";

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
  afterEach(() => {
    ddbMock.reset();
    sesMock.reset();
  });

  it("returns a fail-closed challenge instead of throwing (no 400 enumeration oracle)", async () => {
    const handler = createCreateAuthChallengeHandler({
      dynamodb: ddbMock as unknown as DynamoDBClient,
      ses: sesMock as unknown as SESClient,
      // Must never be consulted on this path — resolving the HMAC key would be
      // a Secrets Manager round-trip we deliberately skip for unknown users.
      resolveHmacKey: () => {
        throw new Error("resolveHmacKey must not be called for the unknown-user path");
      },
    });

    const event = phantomUserEvent("nobody@probe.example");
    const result = await handler(event);

    // Same shape as the denylist / rate-limit fail-closed paths: looks normal,
    // but the verifier rejects it (token_hash "denied").
    expect(result.response.challengeMetadata).toBe("MAGIC_LINK");
    expect(result.response.privateChallengeParameters).toMatchObject({
      token_hash: "denied",
      quarantined: "true",
    });
  });

  it("sends no email and writes no token for an unknown address", async () => {
    const handler = createCreateAuthChallengeHandler({
      dynamodb: ddbMock as unknown as DynamoDBClient,
      ses: sesMock as unknown as SESClient,
      resolveHmacKey: () => {
        throw new Error("must not be called");
      },
    });

    await handler(phantomUserEvent("nobody@probe.example"));

    // The whole point: an attacker pumping InitiateAuth for arbitrary addresses
    // triggers zero SES sends and zero token-table writes.
    expect(sesMock.calls()).toHaveLength(0);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it("does not throw (the pre-fix behaviour was a thrown error → 400)", async () => {
    const handler = createCreateAuthChallengeHandler({
      dynamodb: ddbMock as unknown as DynamoDBClient,
      ses: sesMock as unknown as SESClient,
      resolveHmacKey: () => {
        throw new Error("must not be called");
      },
    });

    await expect(handler(phantomUserEvent("nobody@probe.example"))).resolves.toBeDefined();
  });
});
