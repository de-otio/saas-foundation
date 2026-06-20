/**
 * auth-login — regional Lambda endpoint for the magic-link login form.
 *
 * Performs the server-side SignUp + InitiateAuth (CUSTOM_AUTH) that the browser
 * used to call against Cognito directly. Moving it server-side lets us gate the
 * flow behind a per-client-IP rate limit and keep the Cognito client id out of
 * the browser.
 *
 * Security properties enforced here:
 * - Origin header CSRF check (prevents cross-site form submissions).
 * - Per-client-IP rate limit (cost-DoS / enumeration brake).
 * - Generic error responses (prevents distinguishing failure modes).
 * - Enumeration parity: SignUp errors (existing user, disallowed domain via a
 *   PreSignUp rejection) are all swallowed so they're indistinguishable.
 * - No PII in logs (emails HMAC-hashed, IPs never logged raw).
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
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { RuntimeEnv } from "../../shared/runtime-env.js";
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

/** Returns a generic 429 too-many-requests response. */
function tooManyRequests(): LambdaFunctionUrlResult {
  return {
    statusCode: 429,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: "Too many requests" }),
  };
}

/** HMAC-hashes an email address for safe logging (never log raw PII). */
function hashEmail(email: string): string {
  const key = process.env[RuntimeEnv.DOMAIN] ?? "vestibulum-log-key";
  return crypto.createHmac("sha256", key).update(email).digest("hex").slice(0, 12);
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

/**
 * Create an auth-login Lambda Function URL handler.
 *
 * Flow:
 * 1. Origin header CSRF check (403 on failure; 500-class on missing DOMAIN).
 * 2. Parse JSON body { email } (400 on malformed).
 * 3. Resolve client IP from the LAST x-forwarded-for hop (403 if absent).
 * 4. Per-IP rate limit (429 when over).
 * 5. SignUp (errors swallowed for enumeration parity) + InitiateAuth.
 * 6. Return { session } on success; generic auth-failed otherwise.
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

    // ------------------------------------------------------------------
    // 4. Per-IP rate limit.
    // ------------------------------------------------------------------
    const rateLimitTable = process.env[RuntimeEnv.RATE_LIMIT_TABLE_NAME];
    if (rateLimitTable === undefined || rateLimitTable === "") {
      console.error("auth-login: VESTIBULUM_RATE_LIMIT_TABLE not set");
      return authFailed();
    }
    const limit = parseInt(process.env[RuntimeEnv.LOGIN_IP_PER_WINDOW] ?? String(DEFAULT_LOGINS_PER_WINDOW), 10);

    const allowed = await tryConsumeIpRateLimit({
      client: getDynamoClient(),
      tableName: rateLimitTable,
      ip: clientIp,
      limit,
      nowMs: nowMs(),
    });
    if (!allowed) {
      return tooManyRequests();
    }

    // ------------------------------------------------------------------
    // 5. SignUp + InitiateAuth.
    // ------------------------------------------------------------------
    const clientId = process.env[RuntimeEnv.COGNITO_CLIENT_ID];
    if (clientId === undefined || clientId === "") {
      console.error("auth-login: VESTIBULUM_CLIENT_ID not set");
      return authFailed();
    }

    // SignUp is idempotent-ish here: a returning user already exists
    // (UsernameExistsException) and a disallowed domain is rejected by the
    // PreSignUp trigger. We swallow ALL SignUp errors so that "already
    // registered", "domain not allowed", and "freshly created" are
    // indistinguishable to the caller — that's the enumeration-parity property.
    // InitiateAuth below is the single observable outcome.
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

    let initiateResult: InitiateAuthCommandOutput;
    try {
      initiateResult = await getCognitoClient().send(
        new InitiateAuthCommand({
          AuthFlow: "CUSTOM_AUTH",
          ClientId: clientId,
          AuthParameters: { USERNAME: email },
        }),
      );
    } catch {
      console.error(`auth-login: InitiateAuth error for email-hash=${hashEmail(email)}`);
      return authFailed();
    }

    const session = initiateResult.Session;
    if (typeof session !== "string" || session === "") {
      console.error(`auth-login: missing Session for email-hash=${hashEmail(email)}`);
      return authFailed();
    }

    // ------------------------------------------------------------------
    // 6. Return the Cognito session for the browser to answer the challenge.
    // ------------------------------------------------------------------
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session }),
    };
  };
}
