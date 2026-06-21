/**
 * auth-verify — regional Lambda endpoint for magic-link verification.
 *
 * Receives the client-side POST after the user clicks the magic link, calls
 * Cognito RespondToAuthChallenge, and sets the ID-token and refresh-token
 * cookies on success.
 *
 * Security properties enforced here:
 * - Origin header CSRF check (prevents cross-site form submissions).
 * - Generic error responses (prevents distinguishing failure modes).
 * - No PII in logs (emails HMAC-hashed before any log statement).
 *
 * Direct Function URL access is blocked by CloudFront Origin Access Control
 * (OAC) at the AWS IAM layer — the Function URL's `authType` is `AWS_IAM`
 * and its resource policy grants `lambda:InvokeFunctionUrl` only to the
 * CloudFront service principal scoped to the exact distribution ARN.
 *
 * @see doc/01-package-design.md §Function URLs and CloudFront routing
 * @see doc/01-package-design.md §Cookie and CSRF posture
 */

import crypto from "crypto";
import {
  CognitoIdentityProviderClient,
  RespondToAuthChallengeCommand,
  type RespondToAuthChallengeCommandOutput,
} from "@aws-sdk/client-cognito-identity-provider";
import { RuntimeEnv } from "../../shared/runtime-env.js";
import { buildSetCookie } from "./cookie.js";
import { ID_TOKEN_COOKIE_NAME, REFRESH_TOKEN_COOKIE_NAME } from "../../shared/cookie-names.js";

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
   * ONLY via this `cookies` array, not via `Set-Cookie`/`multiValueHeaders`
   * (those are silently dropped on a Function URL). See AWS docs: "Invoking
   * Lambda function URLs" § Cookies.
   */
  cookies?: string[];
  body?: string;
}

/** ID-token cookie Max-Age in seconds (15 minutes). */
const ID_TOKEN_MAX_AGE = 15 * 60;
/** Refresh-token cookie Max-Age in seconds (24 hours). */
const REFRESH_TOKEN_MAX_AGE = 24 * 60 * 60;

/**
 * Injectable dependencies for the auth-verify handler.
 */
export interface AuthVerifyHandlerDeps {
  readonly cognitoClient?: CognitoIdentityProviderClient;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/**
 * Returns a 403 response with an empty body.
 */
function forbidden(): LambdaFunctionUrlResult {
  return { statusCode: 403 };
}

/**
 * Returns the generic 401 authentication-failure response.
 */
function authFailed(): LambdaFunctionUrlResult {
  return {
    statusCode: 401,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: "Authentication failed" }),
  };
}

/**
 * HMAC-hashes an email address for safe logging.
 */
function hashEmail(email: string): string {
  const key = process.env[RuntimeEnv.DOMAIN] ?? "vestibulum-log-key";
  return crypto.createHmac("sha256", key).update(email).digest("hex").slice(0, 12);
}

/**
 * Create an auth-verify Lambda Function URL handler.
 *
 * Flow:
 * 1. Origin header CSRF check (403 on failure).
 * 2. Parse JSON body { session, challengeAnswer, email }.
 * 3. Call Cognito RespondToAuthChallenge.
 * 4. On success: set ID-token and refresh-token cookies, return 200.
 * 5. On any auth failure: return 401 with generic body.
 */
export function createAuthVerifyHandler(deps: AuthVerifyHandlerDeps = {}) {
  let defaultCognitoClient: CognitoIdentityProviderClient | undefined;

  function getCognitoClient(): CognitoIdentityProviderClient {
    if (deps.cognitoClient) return deps.cognitoClient;
    defaultCognitoClient ??= new CognitoIdentityProviderClient({});
    return defaultCognitoClient;
  }

  return async function handler(event: LambdaFunctionUrlEvent): Promise<LambdaFunctionUrlResult> {
    const headers = event.headers ?? {};

    // ------------------------------------------------------------------
    // 1. CSRF check via Origin header.
    // ------------------------------------------------------------------
    const domain = process.env[RuntimeEnv.DOMAIN];
    if (domain === undefined || domain === "") {
      console.error("auth-verify: VESTIBULUM_DOMAIN not set");
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
    // 2. Parse body.
    // ------------------------------------------------------------------
    let session: string;
    let challengeAnswer: string;
    let email: string;

    try {
      if (event.body === undefined || event.body === null || event.body === "") {
        return authFailed();
      }
      const parsed = JSON.parse(event.body) as Record<string, unknown>;
      if (
        typeof parsed["session"] !== "string" ||
        typeof parsed["challengeAnswer"] !== "string" ||
        typeof parsed["email"] !== "string"
      ) {
        return authFailed();
      }
      session = parsed["session"];
      challengeAnswer = parsed["challengeAnswer"];
      email = parsed["email"];
    } catch {
      return authFailed();
    }

    // ------------------------------------------------------------------
    // 3. Call Cognito.
    // ------------------------------------------------------------------
    const clientId = process.env[RuntimeEnv.COGNITO_CLIENT_ID];
    if (clientId === undefined || clientId === "") {
      console.error("auth-verify: VESTIBULUM_CLIENT_ID not set");
      return authFailed();
    }

    let cognitoResult: RespondToAuthChallengeCommandOutput;
    try {
      cognitoResult = await getCognitoClient().send(
        new RespondToAuthChallengeCommand({
          ChallengeName: "CUSTOM_CHALLENGE",
          ClientId: clientId,
          Session: session,
          ChallengeResponses: {
            USERNAME: email,
            ANSWER: challengeAnswer,
          },
        }),
      );
    } catch {
      console.error(`auth-verify: Cognito error for email-hash=${hashEmail(email)}`);
      return authFailed();
    }

    const idToken = cognitoResult.AuthenticationResult?.IdToken;
    const refreshToken = cognitoResult.AuthenticationResult?.RefreshToken;

    if (idToken === undefined || idToken === "") {
      console.error(`auth-verify: missing IdToken for email-hash=${hashEmail(email)}`);
      return authFailed();
    }

    // ------------------------------------------------------------------
    // 4. Set cookies and return 200.
    // ------------------------------------------------------------------

    const idTokenCookie = buildSetCookie(ID_TOKEN_COOKIE_NAME, idToken, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      domain,
      maxAge: ID_TOKEN_MAX_AGE,
    });

    const setCookieHeaders: string[] = [idTokenCookie];

    if (refreshToken !== undefined && refreshToken !== "") {
      const refreshTokenCookie = buildSetCookie(REFRESH_TOKEN_COOKIE_NAME, refreshToken, {
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
        path: "/auth-verify",
        domain,
        maxAge: REFRESH_TOKEN_MAX_AGE,
      });
      setCookieHeaders.push(refreshTokenCookie);
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      cookies: setCookieHeaders,
      body: JSON.stringify({ ok: true }),
    };
  };
}
