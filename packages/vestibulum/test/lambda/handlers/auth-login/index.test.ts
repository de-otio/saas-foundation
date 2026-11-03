/**
 * Tests for the auth-login Function URL handler
 * (`src/lambda/handlers/auth-login/index.ts`).
 *
 * Invariants (dot-notes doc/topics/passwordless-sign-in-aws/02-spec.md):
 *   signin_link_bound_to_requesting_browser   session is held server-side under H(b); b is an HttpOnly __Host- cookie
 *   signin_request_indistinguishable          one response for every caller class, after the floor
 *   signin_token_at_rest_hashed               the binding row is keyed by H(b); b is never stored
 *   signin_secrets_never_logged               no address / session / secret in any log line
 *
 * Plus the endpoint's existing gates: CSRF/Origin, body parsing, last-hop
 * x-forwarded-for, per-IP rate limit (an over-limit attempt never touches Cognito).
 *
 * Determinism: Cognito + DynamoDB are mocked at the SDK boundary via
 * aws-sdk-client-mock; the clock, sleep and secret generator are injected.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { mockClient } from "aws-sdk-client-mock";
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  InitiateAuthCommand,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  ConditionalCheckFailedException,
} from "@aws-sdk/client-dynamodb";

import {
  createAuthLoginHandler,
  type LambdaFunctionUrlEvent,
  type LambdaFunctionUrlResult,
} from "../../../../src/lambda/handlers/auth-login/index.js";
import { RuntimeEnv } from "../../../../src/lambda/shared/runtime-env.js";
import {
  BINDING_COOKIE_NAME,
  DEFAULT_SIGNIN_FLOOR_MS,
  TTL_ATTRIBUTE,
  hashBindingSecret,
} from "../../../../src/lambda/shared/signin.js";

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const ddbMock = mockClient(DynamoDBClient);

const DOMAIN = "app.example.com";
const CLIENT_ID = "test-client-id";
const RATE_TABLE = "magic-link-rate-limit";
const BINDING_TABLE = "magic-link-binding";
const EMAIL = "user@example.com";
const FIXED_NOW_MS = 1_700_000_000_000;
const SECRET = "S".repeat(43);

function makeEvent(overrides: Omit<Partial<LambdaFunctionUrlEvent>, "body"> & {
  // `body` redeclared (not via Partial) so an explicit `body: undefined` is
  // allowed under exactOptionalPropertyTypes — the "missing body" test case.
  body?: string | null | undefined;
  origin?: string | undefined;
  xff?: string | undefined;
  bodyObj?: unknown;
} = {}): LambdaFunctionUrlEvent {
  const headers: Record<string, string | undefined> = {};
  if (!("origin" in overrides) || overrides.origin !== undefined) {
    headers["origin"] = overrides.origin ?? `https://${DOMAIN}`;
  }
  if (!("xff" in overrides) || overrides.xff !== undefined) {
    headers["x-forwarded-for"] = overrides.xff ?? "203.0.113.7";
  }
  let body: string | null | undefined;
  if ("body" in overrides) {
    body = overrides.body;
  } else if ("bodyObj" in overrides) {
    body = JSON.stringify(overrides.bodyObj);
  } else {
    body = JSON.stringify({ email: EMAIL });
  }
  // Spread body in only when defined (the "missing body" case omits it) — the
  // event's `body` is readonly and exactOptionalPropertyTypes forbids assigning
  // `undefined`.
  return { headers, ...(body !== undefined ? { body } : {}) };
}

const sleeps: number[] = [];

function makeDeps(extra: { randomSecret?: () => string } = {}) {
  return {
    cognitoClient: cognitoMock as unknown as CognitoIdentityProviderClient,
    dynamodb: ddbMock as unknown as DynamoDBClient,
    nowMs: () => FIXED_NOW_MS,
    randomPassword: () => "Aa1!fixedpassword",
    randomSecret: extra.randomSecret ?? (() => SECRET),
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
}

/** The happy-path arrangement most tests start from. */
function arrangeHappy(session = "sess-1", username = "11111111-2222-3333-4444-555555555555") {
  ddbMock.on(UpdateItemCommand).resolves({});
  ddbMock.on(PutItemCommand).resolves({});
  cognitoMock.on(SignUpCommand).resolves({});
  cognitoMock.on(InitiateAuthCommand).resolves({
    Session: session,
    ChallengeParameters: { USERNAME: username },
  });
}

