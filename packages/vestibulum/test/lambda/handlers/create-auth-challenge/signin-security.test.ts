/**
 * CreateAuthChallenge — the security invariants this trigger owns
 * (dot-notes doc/topics/passwordless-sign-in-aws/02-spec.md):
 *
 *   signin_mail_only_to_eligible    a mail is sent iff allow-list ∧ caps ∧ denylist ∧ quarantine all say yes (P)
 *   signin_fails_closed             every dependency error: no mail, no exception to Cognito, an unanswerable challenge (F)
 *   signin_token_at_rest_hashed     only H(token) and H(code) are stored; the typed code is in the mail only
 *   signin_secrets_never_logged     no address, subject, token, code or session in any log line or metric
 *   signin_no_self_signup           enrolment modes: admin-only consults the allow-list, self-signup does not
 *
 * State is observed at the SDK boundary (aws-sdk-client-mock): the assertions
 * are about the commands sent and the response returned.
 */

import { createHash } from "node:crypto";

import {
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ResourceNotFoundException,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { mockClient } from "aws-sdk-client-mock";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCreateAuthChallengeHandler,
  type CreateAuthChallengeEvent,
} from "../../../../src/lambda/handlers/create-auth-challenge/index.js";
import { RuntimeEnv } from "../../../../src/lambda/shared/runtime-env.js";
import { TTL_ATTRIBUTE } from "../../../../src/lambda/shared/signin.js";
import { FakeAllowList } from "../../fakes/fake-allow-list.js";

const ddbMock = mockClient(DynamoDBClient);
const sesMock = mockClient(SESClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

const NOW_MS = 1_700_000_000_000;
const EMAIL = "person@example.com";
const SUBJECT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TOKEN_BYTES = Buffer.alloc(32, 9);
const TOKEN = TOKEN_BYTES.toString("base64url");
const CODE = "04271983";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

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
    [RuntimeEnv.ENROLLMENT]: undefined,
    [RuntimeEnv.COGNITO_USER_POOL_ID]: undefined,
    [RuntimeEnv.TOKEN_SENDS_PER_DAY]: undefined,
    ...overrides,
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
}

function event(opts: { userName?: string; email?: string | null } = {}): CreateAuthChallengeEvent {
  return {
    userPoolId: "eu-central-1_EVENTPOOL",
    userName: opts.userName ?? SUBJECT,
    request: {
      userAttributes: opts.email === null ? {} : { email: opts.email ?? EMAIL },
    },
    response: {},
  };
}

let allow: FakeAllowList;

function handler(extra: Record<string, unknown> = {}) {
  return createCreateAuthChallengeHandler({
    dynamodb: ddbMock as unknown as DynamoDBClient,
    ses: sesMock as unknown as SESClient,
    nowMs: () => NOW_MS,
    sleep: () => Promise.resolve(),
    resolveHmacKey: () => Promise.resolve("test-hmac-key-not-a-secret"),
    randomToken: () => TOKEN_BYTES,
    randomCode: () => CODE,
    allowList: allow,
    ...extra,
  });
}

type Cap = "ok" | "over" | "error";
type Denylist = "clear" | "hit" | "no-table" | "table-gone" | "error";
type AllowState = "eligible" | "disabled" | "absent" | "unavailable";

