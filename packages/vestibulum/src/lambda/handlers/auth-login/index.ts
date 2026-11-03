/**
 * auth-login — regional Lambda endpoint for the magic-link login form.
 *
 * Performs the server-side SignUp + InitiateAuth (CUSTOM_AUTH) that the browser
 * used to call against Cognito directly. Moving it server-side lets us gate the
 * flow behind a per-client-IP rate limit and keep the Cognito client id out of
 * the browser.
 *
 * Browser binding (`signin_link_bound_to_requesting_browser`): the Cognito
 * `Session` NEVER reaches the browser. It is stored server-side under
 * `SHA-256(b)`, where `b` is a fresh 256-bit secret delivered only as an
 * HttpOnly `__Host-signin` cookie. `/auth-verify` can complete the session only
 * for a request that carries that cookie, so a forwarded or intercepted link
 * signs nobody in and consumes nothing.
 *
 * Indistinguishable responses (`signin_request_indistinguishable`): once the
 * request is well-formed, EVERY outcome — session issued, Cognito error,
 * per-IP limit hit, store error — returns the same `202 {}` with a binding
 * cookie, after at least `SIGNIN_FLOOR_MS`. A failed outcome stores a binding
 * row with no session, so redeeming it fails exactly like a wrong answer.
 *
 * Other properties:
 * - Origin header CSRF check (prevents cross-site form submissions).
 * - Per-client-IP rate limit (cost-DoS / enumeration brake).
 * - Enumeration parity: SignUp errors (existing user, disallowed domain via a
 *   PreSignUp rejection) are all swallowed so they're indistinguishable.
 * - No PII in logs (emails never logged; metrics carry closed enums only).
 *
 * Direct Function URL access is blocked by CloudFront Origin Access Control
 * (OAC) at the AWS IAM layer — the Function URL's `authType` is `AWS_IAM` and
 * its resource policy grants `lambda:InvokeFunctionUrl` only to the CloudFront
 * service principal scoped to the exact distribution ARN.
 *
 * @see doc/01-package-design.md §Function URLs and CloudFront routing
 * @see doc/01-package-design.md §Cookie and CSRF posture
 */

import crypto from "crypto";
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  InitiateAuthCommand,
  type InitiateAuthCommandOutput,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { RuntimeEnv } from "../../shared/runtime-env.js";
import {
  DEFAULT_SIGNIN_FLOOR_MS,
  TTL_ATTRIBUTE,
  buildBindingCookie,
  emitSigninMetric,
  hashBindingSecret,
  newBindingSecret,
  parseMs,
  parseTokenTtlMinutes,
  realSleep,
  withFloor,
} from "../../shared/signin.js";
import { tryConsumeIpRateLimit, DEFAULT_LOGINS_PER_WINDOW } from "./ip-rate-limit.js";

// ---------------------------------------------------------------------------
// Lambda Function URL event shapes (minimal — only the fields we need).
// ---------------------------------------------------------------------------

export interface LambdaFunctionUrlEvent {
  readonly headers?: Record<string, string | undefined>;
  readonly body?: string | null;
  readonly requestContext?: {
    readonly http?: {
      readonly method?: string;
    };
  };
}

export interface LambdaFunctionUrlResult {
  statusCode: number;
  headers?: Record<string, string>;
  /**
   * Set-Cookie values. Lambda Function URLs (payload format 2.0) emit cookies
   * ONLY via this `cookies` array, not via `Set-Cookie`/`multiValueHeaders`.
   */
  cookies?: string[];
  body?: string;
}

/**
 * Injectable dependencies for the auth-login handler.
 */
export interface AuthLoginHandlerDeps {
  readonly cognitoClient?: CognitoIdentityProviderClient;
  readonly dynamodb?: DynamoDBClient;
  /** Override clock for tests. Defaults to Date.now(). */
  readonly nowMs?: () => number;
  /** Override the throwaway password generator for tests. */
  readonly randomPassword?: () => string;
  /** Override the binding-secret generator for tests. */
  readonly randomSecret?: () => string;
  /** Sleep used to hold the response floor. Injected in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Returns a 403 response with an empty body. */
function forbidden(): LambdaFunctionUrlResult {
  return { statusCode: 403 };
}

/** Returns the generic 401 authentication-failure response. */
function authFailed(): LambdaFunctionUrlResult {
  return {
    statusCode: 401,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: "Authentication failed" }),
  };
}