const bindingPuts = () => ddbMock.commandCalls(PutItemCommand);

beforeEach(() => {
  cognitoMock.reset();
  ddbMock.reset();
  sleeps.length = 0;
  process.env[RuntimeEnv.DOMAIN] = DOMAIN;
  process.env[RuntimeEnv.COGNITO_CLIENT_ID] = CLIENT_ID;
  process.env[RuntimeEnv.RATE_LIMIT_TABLE_NAME] = RATE_TABLE;
  process.env[RuntimeEnv.BINDING_TABLE_NAME] = BINDING_TABLE;
  Reflect.deleteProperty(process.env, RuntimeEnv.TOKEN_TTL_MINUTES);
  Reflect.deleteProperty(process.env, RuntimeEnv.SIGNIN_FLOOR_MS);
  Reflect.deleteProperty(process.env, RuntimeEnv.LOGIN_IP_PER_WINDOW);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  cognitoMock.reset();
  ddbMock.reset();
});

describe("createAuthLoginHandler — CSRF / Origin gate", () => {
  it("returns 403 when the Origin header is missing", async () => {
    const handler = createAuthLoginHandler(makeDeps());
    const result = await handler(makeEvent({ origin: undefined }));
    expect(result.statusCode).toBe(403);
  });

  it("returns 403 when the Origin header is wrong", async () => {
    const handler = createAuthLoginHandler(makeDeps());
    const result = await handler(makeEvent({ origin: "https://evil.example" }));
    expect(result.statusCode).toBe(403);
  });

  it("returns a non-200 when DOMAIN is unset", async () => {
    Reflect.deleteProperty(process.env, RuntimeEnv.DOMAIN);
    const handler = createAuthLoginHandler(makeDeps());
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(401);
  });
});

describe("createAuthLoginHandler — x-forwarded-for resolution", () => {
  it("returns 403 when x-forwarded-for is absent", async () => {
    const handler = createAuthLoginHandler(makeDeps());
    const result = await handler(makeEvent({ xff: undefined }));
    expect(result.statusCode).toBe(403);
  });

  it("returns 403 when x-forwarded-for is empty/whitespace", async () => {
    const handler = createAuthLoginHandler(makeDeps());
    const result = await handler(makeEvent({ xff: "   " }));
    expect(result.statusCode).toBe(403);
  });

  it("uses the LAST x-forwarded-for hop as the rate-limit key", async () => {
    arrangeHappy();

    const handler = createAuthLoginHandler(makeDeps());
    // Client-spoofed earlier hops, real viewer IP appended last by CloudFront.
    await handler(makeEvent({ xff: "1.1.1.1, 2.2.2.2, 198.51.100.42" }));

    const call = ddbMock.commandCalls(UpdateItemCommand)[0]!;
    const key = (call.args[0].input.Key as { bucket_id: { S: string } }).bucket_id.S;

    // Recompute the expected bucket from the LAST hop only.
    const { createHash } = await import("crypto");
    const windowMs = 15 * 60 * 1000;
    const windowStart = Math.floor(FIXED_NOW_MS / windowMs) * windowMs;
    const expected = createHash("sha256")
      .update(`login-ip:198.51.100.42#${windowStart}`)
      .digest("hex");
    expect(key).toBe(expected);
  });
});

describe("createAuthLoginHandler — body parsing", () => {
  it("returns 400 on a missing body", async () => {
    const handler = createAuthLoginHandler(makeDeps());
    const result = await handler(makeEvent({ body: undefined }));
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body!)).toEqual({ error: "Bad request" });
  });

  it("returns 400 on malformed JSON", async () => {
    const handler = createAuthLoginHandler(makeDeps());
    const result = await handler(makeEvent({ body: "{not json" }));
    expect(result.statusCode).toBe(400);
  });

  it("returns 400 when email is missing/not a string", async () => {
    const handler = createAuthLoginHandler(makeDeps());
    const result = await handler(makeEvent({ bodyObj: { notEmail: 1 } }));
    expect(result.statusCode).toBe(400);
  });
});

