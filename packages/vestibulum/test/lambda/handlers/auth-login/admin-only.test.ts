/**
 * auth-login in the default `admin-only` enrolment mode
 * (dot-notes doc/topics/passwordless-sign-in-aws/02-spec.md):
 *
 *   signin_no_self_signup              no SignUp is ever called; an address is looked up, never created (I9)
 *   signin_request_indistinguishable   every caller class gets the same 202 {} + cookie, after the floor (I6)
 *   signin_fails_closed                an unavailable allow-list is the phantom path, not an error (I15)
 *   (U18)                              the address is normalised before ANY Cognito call; a rejected address is a 400
 *   signin_secrets_never_logged        no address, subject, phantom username or session in any log line (I12)
 *
 * Cognito + DynamoDB are mocked at the SDK boundary; the allow-list is an
 * in-memory fake; the clock, sleep, secret and phantom generators are injected.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  ListUsersCommand,
  SignUpCommand,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAuthLoginHandler,
  type LambdaFunctionUrlEvent,
  type LambdaFunctionUrlResult,
} from "../../../../src/lambda/handlers/auth-login/index.js";
import { RuntimeEnv } from "../../../../src/lambda/shared/runtime-env.js";
import {
  DEFAULT_SIGNIN_FLOOR_MS,
  hashBindingSecret,
} from "../../../../src/lambda/shared/signin.js";
import { FakeAllowList } from "../../fakes/fake-allow-list.js";

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const ddbMock = mockClient(DynamoDBClient);

const DOMAIN = "app.example.com";
const EMAIL = "person@example.com";
const SUBJECT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PHANTOM = "99999999-8888-4777-8666-555555555555";
const SECRET = "S".repeat(43);
const NOW_MS = 1_700_000_000_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const sleeps: number[] = [];
let allow: FakeAllowList;

function makeEvent(email: unknown = EMAIL): LambdaFunctionUrlEvent {
  return {
    headers: { origin: `https://${DOMAIN}`, "x-forwarded-for": "203.0.113.7" },
    body: JSON.stringify({ email }),
  };
}

function makeDeps(extra: Record<string, unknown> = {}) {
  return {
    cognitoClient: cognitoMock as unknown as CognitoIdentityProviderClient,
    dynamodb: ddbMock as unknown as DynamoDBClient,
    allowList: allow,
    nowMs: () => NOW_MS,
    randomSecret: () => SECRET,
    randomPhantom: () => PHANTOM,
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...extra,
  };
}

function arrangeHappy(session = "sess-1", username = SUBJECT) {
  ddbMock.on(UpdateItemCommand).resolves({});
  ddbMock.on(PutItemCommand).resolves({});
  cognitoMock.on(InitiateAuthCommand).resolves({
    Session: session,
    ChallengeParameters: { USERNAME: username },
  });
}

const initiateAuths = () => cognitoMock.commandCalls(InitiateAuthCommand);
const usernameSent = () =>
  (initiateAuths()[0]!.args[0].input.AuthParameters as { USERNAME: string }).USERNAME;
const bindingPuts = () => ddbMock.commandCalls(PutItemCommand);

let lines: string[];

beforeEach(() => {
  cognitoMock.reset();
  ddbMock.reset();
  sleeps.length = 0;
  lines = [];
  allow = new FakeAllowList().add(SUBJECT, EMAIL);
  process.env[RuntimeEnv.DOMAIN] = DOMAIN;
  process.env[RuntimeEnv.COGNITO_CLIENT_ID] = "client-1";
  process.env[RuntimeEnv.RATE_LIMIT_TABLE_NAME] = "rate";
  process.env[RuntimeEnv.BINDING_TABLE_NAME] = "binding";
  process.env[RuntimeEnv.COGNITO_USER_POOL_ID] = "eu-central-1_TESTPOOL";
  Reflect.deleteProperty(process.env, RuntimeEnv.ENROLLMENT); // the default under test
  Reflect.deleteProperty(process.env, RuntimeEnv.TOKEN_TTL_MINUTES);
  Reflect.deleteProperty(process.env, RuntimeEnv.SIGNIN_FLOOR_MS);
  Reflect.deleteProperty(process.env, RuntimeEnv.LOGIN_IP_PER_WINDOW);
  vi.spyOn(process.stdout, "write").mockImplementation((c) => (lines.push(String(c)), true));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
});

afterEach(() => vi.restoreAllMocks());

describe("signin_no_self_signup (I9) — no SignUp, ever", () => {
  it("an eligible address: InitiateAuth with the SUBJECT, no SignUp", async () => {
    arrangeHappy();
    const result = await createAuthLoginHandler(makeDeps())(makeEvent());
    expect(result.statusCode).toBe(202);
    expect(usernameSent()).toBe(SUBJECT);
    expect(cognitoMock.commandCalls(SignUpCommand)).toHaveLength(0);
  });

  it("an unknown address: InitiateAuth with a phantom username, no SignUp (the address is never created)", async () => {
    arrangeHappy();
    const result = await createAuthLoginHandler(makeDeps())(makeEvent("stranger@example.com"));
    expect(result.statusCode).toBe(202);
    expect(usernameSent()).toBe(PHANTOM);
    expect(cognitoMock.commandCalls(SignUpCommand)).toHaveLength(0);
    // ... and nothing named the address to Cognito at all.
    expect(JSON.stringify(cognitoMock.calls().map((c) => c.args[0].input))).not.toContain("stranger");
  });

  it("P: whatever the address and caller class, SignUp is never called and exactly one InitiateAuth is", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.emailAddress(),
        fc.constantFrom("known", "unknown", "disabled", "unavailable", "exists-error"),
        async (email, kind) => {
          cognitoMock.reset();
          ddbMock.reset();
          arrangeHappy();
          allow = new FakeAllowList();
          if (kind === "known" || kind === "disabled") allow.add(SUBJECT, email.trim().toLowerCase(), kind === "known");
          if (kind === "unavailable") allow.unavailable = true;
          if (kind === "exists-error")
            cognitoMock
              .on(SignUpCommand)
              .rejects(new UsernameExistsException({ message: "exists", $metadata: {} }));
          await createAuthLoginHandler(makeDeps())(makeEvent(email));
          expect(cognitoMock.commandCalls(SignUpCommand)).toHaveLength(0);
          expect(initiateAuths().length).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("the allow-list lookup (U6) and the phantom", () => {
  it("looks up the NORMALISED address (U18)", async () => {
    arrangeHappy();
    await createAuthLoginHandler(makeDeps())(makeEvent("  Person@Example.COM  "));
    expect(allow.lookups).toEqual([EMAIL]);
  });

  it("a subject that is disabled on the allow-list still gets InitiateAuth(subject) (Cognito refuses it) and the same response", async () => {
    allow.setActive(SUBJECT, false);
    arrangeHappy();
    cognitoMock.on(InitiateAuthCommand).rejects(new Error("NotAuthorizedException"));
    const result = await createAuthLoginHandler(makeDeps())(makeEvent());
    expect(result.statusCode).toBe(202);
    expect(usernameSent()).toBe(SUBJECT);
  });

  it("an unavailable allow-list (I15) takes the phantom path: no error, the same response, no subject", async () => {
    allow.unavailable = true;
    arrangeHappy();
    const result = await createAuthLoginHandler(makeDeps())(makeEvent());
    expect(result.statusCode).toBe(202);
    expect(usernameSent()).toBe(PHANTOM);
  });

  it("an allow-list that throws is also the phantom path", async () => {
    arrangeHappy();
    const result = await createAuthLoginHandler(
      makeDeps({ allowList: { lookup: () => Promise.reject(new Error("x")), get: () => Promise.reject(new Error("x")) } }),
    )(makeEvent());
    expect(result.statusCode).toBe(202);
    expect(usernameSent()).toBe(PHANTOM);
  });

  it("the phantom is drawn per call, and by default is a UUID v4 (the pool's username format)", async () => {
    arrangeHappy();
    const handler = createAuthLoginHandler(makeDeps({ randomPhantom: undefined }));
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      cognitoMock.resetHistory();
      await handler(makeEvent("stranger@example.com"));
      seen.add(usernameSent());
    }
    expect(seen.size).toBe(6);
    for (const u of seen) expect(u).toMatch(UUID_V4);
  });

  it("stores the echoed username, falling back to the one it sent", async () => {
    arrangeHappy("sess-x", "echoed-by-cognito");
    await createAuthLoginHandler(makeDeps())(makeEvent());
    expect(bindingPuts()[0]!.args[0].input.Item?.["username"]).toEqual({ S: "echoed-by-cognito" });

    ddbMock.reset();
    arrangeHappy();
    cognitoMock.on(InitiateAuthCommand).resolves({ Session: "s" });
    await createAuthLoginHandler(makeDeps())(makeEvent("stranger@example.com"));
    expect(bindingPuts()[0]!.args[0].input.Item?.["username"]).toEqual({ S: PHANTOM });
  });

  it("a stored binding keeps the session under H(b) exactly as in self-signup mode", async () => {
    arrangeHappy("SESSION-VALUE-xyz");
    await createAuthLoginHandler(makeDeps())(makeEvent());
    const item = bindingPuts()[0]!.args[0].input.Item!;
    expect(item["binding_hash"]).toEqual({ S: hashBindingSecret(SECRET) });
    expect(item["session"]).toEqual({ S: "SESSION-VALUE-xyz" });
  });

  it("the default allow-list lists users by exact email on this pool and uses the Username it finds", async () => {
    arrangeHappy();
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        {
          Username: SUBJECT,
          Enabled: true,
          Attributes: [{ Name: "email_verified", Value: "true" }],
        },
      ],
    });
    await createAuthLoginHandler(makeDeps({ allowList: undefined }))(makeEvent("Person@Example.com"));
    expect(cognitoMock.commandCalls(ListUsersCommand)[0]!.args[0].input).toEqual({
      UserPoolId: "eu-central-1_TESTPOOL",
      Filter: `email = "${EMAIL}"`,
      Limit: 2,
    });
    expect(usernameSent()).toBe(SUBJECT);
  });

  it("the default allow-list: two users with one address is ambiguous -> phantom, never one of them", async () => {
    arrangeHappy();
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        { Username: "u1", Enabled: true, Attributes: [{ Name: "email_verified", Value: "true" }] },
        { Username: "u2", Enabled: true, Attributes: [{ Name: "email_verified", Value: "true" }] },
      ],
    });
    await createAuthLoginHandler(makeDeps({ allowList: undefined }))(makeEvent());
    expect(usernameSent()).toBe(PHANTOM);
  });
});

describe("(U18) a rejected address is a 400 before anything is called", () => {
  it.each([
    ["two @", "a@b@example.com"],
    ["no @", "person.example.com"],
    ["a space inside", "per son@example.com"],
    ["a newline inside", "person@example.com\nbcc@example.com"],
    ["over 254 octets", "a".repeat(250) + "@example.com"],
    ["empty local part", "@example.com"],
  ])("%s", async (_n, email) => {
    arrangeHappy();
    const result = await createAuthLoginHandler(makeDeps())(makeEvent(email));
    expect(result.statusCode).toBe(400);
    expect(cognitoMock.calls()).toHaveLength(0);
    expect(ddbMock.calls()).toHaveLength(0);
    expect(allow.calls).toEqual([]);
    expect(sleeps).toEqual([]); // input validation, same for every address: no floor needed
  });

  it("a non-string email is a 400 too", async () => {
    const result = await createAuthLoginHandler(makeDeps())(makeEvent(12345));
    expect(result.statusCode).toBe(400);
  });
});

describe("signin_request_indistinguishable (I6) in admin-only mode", () => {
  type Arrange = () => void;
  const classes: ReadonlyArray<readonly [string, Arrange, string]> = [
    ["eligible", () => arrangeHappy(), EMAIL],
    ["unknown address (phantom)", () => arrangeHappy(), "stranger@example.com"],
    [
      "disabled on the allow-list",
      () => {
        allow.setActive(SUBJECT, false);
        arrangeHappy();
        cognitoMock.on(InitiateAuthCommand).rejects(new Error("NotAuthorizedException"));
      },
      EMAIL,
    ],
    [
      "allow-list unavailable",
      () => {
        allow.unavailable = true;
        arrangeHappy();
      },
      EMAIL,
    ],
    [
      "Cognito error",
      () => {
        arrangeHappy();
        cognitoMock.on(InitiateAuthCommand).rejects(new Error("boom"));
      },
      EMAIL,
    ],
    [
      "no session returned",
      () => {
        arrangeHappy();
        cognitoMock.on(InitiateAuthCommand).resolves({});
      },
      EMAIL,
    ],
    [
      "per-IP rate limited",
      () => {
        arrangeHappy();
        ddbMock
          .on(UpdateItemCommand)
          .rejects(new ConditionalCheckFailedException({ message: "over", $metadata: {} }));
      },
      EMAIL,
    ],
    [
      "binding store error",
      () => {
        arrangeHappy();
        ddbMock.on(PutItemCommand).rejects(new Error("ddb down"));
      },
      EMAIL,
    ],
  ];

  /** Everything a caller can observe except the random cookie value. */
  function observable(r: LambdaFunctionUrlResult) {
    return {
      status: r.statusCode,
      body: r.body,
      headerNames: Object.keys(r.headers ?? {}).sort(),
      cookieAttributes: (r.cookies ?? []).map((c) =>
        c
          .split(";")
          .map((p) => p.trim())
          .map((p, i) => (i === 0 ? p.split("=")[0] : p))
          .join("; "),
      ),
    };
  }

  async function run(arrange: Arrange, email: string) {
    cognitoMock.reset();
    ddbMock.reset();
    allow = new FakeAllowList().add(SUBJECT, EMAIL);
    sleeps.length = 0;
    arrange();
    const result = await createAuthLoginHandler(makeDeps())(makeEvent(email));
    return { result, sleeps: [...sleeps] };
  }

  it("every caller class yields the same observable response", async () => {
    const baseline = observable((await run(classes[0]![1], EMAIL)).result);
    expect(baseline.status).toBe(202);
    for (const [, arrange, email] of classes) {
      expect(observable((await run(arrange, email)).result)).toEqual(baseline);
    }
  });

  it.each(classes)("%s: waits for the floor", async (_n, arrange, email) => {
    expect((await run(arrange, email)).sleeps).toEqual([DEFAULT_SIGNIN_FLOOR_MS]);
  });

  it("a failed outcome still stores a binding row with no session", async () => {
    const failing = classes.find(([n]) => n === "allow-list unavailable")!;
    cognitoMock.reset();
    ddbMock.reset();
    allow.unavailable = true;
    arrangeHappy();
    cognitoMock.on(InitiateAuthCommand).rejects(new Error("x"));
    await createAuthLoginHandler(makeDeps())(makeEvent(failing[2]));
    expect(bindingPuts()[0]!.args[0].input.Item).not.toHaveProperty("session");
  });

  it("an over-limit caller never reaches the allow-list or Cognito", async () => {
    arrangeHappy();
    ddbMock
      .on(UpdateItemCommand)
      .rejects(new ConditionalCheckFailedException({ message: "over", $metadata: {} }));
    await createAuthLoginHandler(makeDeps())(makeEvent());
    expect(allow.calls).toEqual([]);
    expect(initiateAuths()).toHaveLength(0);
  });
});

