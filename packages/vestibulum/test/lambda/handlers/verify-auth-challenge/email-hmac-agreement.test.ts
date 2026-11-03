/**
 * Cross-side regression test: the `email_hmac` CreateAuthChallenge WRITES into
 * the token row must equal what VerifyAuthChallengeResponse RECOMPUTES for the
 * same email + key, so a legitimately-issued magic link actually verifies.
 *
 * This is the create↔verify half of the keyed-HMAC fix. The original bug keyed
 * the HMAC on the Secrets Manager **ARN** rather than the resolved secret VALUE;
 * once both sides resolve the real value (cached per warm container) and run it
 * through the one canonical `hmacEmail`, the per-row email cross-check in verify
 * must pass for the issuing address and fail for any other. There was no test
 * tying the two handlers together — exactly where the bug hid.
 *
 * Determinism: clock and token bytes are injected; the HMAC key is injected via
 * `resolveHmacKey` so no Secrets Manager round-trip happens; all AWS calls are
 * mocked at the SDK boundary.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { createHash } from "crypto";
import {
  type AttributeValue,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { SESClient } from "@aws-sdk/client-ses";

import {
  createCreateAuthChallengeHandler,
  type CreateAuthChallengeEvent,
} from "../../../../src/lambda/handlers/create-auth-challenge/index.js";
import {
  createVerifyAuthChallengeResponseHandler,
  type VerifyAuthChallengeEvent,
} from "../../../../src/lambda/handlers/verify-auth-challenge/index.js";
import { RuntimeEnv } from "../../../../src/lambda/shared/runtime-env.js";
import { FakeAllowList } from "../../fakes/fake-allow-list.js";

const ddbMock = mockClient(DynamoDBClient);
const sesMock = mockClient(SESClient);

const KEY = "the-shared-pepper";
const EMAIL = "User@Example.COM"; // mixed-case on purpose — hmacEmail lowercases
const TOKEN_BYTES = Buffer.alloc(32, 7); // deterministic 32-byte token
const NOW_MS = 1_700_000_000_000;
/** Everyone used below is an enabled, verified pool user (the default admin-only allow-list). */
const allowList = new FakeAllowList()
  .add("User@Example.COM", "user@example.com")
  .add("victim@example.com", "victim@example.com")
  .add("attacker@example.com", "attacker@example.com");

/** The base64url token the create-side derives from TOKEN_BYTES. */
const TOKEN = TOKEN_BYTES.toString("base64url");
/** sha256(token) — the token-row PK and the verify-side submitted hash. */
const SUBMITTED_HASH = createHash("sha256").update(TOKEN).digest("hex");

function setCreateEnv(): void {
  process.env[RuntimeEnv.TOKEN_TABLE_NAME] = "Tokens";
  process.env[RuntimeEnv.RATE_LIMIT_TABLE_NAME] = "RateLimit";
  process.env[RuntimeEnv.SES_FROM] = "noreply@example.com";
  process.env[RuntimeEnv.DOMAIN] = "app.example.com";
  // The denylist must be configured: an unset table fails closed (I15).
  process.env[RuntimeEnv.DENYLIST_TABLE_NAME] = "Denylist";
}

function clearCreateEnv(): void {
  delete process.env["VESTIBULUM_TOKEN_TABLE"];
  delete process.env["VESTIBULUM_RATE_LIMIT_TABLE"];
  delete process.env["VESTIBULUM_SES_FROM"];
  delete process.env["VESTIBULUM_DOMAIN"];
  delete process.env["VESTIBULUM_DENYLIST_TABLE"];
}

function createEvent(email: string): CreateAuthChallengeEvent {
  return {
    userPoolId: "eu-central-1_test",
    userName: email,
    request: { userAttributes: { email } },
    response: {},
  };
}

/** Pull the `email_hmac` the create-side wrote to the token table. */
function writtenEmailHmac(): string | undefined {
  const call = ddbMock.commandCalls(PutItemCommand)[0];
  const input = call?.args[0].input as { Item?: { email_hmac?: { S?: string } } };
  return input.Item?.email_hmac?.S;
}

/**
 * The whole item Create wrote, replayed verbatim into Verify's lookup. Replaying
 * the real item (not a hand-built one) is what makes this an AGREEMENT test: if
 * Create and Verify disagreed on an attribute name — as they did for the expiry
 * (`ttl` written, `expires_at` read) — it fails here.
 */
function writtenItem(): Record<string, AttributeValue> {
  const call = ddbMock.commandCalls(PutItemCommand)[0];
  const input = call?.args[0].input as { Item?: Record<string, AttributeValue> };
  return input.Item ?? {};
}