describe("signin_link_bound_to_requesting_browser — what the request hands out", () => {
  it("answers 202 {} and sets exactly the HttpOnly __Host- binding cookie", async () => {
    arrangeHappy();
    const result = await createAuthLoginHandler(makeDeps())(makeEvent());

    expect(result.statusCode).toBe(202);
    expect(result.body).toBe("{}");
    expect(result.cookies).toHaveLength(1);
    const cookie = result.cookies![0]!;
    expect(cookie.startsWith(`${BINDING_COOKIE_NAME}=${SECRET};`)).toBe(true);
    // __Host- rules: Secure, Path=/, and NO Domain attribute.
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toMatch(/Domain=/i);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=600");
  });

  it("never returns the Cognito Session (or the username) to the browser", async () => {
    arrangeHappy("SESSION-VALUE-xyz", "the-cognito-username");
    const result = await createAuthLoginHandler(makeDeps())(makeEvent());
    const wire = JSON.stringify(result);
    expect(wire).not.toContain("SESSION-VALUE-xyz");
    expect(wire).not.toContain("the-cognito-username");
    expect(result.body).toBe("{}");
  });

  it("stores the session server-side under H(b), with expires_at, and not b itself", async () => {
    arrangeHappy("SESSION-VALUE-xyz", "the-cognito-username");
    await createAuthLoginHandler(makeDeps())(makeEvent());

    expect(bindingPuts()).toHaveLength(1);
    const input = bindingPuts()[0]!.args[0].input;
    expect(input.TableName).toBe(BINDING_TABLE);
    expect(input.Item).toEqual({
      binding_hash: { S: hashBindingSecret(SECRET) },
      [TTL_ATTRIBUTE]: { N: String(FIXED_NOW_MS / 1000 + 600) },
      session: { S: "SESSION-VALUE-xyz" },
      username: { S: "the-cognito-username" },
    });
    // signin_token_at_rest_hashed: the secret is in no stored attribute.
    expect(JSON.stringify(input.Item)).not.toContain(SECRET);
    // Create-only, so a colliding key can never overwrite someone's pending request.
    expect(input.ConditionExpression).toBe("attribute_not_exists(binding_hash)");
  });

  it("uses a fresh secret per request (signin_latest_request_wins depends on it)", async () => {
    arrangeHappy();
    let n = 0;
    const handler = createAuthLoginHandler(
      makeDeps({ randomSecret: () => `secret-${(n += 1)}`.padEnd(43, "x") }),
    );
    const a = await handler(makeEvent());
    const b = await handler(makeEvent());
    expect(a.cookies![0]).not.toBe(b.cookies![0]);
    expect(bindingPuts().map((c) => c.args[0].input.Item?.["binding_hash"]?.S)).toHaveLength(2);
    expect(new Set(bindingPuts().map((c) => c.args[0].input.Item?.["binding_hash"]?.S)).size).toBe(2);
  });

  it("the binding lifetime follows VESTIBULUM_TOKEN_TTL_MINUTES (cookie and row)", async () => {
    process.env[RuntimeEnv.TOKEN_TTL_MINUTES] = "5";
    arrangeHappy();
    const result = await createAuthLoginHandler(makeDeps())(makeEvent());
    expect(result.cookies![0]).toContain("Max-Age=300");
    expect(bindingPuts()[0]!.args[0].input.Item?.[TTL_ATTRIBUTE]).toEqual({
      N: String(FIXED_NOW_MS / 1000 + 300),
    });
  });

  it.each(["2", "16", "abc"])("refuses to run with an invalid lifetime (%s)", async (bad) => {
    process.env[RuntimeEnv.TOKEN_TTL_MINUTES] = bad;
    arrangeHappy();
    const result = await createAuthLoginHandler(makeDeps())(makeEvent());
    expect(result.statusCode).toBe(401);
    expect(cognitoMock.calls()).toHaveLength(0);
  });
});