/** Returns a generic 400 bad-request response. */
function badRequest(): LambdaFunctionUrlResult {
  return {
    statusCode: 400,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: "Bad request" }),
  };
}

/**
 * Default throwaway password for SignUp. The user never sees or uses it — the
 * actual authentication is the CUSTOM_AUTH magic-link challenge — but Cognito
 * requires a complexity-compliant value. `Aa1!` covers the standard policy
 * (upper, lower, digit, symbol); the random suffix provides entropy.
 */
function defaultRandomPassword(): string {
  return `Aa1!${crypto.randomBytes(24).toString("base64url")}`;
}

/** Closed set of request outcomes, emitted as a metric (never logged per caller). */
type RequestOutcome = "accepted" | "rate_limited" | "auth_error" | "store_error";

/**
 * Create an auth-login Lambda Function URL handler.
 *
 * Flow:
 * 1. Origin header CSRF check (403 on failure; 500-class on missing DOMAIN).
 * 2. Parse JSON body { email } (400 on malformed).
 * 3. Resolve client IP from the LAST x-forwarded-for hop (403 if absent).
 * 4. From here on, hold the response for at least `SIGNIN_FLOOR_MS` and answer
 *    `202 {}` + binding cookie whatever happens:
 *    a. Per-IP rate limit (over limit → no Cognito call, no session).
 *    b. SignUp (errors swallowed for enumeration parity) + InitiateAuth.
 *    c. Store `{ session, username }` under `SHA-256(b)`.
 */