describe("configuration (fails the same way for every caller)", () => {
  it("admin-only with no pool id and no injected allow-list is a configuration error: 401, nothing called", async () => {
    Reflect.deleteProperty(process.env, RuntimeEnv.COGNITO_USER_POOL_ID);
    arrangeHappy();
    const result = await createAuthLoginHandler(makeDeps({ allowList: undefined }))(makeEvent());
    expect(result.statusCode).toBe(401);
    expect(cognitoMock.calls()).toHaveLength(0);
  });

  it.each(["self_signup", "open", "ADMIN-ONLY", "none"])(
    "an unknown VESTIBULUM_ENROLLMENT (%s) is a configuration error: never self-signup, never silently admin-only",
    async (bad) => {
      process.env[RuntimeEnv.ENROLLMENT] = bad;
      arrangeHappy();
      const result = await createAuthLoginHandler(makeDeps())(makeEvent());
      expect(result.statusCode).toBe(401);
      expect(cognitoMock.calls()).toHaveLength(0);
    },
  );

  it("an explicit admin-only behaves like the default", async () => {
    process.env[RuntimeEnv.ENROLLMENT] = "admin-only";
    arrangeHappy();
    await createAuthLoginHandler(makeDeps())(makeEvent());
    expect(cognitoMock.commandCalls(SignUpCommand)).toHaveLength(0);
    expect(usernameSent()).toBe(SUBJECT);
  });
});