describe("signin_request_indistinguishable", () => {
  type Arrange = () => void;
  const classes: ReadonlyArray<readonly [string, Arrange]> = [
    ["eligible", () => arrangeHappy()],
    [
      "existing user (SignUp says exists)",
      () => {
        arrangeHappy();
        cognitoMock
          .on(SignUpCommand)
          .rejects(new UsernameExistsException({ message: "exists", $metadata: {} }));
      },
    ],
    [
      "Cognito disabled / not authorised (InitiateAuth throws)",
      () => {
        arrangeHappy();
        cognitoMock.on(InitiateAuthCommand).rejects(new Error("NotAuthorizedException"));
      },
    ],
    [
      "no Session returned",
      () => {
        arrangeHappy();
        cognitoMock.on(InitiateAuthCommand).resolves({});
      },
    ],
    [
      "per-IP rate limited",
      () => {
        arrangeHappy();
        ddbMock
          .on(UpdateItemCommand)
          .rejects(new ConditionalCheckFailedException({ message: "over", $metadata: {} }));
      },
    ],
    [
      "dependency error in the limiter",
      () => {
        arrangeHappy();
        ddbMock.on(UpdateItemCommand).rejects(new Error("ddb down"));
      },
    ],
    [
      "binding store error",
      () => {
        arrangeHappy();
        ddbMock.on(PutItemCommand).rejects(new Error("ddb down"));
      },
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
          .map((p, i) => (i === 0 ? p.split("=")[0] : p)) // drop the cookie VALUE
          .join("; "),
      ),
    };
  }

  async function run(arrange: Arrange, email: string) {
    cognitoMock.reset();
    ddbMock.reset();
    sleeps.length = 0;
    arrange();
    const result = await createAuthLoginHandler(makeDeps())(
      makeEvent({ bodyObj: { email } }),
    );
    return { result, sleeps: [...sleeps] };
  }

  it("P: every caller class × any address yields the same observable response", async () => {
    const baseline = observable((await run(classes[0]![1], EMAIL)).result);
    expect(baseline.status).toBe(202);

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...classes),
        fc.emailAddress(),
        async ([, arrange], email) => {
          const { result } = await run(arrange, email);
          expect(observable(result)).toEqual(baseline);
        },
      ),
      { numRuns: 120 },
    );
  });

  it.each(classes)("%s: waits for the floor (frozen clock → sleeps the whole floor)", async (_n, arrange) => {
    const { sleeps: s } = await run(arrange, EMAIL);
    expect(s).toEqual([DEFAULT_SIGNIN_FLOOR_MS]);
  });

  it("honours VESTIBULUM_SIGNIN_FLOOR_MS", async () => {
    process.env[RuntimeEnv.SIGNIN_FLOOR_MS] = "2500";
    const { sleeps: s } = await run(classes[0]![1], EMAIL);
    expect(s).toEqual([2500]);
  });

  it("a failed outcome still stores a binding row (with no session), so redeem looks the same", async () => {
    const failing = classes.find(([n]) => n.startsWith("Cognito disabled"))![1];
    await run(failing, EMAIL);
    expect(bindingPuts()).toHaveLength(1);
    const item = bindingPuts()[0]!.args[0].input.Item!;
    expect(item).not.toHaveProperty("session");
    expect(item["binding_hash"]).toEqual({ S: hashBindingSecret(SECRET) });
  });
});

describe("createAuthLoginHandler — per-IP rate limit", () => {
  it("proceeds to Cognito when under the limit", async () => {
    arrangeHappy();
    const result = await createAuthLoginHandler(makeDeps())(makeEvent());
    expect(result.statusCode).toBe(202);
    expect(cognitoMock.commandCalls(InitiateAuthCommand)).toHaveLength(1);
  });

  it("does NOT call Cognito when over the limit (and still answers the uniform 202)", async () => {
    // The limiter's conditional UpdateItem fails → over budget.
    arrangeHappy();
    ddbMock.on(UpdateItemCommand).rejects(
      new ConditionalCheckFailedException({ message: "over", $metadata: {} }),
    );

    const result = await createAuthLoginHandler(makeDeps())(makeEvent());
    expect(result.statusCode).toBe(202);
    expect(cognitoMock.commandCalls(SignUpCommand)).toHaveLength(0);
    expect(cognitoMock.commandCalls(InitiateAuthCommand)).toHaveLength(0);
  });

  it("admits the first `limit` attempts to Cognito and not the (limit+1)th", async () => {
    // Simulate the table admitting the first 10 and rejecting the 11th, the way
    // the real conditional UpdateItem would.
    let count = 0;
    const LIMIT = 10;
    process.env[RuntimeEnv.LOGIN_IP_PER_WINDOW] = String(LIMIT);
    arrangeHappy();
    ddbMock.on(UpdateItemCommand).callsFake(() => {
      count += 1;
      if (count > LIMIT) {
        throw new ConditionalCheckFailedException({ message: "over", $metadata: {} });
      }
      return {};
    });

    const handler = createAuthLoginHandler(makeDeps());
    for (let i = 0; i < LIMIT + 1; i++) {
      await handler(makeEvent());
    }
    expect(cognitoMock.commandCalls(InitiateAuthCommand)).toHaveLength(LIMIT);
  });

  it.each([RuntimeEnv.RATE_LIMIT_TABLE_NAME, RuntimeEnv.BINDING_TABLE_NAME, RuntimeEnv.COGNITO_CLIENT_ID])(
    "fails (non-200) when %s is unset",
    async (name) => {
      Reflect.deleteProperty(process.env, name);
      arrangeHappy();
      const result = await createAuthLoginHandler(makeDeps())(makeEvent());
      expect(result.statusCode).toBe(401);
    },
  );
});

