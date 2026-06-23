/**
 * Tests for the auth-login Function URL handler
 * (`src/lambda/handlers/auth-login/index.ts`).
 *
 * Covers the CSRF/Origin gate, body parsing, the x-forwarded-for last-hop IP
 * resolution and fail-closed posture, the per-IP rate limit (including that an
 * over-limit attempt never touches Cognito), the SignUp enumeration-parity
 * swallow, and the InitiateAuth session outcomes.
 *
 * Determinism: Cognito + DynamoDB are mocked at the SDK boundary via
 * aws-sdk-client-mock; the clock is injected via the handler's `nowMs` dep.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  InitiateAuthCommand,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  DynamoDBClient,
  UpdateItemCommand,
  ConditionalCheckFailedException,
} from "@aws-sdk/client-dynamodb";

import {
  createAuthLoginHandler,
  type LambdaFunctionUrlEvent,
} from "../../../../src/lambda/handlers/auth-login/index.js";
import { RuntimeEnv } from "../../../../src/lambda/shared/runtime-env.js";

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const ddbMock = mockClient(DynamoDBClient);

const DOMAIN = "app.example.com";
const CLIENT_ID = "test-client-id";
const RATE_TABLE = "magic-link-rate-limit";
const EMAIL = "user@example.com";
const FIXED_NOW_MS = 1_700_000_000_000;

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

function makeDeps() {
  return {
    cognitoClient: cognitoMock as unknown as CognitoIdentityProviderClient,
    dynamodb: ddbMock as unknown as DynamoDBClient,
    nowMs: () => FIXED_NOW_MS,
    randomPassword: () => "Aa1!fixedpassword",
  };
}

beforeEach(() => {
  cognitoMock.reset();
  ddbMock.reset();
  process.env[RuntimeEnv.DOMAIN] = DOMAIN;
  process.env[RuntimeEnv.COGNITO_CLIENT_ID] = CLIENT_ID;
  process.env[RuntimeEnv.RATE_LIMIT_TABLE_NAME] = RATE_TABLE;
  Reflect.deleteProperty(process.env, RuntimeEnv.LOGIN_IP_PER_WINDOW);
});

afterEach(() => {
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
    expect(result.statusCode).not.toBe(200);
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
    ddbMock.on(UpdateItemCommand).resolves({});
    cognitoMock.on(SignUpCommand).resolves({});
    cognitoMock.on(InitiateAuthCommand).resolves({ Session: "sess-1" });

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

describe("createAuthLoginHandler — per-IP rate limit", () => {
  it("proceeds to Cognito when under the limit", async () => {
    ddbMock.on(UpdateItemCommand).resolves({});
    cognitoMock.on(SignUpCommand).resolves({});
    cognitoMock.on(InitiateAuthCommand).resolves({ Session: "sess-ok" });

    const handler = createAuthLoginHandler(makeDeps());
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    expect(cognitoMock.commandCalls(InitiateAuthCommand)).toHaveLength(1);
  });

  it("returns 429 and does NOT call Cognito when over the limit", async () => {
    // The limiter's conditional UpdateItem fails → over budget.
    ddbMock.on(UpdateItemCommand).rejects(
      new ConditionalCheckFailedException({ message: "over", $metadata: {} }),
    );

    const handler = createAuthLoginHandler(makeDeps());
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(429);
    expect(JSON.parse(result.body!)).toEqual({ error: "Too many requests" });
    expect(cognitoMock.commandCalls(SignUpCommand)).toHaveLength(0);
    expect(cognitoMock.commandCalls(InitiateAuthCommand)).toHaveLength(0);
  });

  it("admits the first `limit` attempts and rejects the (limit+1)th (server-side boundary simulated)", async () => {
    // Simulate the table admitting the first 10 and rejecting the 11th, the way
    // the real conditional UpdateItem would.
    let count = 0;
    const LIMIT = 10;
    process.env[RuntimeEnv.LOGIN_IP_PER_WINDOW] = String(LIMIT);
    ddbMock.on(UpdateItemCommand).callsFake(() => {
      count += 1;
      if (count > LIMIT) {
        throw new ConditionalCheckFailedException({ message: "over", $metadata: {} });
      }
      return {};
    });
    cognitoMock.on(SignUpCommand).resolves({});
    cognitoMock.on(InitiateAuthCommand).resolves({ Session: "sess" });

    const handler = createAuthLoginHandler(makeDeps());
    for (let i = 0; i < LIMIT; i++) {
      const r = await handler(makeEvent());
      expect(r.statusCode).toBe(200);
    }
    const over = await handler(makeEvent());
    expect(over.statusCode).toBe(429);
  });

  it("returns non-200 when the rate-limit table env is unset", async () => {
    Reflect.deleteProperty(process.env, RuntimeEnv.RATE_LIMIT_TABLE_NAME);
    const handler = createAuthLoginHandler(makeDeps());
    const result = await handler(makeEvent());
    expect(result.statusCode).not.toBe(200);
  });
});

describe("createAuthLoginHandler — Cognito flow", () => {
  it("swallows SignUp UsernameExistsException and still returns 200 with session", async () => {
    ddbMock.on(UpdateItemCommand).resolves({});
    cognitoMock.on(SignUpCommand).rejects(
      new UsernameExistsException({ message: "exists", $metadata: {} }),
    );
    cognitoMock.on(InitiateAuthCommand).resolves({ Session: "sess-existing" });

    const handler = createAuthLoginHandler(makeDeps());
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toEqual({ session: "sess-existing" });
    expect(cognitoMock.commandCalls(InitiateAuthCommand)).toHaveLength(1);
  });

  it("returns 200 { session } when InitiateAuth returns a Session", async () => {
    ddbMock.on(UpdateItemCommand).resolves({});
    cognitoMock.on(SignUpCommand).resolves({});
    cognitoMock.on(InitiateAuthCommand).resolves({ Session: "the-session" });

    const handler = createAuthLoginHandler(makeDeps());
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toEqual({ session: "the-session" });
  });

  it("passes the SignUp username/email and a generated password", async () => {
    ddbMock.on(UpdateItemCommand).resolves({});
    cognitoMock.on(SignUpCommand).resolves({});
    cognitoMock.on(InitiateAuthCommand).resolves({ Session: "s" });

    const handler = createAuthLoginHandler(makeDeps());
    await handler(makeEvent());

    const signup = cognitoMock.commandCalls(SignUpCommand)[0]!;
    expect(signup.args[0].input.Username).toBe(EMAIL);
    expect(signup.args[0].input.Password).toBe("Aa1!fixedpassword");
    expect(signup.args[0].input.UserAttributes).toEqual([{ Name: "email", Value: EMAIL }]);
  });

  it("returns a generic non-200 when InitiateAuth returns no Session", async () => {
    ddbMock.on(UpdateItemCommand).resolves({});
    cognitoMock.on(SignUpCommand).resolves({});
    cognitoMock.on(InitiateAuthCommand).resolves({}); // no Session

    const handler = createAuthLoginHandler(makeDeps());
    const result = await handler(makeEvent());
    expect(result.statusCode).not.toBe(200);
    expect(result.statusCode).toBe(401);
  });

  it("returns a generic non-200 when InitiateAuth throws", async () => {
    ddbMock.on(UpdateItemCommand).resolves({});
    cognitoMock.on(SignUpCommand).resolves({});
    cognitoMock.on(InitiateAuthCommand).rejects(new Error("boom"));

    const handler = createAuthLoginHandler(makeDeps());
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(401);
  });

  it("returns a non-200 when the Cognito client id env is unset", async () => {
    Reflect.deleteProperty(process.env, RuntimeEnv.COGNITO_CLIENT_ID);
    ddbMock.on(UpdateItemCommand).resolves({});
    const handler = createAuthLoginHandler(makeDeps());
    const result = await handler(makeEvent());
    expect(result.statusCode).not.toBe(200);
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