/** Arranges every dependency at once. */
function arrange(s: { allow: AllowState; cap: Cap; denylist: Denylist; quarantined?: boolean }) {
  ddbMock.reset();
  sesMock.reset();
  allow = new FakeAllowList();
  if (s.allow === "eligible") allow.add(SUBJECT, EMAIL);
  if (s.allow === "disabled") allow.add(SUBJECT, EMAIL, false);
  if (s.allow === "unavailable") allow.unavailable = true;

  setEnv(s.denylist === "no-table" ? { [RuntimeEnv.DENYLIST_TABLE_NAME]: "" } : {});

  ddbMock.on(PutItemCommand).resolves({});
  sesMock.on(SendEmailCommand).resolves({});
  if (s.denylist === "hit") ddbMock.on(GetItemCommand).resolves({ Item: { email_hmac: { S: "x" } } });
  else if (s.denylist === "table-gone")
    ddbMock
      .on(GetItemCommand)
      .rejects(new ResourceNotFoundException({ message: "gone", $metadata: {} }));
  else if (s.denylist === "error") ddbMock.on(GetItemCommand).rejects(new Error("ddb down"));
  else ddbMock.on(GetItemCommand).resolves({});

  if (s.cap === "ok") ddbMock.on(UpdateItemCommand).resolves({});
  else if (s.cap === "over")
    ddbMock
      .on(UpdateItemCommand)
      .rejects(new ConditionalCheckFailedException({ message: "over", $metadata: {} }));
  else ddbMock.on(UpdateItemCommand).rejects(new Error("ddb down"));
}

const sent = () => sesMock.commandCalls(SendEmailCommand).length;

let lines: string[];

beforeEach(() => {
  lines = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c) => (lines.push(String(c)), true));
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  cognitoMock.reset();
  arrange({ allow: "eligible", cap: "ok", denylist: "clear" });
});

afterEach(() => {
  vi.restoreAllMocks();
  setEnv();
});

/** Reasons reported through the SignInSuppressed metric, in order. */
const suppressed = () =>
  lines
    .filter((l) => l.includes('"SignInSuppressed"'))
    .map((l) => (JSON.parse(l) as { reason: string }).reason);

describe("signin_mail_only_to_eligible (I7)", () => {
  it("P: for every allow-list × cap × denylist × quarantine state a mail is sent iff all four say yes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<AllowState>("eligible", "disabled", "absent", "unavailable"),
        fc.constantFrom<Cap>("ok", "over", "error"),
        fc.constantFrom<Denylist>("clear", "hit", "no-table", "table-gone", "error"),
        fc.boolean(),
        async (allowState, cap, denylist, quarantined) => {
          arrange({ allow: allowState, cap, denylist });
          const result = await handler()({
            ...event(),
            request: {
              userAttributes: {
                email: EMAIL,
                ...(quarantined ? { "custom:email_quarantined": "true" } : {}),
              },
            },
          });
          const yes =
            allowState === "eligible" && cap === "ok" && denylist === "clear" && !quarantined;
          expect(sent()).toBe(yes ? 1 : 0);
          expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(yes ? 1 : 0);
          // Answerable iff mailed; otherwise a dummy that the verifier refuses outright.
          expect(result.response.privateChallengeParameters?.["quarantined"]).toBe(
            yes ? "false" : "true",
          );
          expect(result.response.challengeMetadata).toBe("MAGIC_LINK");
        },
      ),
      { numRuns: 120 },
    );
  });

  it("the allow-list is asked about the event's own username, once, for a real user and the phantom alike", async () => {
    await handler()(event());
    await handler()(event({ userName: "phantom-xyz", email: null }));
    expect(allow.gets).toEqual([SUBJECT, "phantom-xyz"]);
  });

  it("a phantom (no email) is never mailed even if the allow-list claims its username", async () => {
    allow.add("phantom-xyz", EMAIL);
    await handler()(event({ userName: "phantom-xyz", email: null }));
    expect(sent()).toBe(0);
    expect(suppressed()).toEqual(["unknown_user"]);
  });

  it("mails the NORMALISED address (ses:Recipients and suppression entries are case-sensitive)", async () => {
    await handler()(event({ email: "  Person@Example.COM " }));
    expect(sesMock.commandCalls(SendEmailCommand)[0]!.args[0].input.Destination?.ToAddresses).toEqual([
      "person@example.com",
    ]);
  });

  it("a stored address that cannot be normalised is treated as unknown and never mailed", async () => {
    await handler()(event({ email: "not an address" }));
    expect(sent()).toBe(0);
    expect(suppressed()).toEqual(["unknown_user"]);
  });
});