describe("create→verify email_hmac agreement", () => {
  beforeEach(() => {
    ddbMock.reset();
    sesMock.reset();
    setCreateEnv();
    // Rate-limit UpdateItem, token PutItem, and (verify) Get/Delete all succeed.
    ddbMock.resolves({});
    sesMock.resolves({});
  });

  afterEach(() => {
    clearCreateEnv();
    delete process.env["VESTIBULUM_TOKEN_TABLE"];
  });

  it("writes an email_hmac that the verifier recomputes and accepts (same key)", async () => {
    const create = createCreateAuthChallengeHandler({
      dynamodb: ddbMock as unknown as DynamoDBClient,
      ses: sesMock as unknown as SESClient,
      nowMs: () => NOW_MS,
      sleep: () => Promise.resolve(), // hold no real response floor in tests
      randomToken: () => TOKEN_BYTES,
      resolveHmacKey: () => Promise.resolve(KEY),
      allowList,
    });

    const issued = await create(createEvent(EMAIL));
    expect(issued.response.privateChallengeParameters?.token_hash).toBe(SUBMITTED_HASH);

    const storedEmailHmac = writtenEmailHmac();
    expect(storedEmailHmac).toBeDefined();
    expect(storedEmailHmac).toMatch(/^[0-9a-f]{64}$/);

    // Replay the issued token row into the verify-side lookup.
    ddbMock.on(GetItemCommand).resolves({
      Item: writtenItem(),
    });
    ddbMock.on(DeleteItemCommand).resolves({});

    const verify = createVerifyAuthChallengeResponseHandler({
      dynamodb: ddbMock as unknown as DynamoDBClient,
      // Same key the create-side used — the crux of the fix.
      resolveHmacKey: () => Promise.resolve(KEY),
      // Verify now enforces expiry, so it must share the clock Create used.
      nowMs: () => NOW_MS,
      allowList,
    });

    const verifyEvent: VerifyAuthChallengeEvent = {
      userPoolId: "eu-central-1_test",
      userName: EMAIL,
      request: {
        userAttributes: { email: EMAIL },
        privateChallengeParameters: {
          email: EMAIL,
          token_hash: SUBMITTED_HASH,
          quarantined: "false",
        },
        challengeAnswer: TOKEN,
        session: [],
      },
      response: {},
    };

    const result = await verify(verifyEvent);
    expect(result.response.answerCorrect).toBe(true);
  });

  it("rejects when the token row was issued for a DIFFERENT email (cross-check bites)", async () => {
    const create = createCreateAuthChallengeHandler({
      dynamodb: ddbMock as unknown as DynamoDBClient,
      ses: sesMock as unknown as SESClient,
      nowMs: () => NOW_MS,
      sleep: () => Promise.resolve(), // hold no real response floor in tests
      randomToken: () => TOKEN_BYTES,
      resolveHmacKey: () => Promise.resolve(KEY),
      allowList,
    });

    // Issue for victim@example.com ...
    await create(createEvent("victim@example.com"));
    const storedEmailHmac = writtenEmailHmac();
    expect(storedEmailHmac).toBeDefined();

    ddbMock.on(GetItemCommand).resolves({
      Item: writtenItem(),
    });
    ddbMock.on(DeleteItemCommand).resolves({});

    const verify = createVerifyAuthChallengeResponseHandler({
      // Verify enforces expiry, so it must share the clock Create used;
      // otherwise every case below would fail as "expired", masking its real reason.
      nowMs: () => NOW_MS,
      dynamodb: ddbMock as unknown as DynamoDBClient,
      resolveHmacKey: () => Promise.resolve(KEY),
      allowList,
    });

    // ... but redeem claiming attacker@example.com.
    const verifyEvent: VerifyAuthChallengeEvent = {
      userPoolId: "eu-central-1_test",
      userName: "attacker@example.com",
      request: {
        userAttributes: { email: "attacker@example.com" },
        privateChallengeParameters: {
          email: "attacker@example.com",
          token_hash: SUBMITTED_HASH,
          quarantined: "false",
        },
        challengeAnswer: TOKEN,
        session: [],
      },
      response: {},
    };

    const result = await verify(verifyEvent);
    expect(result.response.answerCorrect).toBe(false);
  });

  it("rejects when verify resolves a DIFFERENT key than create used", async () => {
    const create = createCreateAuthChallengeHandler({
      dynamodb: ddbMock as unknown as DynamoDBClient,
      ses: sesMock as unknown as SESClient,
      nowMs: () => NOW_MS,
      sleep: () => Promise.resolve(), // hold no real response floor in tests
      randomToken: () => TOKEN_BYTES,
      resolveHmacKey: () => Promise.resolve(KEY),
      allowList,
    });

    await create(createEvent(EMAIL));

    ddbMock.on(GetItemCommand).resolves({
      Item: writtenItem(),
    });
    ddbMock.on(DeleteItemCommand).resolves({});

    const verify = createVerifyAuthChallengeResponseHandler({
      // Verify enforces expiry, so it must share the clock Create used;
      // otherwise every case below would fail as "expired", masking its real reason.
      nowMs: () => NOW_MS,
      dynamodb: ddbMock as unknown as DynamoDBClient,
      // Wrong key — this is precisely what the ARN-vs-value bug caused: the two
      // sides keying on different material, so verification could never agree.
      resolveHmacKey: () => Promise.resolve("a-different-pepper"),
      allowList,
    });

    const verifyEvent: VerifyAuthChallengeEvent = {
      userPoolId: "eu-central-1_test",
      userName: EMAIL,
      request: {
        userAttributes: { email: EMAIL },
        privateChallengeParameters: {
          email: EMAIL,
          token_hash: SUBMITTED_HASH,
          quarantined: "false",
        },
        challengeAnswer: TOKEN,
        session: [],
      },
      response: {},
    };

    const result = await verify(verifyEvent);
    expect(result.response.answerCorrect).toBe(false);
  });
});
