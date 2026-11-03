/**
 * CreateAuthChallenge — the invariants it owns
 * (dot-notes doc/topics/passwordless-sign-in-aws/02-spec.md):
 *
 *   signin_link_expires_10min          expires_at is written, under the TTL attribute's name
 *   signin_request_indistinguishable   same reads for every caller; every path waits for the floor
 *   signin_mail_only_to_eligible       quarantined / denylisted / rate-limited / unknown send nothing
 *   (U9)                               a hard-bounced address (custom:email_quarantined) is not mailed
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

import {
  createCreateAuthChallengeHandler,
  type CreateAuthChallengeEvent,
} from "../../../../src/lambda/handlers/create-auth-challenge/index.js";
import { RuntimeEnv } from "../../../../src/lambda/shared/runtime-env.js";
import {
  DEFAULT_CREATE_FLOOR_MS,
  TTL_ATTRIBUTE,
} from "../../../../src/lambda/shared/signin.js";

const ddbMock = mockClient(DynamoDBClient);
const sesMock = mockClient(SESClient);

const NOW_MS = 1_700_000_000_000;
const EMAIL = "person@example.com";

function setEnv(overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    [RuntimeEnv.TOKEN_TABLE_NAME]: "tokens",
    [RuntimeEnv.RATE_LIMIT_TABLE_NAME]: "ratelimit",
    [RuntimeEnv.DENYLIST_TABLE_NAME]: "denylist",
    [RuntimeEnv.SES_FROM]: "login@example.com",
    [RuntimeEnv.DOMAIN]: "app.example.com",
    [RuntimeEnv.TOKEN_TTL_MINUTES]: undefined,
    [RuntimeEnv.CREATE_FLOOR_MS]: undefined,
    [RuntimeEnv.SES_CONFIGURATION_SET]: undefined,
    ...overrides,
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
}

function realEvent(attrs: Record<string, string> = {}): CreateAuthChallengeEvent {
  return {
    userPoolId: "eu-central-1_test",
    userName: "11111111-2222-3333-4444-555555555555",
    request: { userAttributes: { email: EMAIL, ...attrs } },
    response: {},
  };
}

function phantomEvent(): CreateAuthChallengeEvent {
  return {
    userPoolId: "eu-central-1_test",
    userName: "nobody-here",
    request: { userAttributes: {} },
    response: {},
  };
}

function sleeps() {
  const calls: number[] = [];
  return {
    calls,
    sleep: (ms: number) => {
      calls.push(ms);
      return Promise.resolve();
    },
  };
}

function build(sleep: (ms: number) => Promise<void>, extra: Record<string, unknown> = {}) {
  return createCreateAuthChallengeHandler({
    dynamodb: ddbMock as unknown as DynamoDBClient,
    ses: sesMock as unknown as SESClient,
    nowMs: () => NOW_MS,
    sleep,
    resolveHmacKey: () => Promise.resolve("test-hmac-key-not-a-secret"),
    randomToken: () => Buffer.alloc(32, 7),
    ...extra,
  });
}

/** Rate limiter: allowed (resolves) or over the limit (conditional check fails). */
function rateLimit(allowed: boolean) {
  if (allowed) {
    ddbMock.on(UpdateItemCommand).resolves({});
  } else {
    ddbMock.on(UpdateItemCommand).rejects(
      new ConditionalCheckFailedException({ message: "over", $metadata: {} }),
    );
  }
}

function denylist(hit: boolean) {
  ddbMock.on(GetItemCommand).resolves(hit ? { Item: { email_hmac: { S: "x" } } } : {});
}

const commandNames = () => ddbMock.calls().map((c) => c.args[0].constructor.name);

beforeEach(() => {
  ddbMock.reset();
  sesMock.reset();
  setEnv();
  ddbMock.on(PutItemCommand).resolves({});
  sesMock.on(SendEmailCommand).resolves({});
  denylist(false);
  rateLimit(true);
});

afterEach(() => setEnv());

describe("signin_link_expires_10min", () => {
  it("writes expires_at = now + 10 min by default, and no legacy `ttl` attribute", async () => {
    await build(sleeps().sleep)(realEvent());
    const put = ddbMock.commandCalls(PutItemCommand)[0]?.args[0].input;
    expect(put?.TableName).toBe("tokens");
    expect(put?.Item?.[TTL_ATTRIBUTE]).toEqual({ N: String(NOW_MS / 1000 + 600) });
    expect(put?.Item).not.toHaveProperty("ttl");
  });

  it("follows VESTIBULUM_TOKEN_TTL_MINUTES", async () => {
    setEnv({ [RuntimeEnv.TOKEN_TTL_MINUTES]: "5" });
    await build(sleeps().sleep)(realEvent());
    const put = ddbMock.commandCalls(PutItemCommand)[0]?.args[0].input;
    expect(put?.Item?.[TTL_ATTRIBUTE]).toEqual({ N: String(NOW_MS / 1000 + 300) });
  });

  it("states the real lifetime in the mail", async () => {
    setEnv({ [RuntimeEnv.TOKEN_TTL_MINUTES]: "7" });
    await build(sleeps().sleep)(realEvent());
    const body = sesMock.commandCalls(SendEmailCommand)[0]?.args[0].input.Message?.Body?.Text?.Data;
    expect(body).toContain("expires in 7 minutes");
  });

  it.each(["2", "16", "0", "-1", "abc", "10.5"])(
    "refuses to issue with an invalid lifetime (%s): no mail, no token",
    async (bad) => {
      setEnv({ [RuntimeEnv.TOKEN_TTL_MINUTES]: bad });
      await expect(build(sleeps().sleep)(realEvent())).rejects.toThrow();
      expect(sesMock.calls()).toHaveLength(0);
      expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    },
  );
});