export function createAuthLoginHandler(deps: AuthLoginHandlerDeps = {}) {
  let defaultCognitoClient: CognitoIdentityProviderClient | undefined;
  let defaultDynamoClient: DynamoDBClient | undefined;

  function getCognitoClient(): CognitoIdentityProviderClient {
    if (deps.cognitoClient) return deps.cognitoClient;
    defaultCognitoClient ??= new CognitoIdentityProviderClient({});
    return defaultCognitoClient;
  }

  function getDynamoClient(): DynamoDBClient {
    if (deps.dynamodb) return deps.dynamodb;
    defaultDynamoClient ??= new DynamoDBClient({});
    return defaultDynamoClient;
  }

  const nowMs = deps.nowMs ?? (() => Date.now());
  const randomPassword = deps.randomPassword ?? defaultRandomPassword;
  const randomSecret = deps.randomSecret ?? newBindingSecret;
  const sleep = deps.sleep ?? realSleep;

  /** SignUp (swallowed) + InitiateAuth. Returns null when no session results. */
  async function startAuth(
    clientId: string,
    email: string,
  ): Promise<{ session: string; username: string } | null> {
    // SignUp is idempotent-ish here: a returning user already exists
    // (UsernameExistsException) and a disallowed domain is rejected by the
    // PreSignUp trigger. We swallow ALL SignUp errors so that "already
    // registered", "domain not allowed", and "freshly created" are
    // indistinguishable to the caller — that's the enumeration-parity property.
    try {
      await getCognitoClient().send(
        new SignUpCommand({
          ClientId: clientId,
          Username: email,
          Password: randomPassword(),
          UserAttributes: [{ Name: "email", Value: email }],
        }),
      );
    } catch {
      // Intentionally ignored — see comment above.
    }

    const result: InitiateAuthCommandOutput = await getCognitoClient().send(
      new InitiateAuthCommand({
        AuthFlow: "CUSTOM_AUTH",
        ClientId: clientId,
        AuthParameters: { USERNAME: email },
      }),
    );
    const session = result.Session;
    if (typeof session !== "string" || session === "") return null;
    // RespondToAuthChallenge needs USERNAME. Prefer the value Cognito echoes
    // (the pool's real username, not the address); fall back to the address.
    const echoed = result.ChallengeParameters?.["USERNAME"];
    return { session, username: typeof echoed === "string" && echoed !== "" ? echoed : email };
  }

  return async function handler(event: LambdaFunctionUrlEvent): Promise<LambdaFunctionUrlResult> {
    const headers = event.headers ?? {};

    // ------------------------------------------------------------------
    // 1. CSRF check via Origin header.
    // ------------------------------------------------------------------
    const domain = process.env[RuntimeEnv.DOMAIN];
    if (domain === undefined || domain === "") {
      console.error("auth-login: VESTIBULUM_DOMAIN not set");
      return authFailed();
    }

    const originHeader = headers["origin"];
    if (originHeader === undefined || originHeader === "") {
      return forbidden();
    }
    const expectedOrigin = `https://${domain}`;
    if (originHeader !== expectedOrigin) {
      return forbidden();
    }

    // ------------------------------------------------------------------
    // 2. Parse body { email }.
    // ------------------------------------------------------------------
    let email: string;
    try {
      if (event.body === undefined || event.body === null || event.body === "") {
        return badRequest();
      }
      const parsed = JSON.parse(event.body) as Record<string, unknown>;
      if (typeof parsed["email"] !== "string" || parsed["email"] === "") {
        return badRequest();
      }
      email = parsed["email"];
    } catch {
      return badRequest();
    }

    // ------------------------------------------------------------------
    // 3. Resolve the client IP from x-forwarded-for.
    //
    // CloudFront appends the real viewer IP as the LAST hop of
    // x-forwarded-for. Earlier entries can be spoofed by the client (they
    // arrive in the request the viewer controls), but CloudFront overwrites /
    // appends the genuine source IP at the end, so the last comma-separated
    // entry is the trustworthy, un-spoofable one to rate-limit on. The endpoint
    // is only reachable via CloudFront (OAC), which always sets this header, so
    // an absent/empty value means something is wrong — fail closed.
    // ------------------------------------------------------------------
    const xff = headers["x-forwarded-for"];
    if (xff === undefined || xff.trim() === "") {
      return forbidden();
    }
    const parts = xff.split(",");
    const clientIp = (parts[parts.length - 1] ?? "").trim();
    if (clientIp === "") {
      return forbidden();
    }

    // Deployment configuration. A misconfigured function fails the same way for
    // every caller, so this reveals nothing about any address.
    const rateLimitTable = process.env[RuntimeEnv.RATE_LIMIT_TABLE_NAME];
    const bindingTable = process.env[RuntimeEnv.BINDING_TABLE_NAME];
    const clientId = process.env[RuntimeEnv.COGNITO_CLIENT_ID];
    const ttlMinutes = parseTokenTtlMinutes(process.env[RuntimeEnv.TOKEN_TTL_MINUTES]);
    if (
      rateLimitTable === undefined ||
      rateLimitTable === "" ||
      bindingTable === undefined ||
      bindingTable === "" ||
      clientId === undefined ||
      clientId === "" ||
      ttlMinutes === undefined
    ) {
      console.error("auth-login: required configuration missing or invalid");
      return authFailed();
    }
    const limit = parseInt(
      process.env[RuntimeEnv.LOGIN_IP_PER_WINDOW] ?? String(DEFAULT_LOGINS_PER_WINDOW),
      10,
    );
    const floorMs = parseMs(process.env[RuntimeEnv.SIGNIN_FLOOR_MS], DEFAULT_SIGNIN_FLOOR_MS);

    // ------------------------------------------------------------------
    // 4. From here every outcome is the same 202, after the floor.
    // ------------------------------------------------------------------
    return withFloor(floorMs, nowMs, sleep, async () => {
      const secret = randomSecret();
      const bindingHash = hashBindingSecret(secret);
      let outcome: RequestOutcome = "accepted";
      let started: { session: string; username: string } | null = null;

      try {
        const allowed = await tryConsumeIpRateLimit({
          client: getDynamoClient(),
          tableName: rateLimitTable,
          ip: clientIp,
          limit,
          nowMs: nowMs(),
        });
        if (allowed) {
          started = await startAuth(clientId, email);
          if (started === null) outcome = "auth_error";
        } else {
          outcome = "rate_limited";
        }
      } catch {
        // Never log the address or the error body: closed enum only.
        outcome = "auth_error";
        started = null;
      }

      // The row is written even with no session, so the redeem path and its
      // timing do not depend on whether Cognito produced one.
      try {
        await getDynamoClient().send(
          new PutItemCommand({
            TableName: bindingTable,
            Item: {
              binding_hash: { S: bindingHash },
              [TTL_ATTRIBUTE]: { N: String(Math.floor(nowMs() / 1000) + ttlMinutes * 60) },
              ...(started !== null
                ? { session: { S: started.session }, username: { S: started.username } }
                : {}),
            },
            ConditionExpression: "attribute_not_exists(binding_hash)",
          }),
        );
      } catch {
        outcome = "store_error";
      }

      emitSigninMetric("SignInRequest", { outcome });

      return {
        statusCode: 202,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        cookies: [buildBindingCookie(secret, ttlMinutes * 60)],
        body: "{}",
      };
    });
  };
}