describe("signin_fails_closed (I15) — every dependency error: no mail, no exception, unanswerable", () => {
  const cases: ReadonlyArray<readonly [string, Parameters<typeof arrange>[0], string]> = [
    ["allow-list unavailable", { allow: "unavailable", cap: "ok", denylist: "clear" }, "allow_list_down"],
    ["denylist read error", { allow: "eligible", cap: "ok", denylist: "error" }, "denylist_down"],
    ["denylist table missing (ResourceNotFound)", { allow: "eligible", cap: "ok", denylist: "table-gone" }, "denylist_down"],
    ["denylist table name unset", { allow: "eligible", cap: "ok", denylist: "no-table" }, "denylist_down"],
    ["rate-limit counter error", { allow: "eligible", cap: "error", denylist: "clear" }, "dependency_error"],
  ];

  it.each(cases)("%s", async (_name, state, reason) => {
    arrange(state);
    const result = await handler()(event());
    expect(sent()).toBe(0);
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    expect(result.response.privateChallengeParameters?.["quarantined"]).toBe("true");
    expect(suppressed()).toEqual([reason]);
  });

  it("the denylist table name unset is also unanswerable when the env var is absent altogether", async () => {
    setEnv({ [RuntimeEnv.DENYLIST_TABLE_NAME]: undefined });
    const result = await handler()(event());
    expect(sent()).toBe(0);
    expect(result.response.privateChallengeParameters?.["quarantined"]).toBe("true");
    expect(suppressed()).toEqual(["denylist_down"]);
  });

  it("an HMAC-key (Secrets Manager) failure is unanswerable", async () => {
    const result = await handler({ resolveHmacKey: () => Promise.reject(new Error("sm down")) })(event());
    expect(sent()).toBe(0);
    expect(result.response.privateChallengeParameters?.["quarantined"]).toBe("true");
    expect(suppressed()).toEqual(["dependency_error"]);
  });

  it.each([[""], [undefined]])("an EMPTY HMAC key (%j: the secret id is unset) is a dependency error, not a key: nothing is mailed or counted", async (empty) => {
    const result = await handler({ resolveHmacKey: () => Promise.resolve(empty as string) })(event());
    expect(sent()).toBe(0);
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0); // no unkeyed counter row is written
    expect(result.response.privateChallengeParameters?.["quarantined"]).toBe("true");
    expect(suppressed()).toEqual(["dependency_error"]);
  });

  it("the window and daily counters are written under the secret-keyed ids, with the resolved key", async () => {
    await handler({ resolveHmacKey: () => Promise.resolve("key-one") })(event());
    const ids = (k: string) => {
      ddbMock.resetHistory();
      return handler({ resolveHmacKey: () => Promise.resolve(k) })(event()).then(() =>
        ddbMock.commandCalls(UpdateItemCommand).map((c) => (c.args[0].input.Key as { bucket_id: { S: string } }).bucket_id.S),
      );
    };
    const a = await ids("key-one");
    const b = await ids("key-two");
    expect(a).toHaveLength(2);
    expect(a.some((id) => b.includes(id))).toBe(false);
  });

  it("a token-store write failure sends nothing and is unanswerable", async () => {
    ddbMock.on(PutItemCommand).rejects(new Error("ddb down"));
    const result = await handler()(event());
    expect(sent()).toBe(0);
    expect(result.response.privateChallengeParameters?.["quarantined"]).toBe("true");
    expect(suppressed()).toEqual(["dependency_error"]);
  });

  it("an SES failure (including an IAM recipient-fence AccessDenied) is unanswerable: the stored token is unreachable", async () => {
    sesMock.on(SendEmailCommand).rejects(new Error("AccessDenied: not authorized to ses:SendEmail"));
    const result = await handler()(event());
    const priv = result.response.privateChallengeParameters!;
    expect(priv["quarantined"]).toBe("true");
    // The token row exists, but its hash is in no private parameter: no session can redeem it.
    const stored = ddbMock.commandCalls(PutItemCommand)[0]!.args[0].input.Item!["token_hash"]!.S;
    expect(priv["token_hash"]).not.toBe(stored);
    expect(suppressed()).toEqual(["dependency_error"]);
  });

  it("an allow-list that throws (rather than answering) is unanswerable too", async () => {
    const result = await handler({
      allowList: { lookup: () => Promise.reject(new Error("x")), get: () => Promise.reject(new Error("x")) },
    })(event());
    expect(sent()).toBe(0);
    expect(result.response.privateChallengeParameters?.["quarantined"]).toBe("true");
    expect(suppressed()).toEqual(["allow_list_down"]);
  });
});