describe("signin_request_indistinguishable (timing + parity)", () => {
  const classes: ReadonlyArray<{
    name: string;
    arrange: () => void;
    event: () => CreateAuthChallengeEvent;
    mails: boolean;
  }> = [
    { name: "eligible", arrange: () => undefined, event: () => realEvent(), mails: true },
    { name: "unknown (phantom)", arrange: () => undefined, event: phantomEvent, mails: false },
    { name: "denylisted", arrange: () => denylist(true), event: () => realEvent(), mails: false },
    { name: "rate limited", arrange: () => rateLimit(false), event: () => realEvent(), mails: false },
    {
      name: "quarantined by a hard bounce",
      arrange: () => undefined,
      event: () => realEvent({ "custom:email_quarantined": "true" }),
      mails: false,
    },
  ];

  it.each(classes)("$name: waits for the floor and reads before deciding", async (c) => {
    c.arrange();
    const s = sleeps();
    await build(s.sleep)(c.event());

    // With a frozen clock no time has elapsed, so the handler must sleep the whole floor.
    expect(s.calls).toEqual([DEFAULT_CREATE_FLOOR_MS]);

    // Every caller — the phantom included — does the denylist read and the counter write.
    expect(commandNames().slice(0, 2)).toEqual(["GetItemCommand", "UpdateItemCommand"]);

    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(c.mails ? 1 : 0);
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(c.mails ? 1 : 0);
  });

  it("a thrown error still waits for the floor", async () => {
    sesMock.on(SendEmailCommand).rejects(new Error("ses down"));
    const s = sleeps();
    await expect(build(s.sleep)(realEvent())).rejects.toThrow("ses down");
    expect(s.calls).toEqual([DEFAULT_CREATE_FLOOR_MS]);
  });

  it("sleeps only the remainder when the work already took some of the floor", async () => {
    let t = NOW_MS;
    const s = sleeps();
    const handler = createCreateAuthChallengeHandler({
      dynamodb: ddbMock as unknown as DynamoDBClient,
      ses: sesMock as unknown as SESClient,
      // Each clock read advances 100 ms.
      nowMs: () => (t += 100),
      sleep: s.sleep,
      resolveHmacKey: () => Promise.resolve("k"),
      randomToken: () => Buffer.alloc(32, 7),
    });
    await handler(phantomEvent());
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toBeLessThan(DEFAULT_CREATE_FLOOR_MS);
    expect(s.calls[0]).toBeGreaterThan(0);
  });

  it("honours VESTIBULUM_CREATE_FLOOR_MS", async () => {
    setEnv({ [RuntimeEnv.CREATE_FLOOR_MS]: "900" });
    const s = sleeps();
    await build(s.sleep)(phantomEvent());
    expect(s.calls).toEqual([900]);
  });
});

describe("InitiateAuth's public ChallengeParameters carry nothing caller-specific (confirmed live)", () => {
  it.each([
    ["eligible", () => realEvent(), () => undefined],
    ["unknown (phantom)", phantomEvent, () => undefined],
    ["denylisted", () => realEvent(), () => denylist(true)],
    ["rate limited", () => realEvent(), () => rateLimit(false)],
    ["quarantined", () => realEvent({ "custom:email_quarantined": "true" }), () => undefined],
  ] as const)("%s: the same constant parameters, never the address", async (_n, event, arrange) => {
    arrange();
    const result = await build(sleeps().sleep)(event());
    expect(result.response.publicChallengeParameters).toEqual({ challenge: "MAGIC_LINK" });
    expect(JSON.stringify(result.response.publicChallengeParameters)).not.toContain(EMAIL);
    expect(JSON.stringify(result.response.publicChallengeParameters)).not.toContain("nobody-here");
  });
});

describe("U9: bounce quarantine is read", () => {
  it("returns an unanswerable challenge, indistinguishable in shape from a real one", async () => {
    const quarantined = await build(sleeps().sleep)(
      realEvent({ "custom:email_quarantined": "true" }),
    );
    const real = await build(sleeps().sleep)(realEvent());
    expect(Object.keys(quarantined.response.privateChallengeParameters ?? {}).sort()).toEqual(
      Object.keys(real.response.privateChallengeParameters ?? {}).sort(),
    );
    expect(quarantined.response.challengeMetadata).toBe(real.response.challengeMetadata);
    expect(quarantined.response.privateChallengeParameters?.["token_hash"]).toBe("denied");
  });

  it("a false attribute does not block", async () => {
    await build(sleeps().sleep)(realEvent({ "custom:email_quarantined": "false" }));
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(1);
  });
});

describe("SES configuration set (bounce wiring)", () => {
  it("sends with the configuration set so bounces reach the topic", async () => {
    setEnv({ [RuntimeEnv.SES_CONFIGURATION_SET]: "vestibulum-config" });
    await build(sleeps().sleep)(realEvent());
    expect(sesMock.commandCalls(SendEmailCommand)[0]?.args[0].input.ConfigurationSetName).toBe(
      "vestibulum-config",
    );
  });

  it("omits it when unset", async () => {
    await build(sleeps().sleep)(realEvent());
    expect(sesMock.commandCalls(SendEmailCommand)[0]?.args[0].input).not.toHaveProperty(
      "ConfigurationSetName",
    );
  });
});
