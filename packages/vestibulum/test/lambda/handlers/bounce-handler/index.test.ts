/**
 * Bounce handler — 01-evidence #15 / U9.
 *
 * The topic is fed by an SES *configuration-set event destination*, whose JSON
 * uses `eventType`; identity-level notifications use `notificationType`. The
 * handler must act on both — reading only `notificationType` would leave every
 * wired event "unknown" and silently ignored (the bounce circuit breaker would
 * look deployed and do nothing).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

import {
  createBounceHandler,
  type SnsEvent,
} from "../../../../src/lambda/handlers/bounce-handler/index.js";
import { hmacEmail } from "../../../../src/lambda/shared/email-hmac.js";
import { RuntimeEnv } from "../../../../src/lambda/shared/runtime-env.js";
import { TTL_ATTRIBUTE } from "../../../../src/lambda/shared/signin.js";

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const ddbMock = mockClient(DynamoDBClient);

const KEY = "test-hmac-key-not-a-secret";
const EMAIL = "bounced@example.com";

const handler = () =>
  createBounceHandler({
    cognitoClient: cognitoMock as unknown as CognitoIdentityProviderClient,
    dynamoClient: ddbMock as unknown as DynamoDBClient,
    resolveHmacKey: () => Promise.resolve(KEY),
  });

const sns = (message: unknown): SnsEvent => ({
  Records: [{ EventSource: "aws:sns", Sns: { Message: JSON.stringify(message) } }],
});

const bounce = (shape: "eventType" | "notificationType", bounceType = "Permanent") => ({
  [shape]: "Bounce",
  mail: { destination: [EMAIL] },
  bounce: { bounceType, bouncedRecipients: [{ emailAddress: EMAIL }] },
});

const complaint = (shape: "eventType" | "notificationType") => ({
  [shape]: "Complaint",
  mail: { destination: [EMAIL] },
  complaint: { complainedRecipients: [{ emailAddress: EMAIL }] },
});

beforeEach(() => {
  cognitoMock.reset();
  ddbMock.reset();
  cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});
  ddbMock.on(PutItemCommand).resolves({});
  process.env[RuntimeEnv.COGNITO_USER_POOL_ID] = "eu-central-1_POOL";
  process.env[RuntimeEnv.DENYLIST_TABLE_NAME] = "denylist";
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

const quarantines = () => cognitoMock.commandCalls(AdminUpdateUserAttributesCommand);

describe.each(["eventType", "notificationType"] as const)(
  "SES JSON shape: %s",
  (shape) => {
    it("a permanent bounce quarantines the user (custom:email_quarantined=true)", async () => {
      await handler()(sns(bounce(shape)));
      expect(quarantines()).toHaveLength(1);
      expect(quarantines()[0]!.args[0].input).toMatchObject({
        UserPoolId: "eu-central-1_POOL",
        UserAttributes: [{ Name: "custom:email_quarantined", Value: "true" }],
      });
    });

    it("a complaint quarantines the user", async () => {
      await handler()(sns(complaint(shape)));
      expect(quarantines()).toHaveLength(1);
    });

    it("a transient bounce does not", async () => {
      await handler()(sns(bounce(shape, "Transient")));
      expect(quarantines()).toHaveLength(0);
    });
  },
);

describe("events that are not bounces or complaints", () => {
  it.each(["Delivery", "Send", "Open"])("%s is ignored without error", async (type) => {
    await expect(
      handler()(sns({ eventType: type, mail: { destination: [EMAIL] } })),
    ).resolves.toBeUndefined();
    expect(quarantines()).toHaveLength(0);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it("a message with neither field is ignored without error", async () => {
    await expect(handler()(sns({ mail: { destination: [EMAIL] } }))).resolves.toBeUndefined();
    expect(quarantines()).toHaveLength(0);
  });
});

describe("a bounce for an address with no Cognito user", () => {
  beforeEach(() => {
    cognitoMock
      .on(AdminUpdateUserAttributesCommand)
      .rejects(new UserNotFoundException({ message: "nope", $metadata: {} }));
  });

  it("writes a denylist row keyed by the keyed HMAC of the address", async () => {
    await handler()(sns(bounce("eventType")));
    const put = ddbMock.commandCalls(PutItemCommand)[0]!.args[0].input;
    expect(put.TableName).toBe("denylist");
    expect(put.Item?.["email_hmac"]).toEqual({ S: hmacEmail(EMAIL, KEY) });
  });

  it("writes the expiry under the attribute the table's TTL names (expires_at), not `ttl`", async () => {
    const NOW_MS = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    try {
      await handler()(sns(bounce("eventType")));
    } finally {
      vi.useRealTimers();
    }
    const item = ddbMock.commandCalls(PutItemCommand)[0]!.args[0].input.Item!;
    expect(item).toHaveProperty(TTL_ATTRIBUTE);
    expect(item).not.toHaveProperty("ttl");
    // 365 days after the (frozen) bounce.
    expect(item[TTL_ATTRIBUTE]).toEqual({ N: String(NOW_MS / 1000 + 365 * 24 * 3600) });
  });

  it("never writes the raw address into the denylist", async () => {
    await handler()(sns(bounce("eventType")));
    expect(JSON.stringify(ddbMock.commandCalls(PutItemCommand)[0]!.args[0].input)).not.toContain(EMAIL);
  });
});

describe("failures", () => {
  it("a Cognito error other than not-found fails the batch so SNS retries it", async () => {
    cognitoMock.on(AdminUpdateUserAttributesCommand).rejects(new Error("throttled"));
    await expect(handler()(sns(bounce("eventType")))).rejects.toThrow(/one or more records failed/);
  });

  it("refuses to run with a missing pool id", async () => {
    Reflect.deleteProperty(process.env, RuntimeEnv.COGNITO_USER_POOL_ID);
    await expect(handler()(sns(bounce("eventType")))).rejects.toThrow(/missing required env vars/);
  });
});

describe("signin_secrets_never_logged", () => {
  it("a malformed SNS message is logged by error NAME only (the parse error would quote the body)", async () => {
    const errors: string[] = [];
    vi.mocked(console.error).mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
    const bad = { Records: [{ EventSource: "aws:sns", Sns: { Message: `{"mail": {"destination": ["${EMAIL}"]` } }] };
    await expect(handler()(bad)).rejects.toThrow();
    expect(errors.join("\n")).toContain("SyntaxError");
    expect(errors.join("\n")).not.toContain(EMAIL);
    expect(errors.join("\n")).not.toContain("destination");
  });

  it("logs at most a 16-hex prefix of the address hash", async () => {
    const infos: string[] = [];
    vi.mocked(console.info).mockImplementation((...a: unknown[]) => void infos.push(a.join(" ")));
    await handler()(sns(bounce("eventType")));
    const text = infos.join("\n");
    expect(text).not.toContain(EMAIL);
    expect(text).not.toMatch(/[0-9a-f]{17,}/);
    expect(text).toMatch(/hash=[0-9a-f]{16}/);
  });
});