describe("the metric names a closed reason for every silent path", () => {
  it.each([
    ["not on the allow-list", { allow: "absent", cap: "ok", denylist: "clear" }, "unknown_user"],
    ["disabled on the allow-list", { allow: "disabled", cap: "ok", denylist: "clear" }, "ineligible"],
    ["denylisted", { allow: "eligible", cap: "ok", denylist: "hit" }, "denylisted"],
    ["over the cap", { allow: "eligible", cap: "over", denylist: "clear" }, "rate_limited"],
  ] as const)("%s -> %s", async (_n, state, reason) => {
    arrange(state);
    await handler()(event());
    expect(suppressed()).toEqual([reason]);
  });

  it("quarantined by a hard bounce -> quarantined", async () => {
    await handler()({
      ...event(),
      request: { userAttributes: { email: EMAIL, "custom:email_quarantined": "true" } },
    });
    expect(suppressed()).toEqual(["quarantined"]);
  });

  it("an issued challenge emits no suppression metric", async () => {
    await handler()(event());
    expect(suppressed()).toEqual([]);
    expect(sent()).toBe(1);
  });
});

describe("the typed 8-digit code (U16 / I10 / I13)", () => {
  it("stores only H(token) and H(code); the row and the private parameters agree", async () => {
    const result = await handler()(event());
    const item = ddbMock.commandCalls(PutItemCommand)[0]!.args[0].input.Item!;
    expect(item["token_hash"]).toEqual({ S: sha256(TOKEN) });
    expect(item["code_hash"]).toEqual({ S: sha256(CODE) });
    expect(item[TTL_ATTRIBUTE]).toEqual({ N: String(NOW_MS / 1000 + 600) });
    const priv = result.response.privateChallengeParameters!;
    expect(priv["token_hash"]).toBe(sha256(TOKEN));
    expect(priv["code_hash"]).toBe(sha256(CODE));
    expect(priv["quarantined"]).toBe("false");
  });

  it("I13: no stored attribute and no private or public parameter contains the token or the code", async () => {
    const result = await handler()(event());
    const everything = JSON.stringify([
      ddbMock.commandCalls(PutItemCommand).map((c) => c.args[0].input),
      ddbMock.commandCalls(UpdateItemCommand).map((c) => c.args[0].input),
      result.response,
    ]);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(CODE);
  });

  it("the mail carries the link first and the code second, in the text and the HTML part", async () => {
    await handler()(event());
    const body = sesMock.commandCalls(SendEmailCommand)[0]!.args[0].input.Message!.Body!;
    for (const part of [body.Text!.Data!, body.Html!.Data!]) {
      const link = part.indexOf(`https://app.example.com/login/callback#token=${TOKEN}`);
      const code = part.indexOf(CODE);
      expect(link).toBeGreaterThanOrEqual(0);
      expect(code).toBeGreaterThan(link); // the link stays primary
    }
  });

  it("the default generator yields 8 ASCII digits (zero-padded), different between calls", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 12; i++) {
      sesMock.resetHistory();
      await handler({ randomCode: undefined })(event());
      const text = sesMock.commandCalls(SendEmailCommand)[0]!.args[0].input.Message!.Body!.Text!.Data!;
      const m = /^(\d{8})$/m.exec(text);
      expect(m).not.toBeNull();
      codes.add(m![1]!);
    }
    expect(codes.size).toBeGreaterThan(1);
  });

  it("the silent path generates and hashes a token and a code it never sends (same work shape)", async () => {
    let tokens = 0;
    let codes = 0;
    arrange({ allow: "absent", cap: "ok", denylist: "clear" });
    const result = await handler({
      randomToken: () => (tokens++, TOKEN_BYTES),
      randomCode: () => (codes++, CODE),
    })(event());
    expect([tokens, codes]).toEqual([1, 1]);
    expect(sent()).toBe(0);
    const priv = result.response.privateChallengeParameters!;
    expect(priv["code_hash"]).toBe(sha256(CODE)); // hashed ...
    expect(JSON.stringify(ddbMock.calls().map((c) => c.args[0].input))).not.toContain(sha256(CODE)); // ... never stored
  });

  it("unanswerable and answerable challenges have the same private-parameter keys", async () => {
    const real = await handler()(event());
    arrange({ allow: "absent", cap: "ok", denylist: "clear" });
    const dummy = await handler()(event());
    expect(Object.keys(dummy.response.privateChallengeParameters!).sort()).toEqual(
      Object.keys(real.response.privateChallengeParameters!).sort(),
    );
    expect(dummy.response.publicChallengeParameters).toEqual(real.response.publicChallengeParameters);
  });
});