describe("createAuthLoginHandler — Cognito flow", () => {
  it("swallows SignUp UsernameExistsException and still proceeds to InitiateAuth", async () => {
    arrangeHappy("sess-existing");
    cognitoMock.on(SignUpCommand).rejects(
      new UsernameExistsException({ message: "exists", $metadata: {} }),
    );

    const result = await createAuthLoginHandler(makeDeps())(makeEvent());
    expect(result.statusCode).toBe(202);
    expect(cognitoMock.commandCalls(InitiateAuthCommand)).toHaveLength(1);
    expect(bindingPuts()[0]!.args[0].input.Item?.["session"]).toEqual({ S: "sess-existing" });
  });

  it("passes the SignUp username/email and a generated password", async () => {
    arrangeHappy();
    await createAuthLoginHandler(makeDeps())(makeEvent());

    const signup = cognitoMock.commandCalls(SignUpCommand)[0]!;
    expect(signup.args[0].input.Username).toBe(EMAIL);
    expect(signup.args[0].input.Password).toBe("Aa1!fixedpassword");
    expect(signup.args[0].input.UserAttributes).toEqual([{ Name: "email", Value: EMAIL }]);
  });

  it("falls back to the address as USERNAME when Cognito does not echo one", async () => {
    arrangeHappy();
    cognitoMock.on(InitiateAuthCommand).resolves({ Session: "s" });
    await createAuthLoginHandler(makeDeps())(makeEvent());
    expect(bindingPuts()[0]!.args[0].input.Item?.["username"]).toEqual({ S: EMAIL });
  });
});

describe("signin_secrets_never_logged", () => {
  it("emits no address, session, secret or digit run on any path", async () => {
    const lines: string[] = [];
    vi.restoreAllMocks();
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));

    const paths: Array<() => void> = [
      () => arrangeHappy("SESSION-VALUE-xyz"),
      () => {
        arrangeHappy("SESSION-VALUE-xyz");
        cognitoMock.on(InitiateAuthCommand).rejects(new Error(`boom for ${EMAIL}`));
      },
      () => {
        arrangeHappy("SESSION-VALUE-xyz");
        ddbMock.on(PutItemCommand).rejects(new Error(`store error for ${EMAIL}`));
      },
    ];
    for (const arrange of paths) {
      cognitoMock.reset();
      ddbMock.reset();
      arrange();
      await createAuthLoginHandler(makeDeps())(makeEvent());
    }

    // EMF metric lines carry a millisecond timestamp by design; drop only that field.
    const scanned = lines
      .map((l) => l.replace(/"Timestamp":\d+/g, '"Timestamp":0'))
      .join("\n");
    expect(scanned).not.toMatch(/@/);
    expect(scanned).not.toMatch(/\d{6,}/);
    expect(scanned).not.toMatch(/[A-Za-z0-9_-]{20,}/);
    expect(scanned).not.toContain("SESSION-VALUE-xyz");
    expect(scanned).not.toContain(SECRET);
    expect(scanned).not.toContain("token=");
    expect(scanned).not.toContain("#t=");
  });
});

describe("createAuthLoginHandler — default deps construction", () => {
  it("constructs without injected deps (lazy default clients)", () => {
    // Just exercising the factory with no deps so the default-client branches
    // are constructed; we don't invoke real AWS here.
    const handler = createAuthLoginHandler();
    expect(typeof handler).toBe("function");
  });
});