describe("signin_secrets_never_logged (I12) — the admin-only request paths", () => {
  it("emits no address, subject, phantom username or session on any class", async () => {
    const paths: Array<() => void> = [
      () => arrangeHappy("SESSION-VALUE-xyz"),
      () => {
        arrangeHappy("SESSION-VALUE-xyz");
        cognitoMock.on(InitiateAuthCommand).rejects(new Error(`boom for ${EMAIL} ${SUBJECT}`));
      },
      () => {
        allow.unavailable = true;
        arrangeHappy("SESSION-VALUE-xyz");
      },
      () => {
        arrangeHappy("SESSION-VALUE-xyz");
        ddbMock.on(PutItemCommand).rejects(new Error(`store error for ${EMAIL}`));
      },
    ];
    for (const arrange of paths) {
      cognitoMock.reset();
      ddbMock.reset();
      allow = new FakeAllowList().add(SUBJECT, EMAIL);
      arrange();
      await createAuthLoginHandler(makeDeps())(makeEvent());
      await createAuthLoginHandler(makeDeps())(makeEvent("stranger@example.com"));
    }
    const scanned = lines.map((l) => l.replace(/"Timestamp":\d+/g, '"Timestamp":0')).join("\n");
    expect(scanned.length).toBeGreaterThan(0);
    expect(scanned).not.toMatch(/@/);
    expect(scanned).not.toMatch(/\d{6,}/);
    expect(scanned).not.toMatch(/[A-Za-z0-9_-]{20,}/);
    for (const secret of [EMAIL, SUBJECT, PHANTOM, "SESSION-VALUE-xyz", SECRET, "stranger"]) {
      expect(scanned).not.toContain(secret);
    }
  });
});