describe("enrolment modes (signin_no_self_signup)", () => {
  it("self-signup: the allow-list is not consulted and a user the PreSignUp gate admitted is mailed", async () => {
    arrange({ allow: "absent", cap: "ok", denylist: "clear" });
    setEnv({ [RuntimeEnv.ENROLLMENT]: "self-signup" });
    await handler()(event());
    expect(allow.calls).toEqual([]);
    expect(sent()).toBe(1);
  });

  it("self-signup: a phantom is still never mailed", async () => {
    setEnv({ [RuntimeEnv.ENROLLMENT]: "self-signup" });
    await handler()(event({ email: null }));
    expect(sent()).toBe(0);
  });

  it("admin-only is the default when VESTIBULUM_ENROLLMENT is unset or empty", async () => {
    for (const v of [undefined, ""]) {
      arrange({ allow: "absent", cap: "ok", denylist: "clear" });
      setEnv({ [RuntimeEnv.ENROLLMENT]: v });
      await handler()(event());
      expect(allow.gets).toEqual([SUBJECT]);
      expect(sent()).toBe(0);
    }
  });

  it.each(["self_signup", "open", "ADMIN-ONLY", "none"])(
    "an unknown enrolment value (%s) is a deployment error: it throws, mails nothing and asks nobody",
    async (bad) => {
      setEnv({ [RuntimeEnv.ENROLLMENT]: bad });
      await expect(handler()(event())).rejects.toThrow();
      expect(sent()).toBe(0);
      expect(allow.calls).toEqual([]);
    },
  );

  it("the default allow-list reads THIS pool's user: the trigger event's pool id and username", async () => {
    cognitoMock.on(AdminGetUserCommand).resolves({
      Enabled: true,
      UserAttributes: [{ Name: "email_verified", Value: "true" }],
    });
    await handler({
      allowList: undefined,
      cognitoClient: cognitoMock as unknown as CognitoIdentityProviderClient,
    })(event());
    expect(cognitoMock.commandCalls(AdminGetUserCommand)[0]!.args[0].input).toEqual({
      UserPoolId: "eu-central-1_EVENTPOOL",
      Username: SUBJECT,
    });
    expect(sent()).toBe(1);
  });

  it("VESTIBULUM_USER_POOL_ID, when set, wins over the event's pool id", async () => {
    setEnv({ [RuntimeEnv.COGNITO_USER_POOL_ID]: "eu-central-1_ENVPOOL" });
    cognitoMock.on(AdminGetUserCommand).resolves({
      Enabled: true,
      UserAttributes: [{ Name: "email_verified", Value: "true" }],
    });
    await handler({
      allowList: undefined,
      cognitoClient: cognitoMock as unknown as CognitoIdentityProviderClient,
    })(event());
    expect(cognitoMock.commandCalls(AdminGetUserCommand)[0]!.args[0].input.UserPoolId).toBe(
      "eu-central-1_ENVPOOL",
    );
  });

  it("a Cognito failure from the default allow-list is unanswerable, not an exception", async () => {
    cognitoMock.on(AdminGetUserCommand).rejects(new Error("throttled"));
    const result = await handler({
      allowList: undefined,
      cognitoClient: cognitoMock as unknown as CognitoIdentityProviderClient,
    })(event());
    expect(sent()).toBe(0);
    expect(result.response.privateChallengeParameters?.["quarantined"]).toBe("true");
  });
});

describe("signin_secrets_never_logged (I12) — the Create paths", () => {
  it("emits no address, subject, token, code, hash or digit run on any path", async () => {
    const states = [
      { allow: "eligible", cap: "ok", denylist: "clear" },
      { allow: "absent", cap: "ok", denylist: "clear" },
      { allow: "disabled", cap: "ok", denylist: "clear" },
      { allow: "unavailable", cap: "ok", denylist: "clear" },
      { allow: "eligible", cap: "over", denylist: "clear" },
      { allow: "eligible", cap: "error", denylist: "clear" },
      { allow: "eligible", cap: "ok", denylist: "hit" },
      { allow: "eligible", cap: "ok", denylist: "error" },
      { allow: "eligible", cap: "ok", denylist: "no-table" },
    ] as const;
    for (const s of states) {
      arrange(s);
      // Errors that echo the address must not reach any log line.
      if (s.cap === "error") ddbMock.on(UpdateItemCommand).rejects(new Error(`boom for ${EMAIL}`));
      await handler()(event());
    }
    arrange({ allow: "eligible", cap: "ok", denylist: "clear" });
    sesMock.on(SendEmailCommand).rejects(new Error(`ses refused ${EMAIL} token=${TOKEN}`));
    await handler()(event());

    const scanned = lines
      .map((l) => l.replace(/"Timestamp":\d+/g, '"Timestamp":0'))
      .join("\n");
    expect(scanned.length).toBeGreaterThan(0);
    expect(scanned).not.toMatch(/@/);
    expect(scanned).not.toMatch(/\d{6,}/);
    expect(scanned).not.toMatch(/[A-Za-z0-9_-]{20,}/);
    for (const secret of [EMAIL, SUBJECT, TOKEN, CODE, sha256(TOKEN), sha256(CODE), "Session", "token=", "#t="]) {
      expect(scanned).not.toContain(secret);
    }
  });
});