describe("signin_no_self_signup (I9) — grep: SignUpCommand is imported nowhere else", () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../src");

  function sources(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? sources(path.join(dir, e.name))
        : e.name.endsWith(".ts")
          ? [path.join(dir, e.name)]
          : [],
    );
  }

  const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("only the explicit self-signup module under src/lambda/handlers imports SignUpCommand", () => {
    const importers = sources(path.join(SRC, "lambda", "handlers"))
      .filter((f) => /\bSignUpCommand\b/.test(strip(fs.readFileSync(f, "utf8"))))
      .map((f) => path.relative(path.join(SRC, "lambda", "handlers"), f));
    expect(importers).toEqual(["auth-login/self-signup.ts"]);
  });

  it("no other runtime source anywhere in src/ imports it", () => {
    const importers = sources(SRC)
      .filter((f) => /\bSignUpCommand\b/.test(strip(fs.readFileSync(f, "utf8"))))
      .map((f) => path.relative(SRC, f));
    expect(importers).toEqual(["lambda/handlers/auth-login/self-signup.ts"]);
  });

  it("the admin-only code path of auth-login's index does not name SignUp at all", () => {
    const code = strip(fs.readFileSync(path.join(SRC, "lambda/handlers/auth-login/index.ts"), "utf8"));
    expect(code).not.toMatch(/SignUpCommand/);
    // It reaches SignUp only through the self-signup module.
    expect(code).toMatch(/from "\.\/self-signup\.js"/);
  });
});