describe("the per-address daily cap in Create (I10: 20 per UTC day)", () => {
  const DAY_MS = 86_400_000;
  const MIDNIGHT = Math.floor(NOW_MS / DAY_MS) * DAY_MS + DAY_MS;

  /** Window counters always pass; the daily counter has the real conditional semantics. */
  let daily: Map<string, number>;
  let clock: number;
  let dailyWrites: number;

  function arrangeCounters() {
    daily = new Map();
    dailyWrites = 0;
    ddbMock.on(UpdateItemCommand).callsFake((input: {
      Key: { bucket_id: { S: string } };
      ExpressionAttributeNames: Record<string, string>;
      ExpressionAttributeValues: Record<string, { N: string }>;
    }) => {
      if (input.ExpressionAttributeNames["#ws"] !== undefined) return {}; // the 15-minute window counter
      dailyWrites++;
      const id = input.Key.bucket_id.S;
      const n = daily.get(id);
      if (n !== undefined && n >= Number(input.ExpressionAttributeValues[":limit"]!.N)) {
        throw new ConditionalCheckFailedException({ message: "over", $metadata: {} });
      }
      daily.set(id, (n ?? 0) + 1);
      return {};
    });
  }

  const at = () => handler({ nowMs: () => clock });

  beforeEach(() => {
    clock = NOW_MS;
    arrangeCounters();
  });

  it("the 20th challenge in a UTC day is mailed; the 21st is unanswerable, sends nothing and reports daily_cap", async () => {
    for (let i = 1; i <= 20; i++) {
      const r = await at()(event());
      expect(r.response.privateChallengeParameters?.["quarantined"], `challenge ${i}`).toBe("false");
    }
    expect(sent()).toBe(20);
    const r21 = await at()(event());
    expect(r21.response.privateChallengeParameters?.["quarantined"]).toBe("true");
    expect(sent()).toBe(20); // no 21st mail
    expect(suppressed()).toEqual(["daily_cap"]);
  });

  it("the counter resets across UTC midnight with a pinned clock", async () => {
    clock = MIDNIGHT - 1;
    for (let i = 0; i < 20; i++) await at()(event());
    expect(sent()).toBe(20);
    await at()(event()); // the 21st, one millisecond before midnight
    expect(sent()).toBe(20);
    clock = MIDNIGHT;
    const next = await at()(event());
    expect(next.response.privateChallengeParameters?.["quarantined"]).toBe("false");
    expect(sent()).toBe(21);
  });

  it("is per address: another person is unaffected by the first one's exhausted cap", async () => {
    for (let i = 0; i < 21; i++) await at()(event());
    allow.add("bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee", "other@example.com");
    const other = await at()({
      ...event({ userName: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee" }),
      request: { userAttributes: { email: "other@example.com" } },
    });
    expect(other.response.privateChallengeParameters?.["quarantined"]).toBe("false");
  });

  it("every caller class does the SAME daily write — the phantom, an ineligible, a denylisted and a capped one included", async () => {
    await at()(event()); // eligible
    await at()(event({ userName: "phantom-xyz", email: null })); // phantom
    allow.setActive(SUBJECT, false);
    await at()(event()); // ineligible
    allow.setActive(SUBJECT, true);
    ddbMock.on(GetItemCommand).resolves({ Item: { email_hmac: { S: "x" } } });
    await at()(event()); // denylisted
    expect(dailyWrites).toBe(4);
  });

  it("the phantom's counter is keyed on its made-up username, not on any address", async () => {
    await at()(event({ userName: "phantom-xyz", email: null }));
    expect(daily.size).toBe(1);
    expect([...daily.keys()][0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a counter error fails closed: no mail, no exception to Cognito, an unanswerable challenge", async () => {
    ddbMock.on(UpdateItemCommand).callsFake((input: { ExpressionAttributeNames: Record<string, string> }) => {
      if (input.ExpressionAttributeNames["#ws"] !== undefined) return {};
      throw new Error("ddb down");
    });
    const r = await at()(event());
    expect(r.response.privateChallengeParameters?.["quarantined"]).toBe("true");
    expect(sent()).toBe(0);
    expect(suppressed()).toEqual(["dependency_error"]);
  });

  it("VESTIBULUM_TOKEN_SENDS_PER_DAY overrides the default", async () => {
    setEnv({ [RuntimeEnv.TOKEN_SENDS_PER_DAY]: "2" });
    for (let i = 0; i < 3; i++) await at()(event());
    expect(sent()).toBe(2);
    expect(suppressed()).toEqual(["daily_cap"]);
  });

  it.each(["0", "-1", "abc", "1.5"])("a malformed VESTIBULUM_TOKEN_SENDS_PER_DAY (%s) is a deployment error: it throws and mails nothing", async (bad) => {
    setEnv({ [RuntimeEnv.TOKEN_SENDS_PER_DAY]: bad });
    await expect(at()(event())).rejects.toThrow();
    expect(sent()).toBe(0);
  });

  it("the window cap and the daily cap are independent: the window can refuse while the day has room", async () => {
    ddbMock.on(UpdateItemCommand).callsFake((input: { ExpressionAttributeNames: Record<string, string> }) => {
      if (input.ExpressionAttributeNames["#ws"] !== undefined) {
        throw new ConditionalCheckFailedException({ message: "over", $metadata: {} });
      }
      return {};
    });
    await at()(event());
    expect(suppressed()).toEqual(["rate_limited"]);
  });
});
