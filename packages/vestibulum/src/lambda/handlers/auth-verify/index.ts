/**
 * auth-verify — regional Lambda endpoint for magic-link redemption.
 *
 * Receives the POST the callback page sends when the user CLICKS "Sign in",
 * completes the Cognito challenge, and sets the ID-token and refresh-token
 * cookies on success.
 *
 * Security properties enforced here:
 * - POST only, `Content-Type: application/json`, same-origin `Origin`
 *   (`signin_redeem_requires_user_gesture` is the page's half; this is the
 *   endpoint's half — a GET, a form post or a cross-site request cannot redeem).
 * - Browser binding (`signin_link_bound_to_requesting_browser`): the request
 *   must carry the `__Host-signin` cookie set by `/auth-login`. The pending
 *   Cognito `Session` lives server-side under `SHA-256(cookie)`; the browser
 *   never holds it. No cookie, or an unknown one, is a 401 that calls Cognito
 *   NOT AT ALL and consumes nothing — the honest browser can still redeem.
 * - Single use (`signin_link_single_use`): the binding row is taken with one
 *   atomic conditional DeleteItem (ALL_OLD). Of N concurrent redemptions of one
 *   binding exactly one obtains the session; the others find no row.
 * - Expiry (`signin_link_expires_10min`): a row at or past `expires_at` is
 *   refused here, independent of DynamoDB TTL deletion and of Cognito's own
 *   session validity.
 * - Generic error responses (prevents distinguishing failure modes); metrics
 *   carry closed enums only, never an address, session, token or cookie.
 *
 * Direct Function URL access is blocked by CloudFront Origin Access Control
 * (OAC) at the AWS IAM layer — the Function URL's `authType` is `AWS_IAM`
 * and its resource policy grants `lambda:InvokeFunctionUrl` only to the
 * CloudFront service principal scoped to the exact distribution ARN.
 *
 * @see doc/01-package-design.md §Function URLs and CloudFront routing
 * @see doc/01-package-design.md §Cookie and CSRF posture
 */

import {
  CognitoIdentityProviderClient,
  RespondToAuthChallengeCommand,
  type RespondToAuthChallengeCommandOutput,
} from "@aws-sdk/client-cognito-identity-provider";
import { DeleteItemCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { RuntimeEnv } from "../../shared/runtime-env.js";
import {
  BINDING_COOKIE_NAME,
  MAX_ANSWER_LENGTH,
  TTL_ATTRIBUTE,
  clearBindingCookie,
  emitSigninMetric,
  hashBindingSecret,
  parseRefreshTokenValiditySeconds,
  readCookie,
} from "../../shared/signin.js";
import { buildSetCookie } from "./cookie.js";
import { ID_TOKEN_COOKIE_NAME, REFRESH_TOKEN_COOKIE_NAME } from "../../shared/cookie-names.js";

// ---------------------------------------------------------------------------
// Lambda Function URL event shapes (minimal — only the fields we need).
// ---------------------------------------------------------------------------

export interface LambdaFunctionUrlEvent {
  readonly headers?: Record<string, string | undefined>;
  /** Payload format 2.0 delivers request cookies here (and may drop the header). */
  readonly cookies?: readonly string[];
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

/** Refresh-token cookie Max-Age in seconds (24 hours). */
const REFRESH_TOKEN_MAX_AGE = 24 * 60 * 60;

/**
 * Injectable dependencies for the auth-verify handler.
 */
export interface AuthVerifyHandlerDeps {
  readonly cognitoClient?: CognitoIdentityProviderClient;
  readonly dynamodb?: DynamoDBClient;
  /** Clock for the expiry check. Defaults to `Date.now()`. */
  readonly nowMs?: () => number;
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
 * The generic 401. Always clears the binding cookie: every outcome is terminal
 * (one answer per session), so the cookie has no further use.
 */
function authFailed(): LambdaFunctionUrlResult {
  return {
    statusCode: 401,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    cookies: [clearBindingCookie()],
    body: JSON.stringify({ error: "Authentication failed" }),
  };
}

/** Closed set of redemption outcomes, emitted as a metric. */
type RedeemOutcome =
  | "ok"
  | "no_binding"
  | "expired"
  | "no_session"
  | "rejected"
  | "error";

function fail(outcome: RedeemOutcome): LambdaFunctionUrlResult {
  emitSigninMetric("SignInRedeem", { outcome });
  return authFailed();
}

/**
 * Create an auth-verify Lambda Function URL handler.
 *
 * Flow:
 * 1. POST + Origin + JSON content-type checks (403 / 405 / 415).
 * 2. Parse JSON body `{ answer }` — nothing else comes from the browser.
 * 3. Read the binding cookie; take the pending row atomically by `SHA-256(b)`.
 * 4. Refuse an expired row or a row with no session.
 * 5. Call Cognito RespondToAuthChallenge with the stored session.
 * 6. On success: set ID-token and refresh-token cookies, return 200.
 * 7. On any failure: 401 with a generic body. Both clear the binding cookie.
 */
export function createAuthVerifyHandler(deps: AuthVerifyHandlerDeps = {}) {
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

  return async function handler(event: LambdaFunctionUrlEvent): Promise<LambdaFunctionUrlResult> {
    const headers = event.headers ?? {};

    // ------------------------------------------------------------------
    // 1. Method, CSRF (Origin) and content-type.
    // ------------------------------------------------------------------
    const domain = process.env[RuntimeEnv.DOMAIN];
    if (domain === undefined || domain === "") {
      console.error("auth-verify: VESTIBULUM_DOMAIN not set");
      return authFailed();
    }

    // Redemption is a POST sent on a user gesture — never a GET a scanner,
    // previewer or prefetcher could issue.
    if (event.requestContext?.http?.method !== "POST") {
      return { statusCode: 405, headers: { Allow: "POST" } };
    }

    const originHeader = headers["origin"];
    if (originHeader === undefined || originHeader === "") {
      return forbidden();
    }
    const expectedOrigin = `https://${domain}`;
    if (originHeader !== expectedOrigin) {
      return forbidden();
    }

    // A cross-site <form> cannot send application/json without a preflight.
    const contentType = (headers["content-type"] ?? "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      return { statusCode: 415 };
    }

    // ------------------------------------------------------------------
    // 2. Parse body — only the answer comes from the browser.
    // ------------------------------------------------------------------
    let answer: string;
    try {
      if (event.body === undefined || event.body === null || event.body === "") {
        return fail("rejected");
      }
      const parsed = JSON.parse(event.body) as Record<string, unknown>;
      const candidate = parsed["answer"];
      if (
        typeof candidate !== "string" ||
        candidate.length === 0 ||
        candidate.length > MAX_ANSWER_LENGTH
      ) {
        return fail("rejected");
      }
      answer = candidate;
    } catch {
      return fail("rejected");
    }

    const clientId = process.env[RuntimeEnv.COGNITO_CLIENT_ID];
    const bindingTable = process.env[RuntimeEnv.BINDING_TABLE_NAME];
    if (
      clientId === undefined ||
      clientId === "" ||
      bindingTable === undefined ||
      bindingTable === ""
    ) {
      console.error("auth-verify: required configuration missing");
      return authFailed();
    }

    // The ID-token cookie lives as long as the refresh token, so `/auth-signout`
    // (which sees only this cookie) can still revoke after the ID token has
    // expired. Every consumer of the cookie checks `exp` itself (the edge
    // check-auth gates and auth-signout, which relaxes it only for revocation),
    // so a long-lived cookie holding an expired token never grants access. A
    // malformed value fails closed: it must never silently widen the lifetime.
    const idTokenMaxAge = parseRefreshTokenValiditySeconds(
      process.env[RuntimeEnv.REFRESH_TOKEN_VALIDITY_SECONDS],
    );
    if (idTokenMaxAge === undefined) {
      console.error("auth-verify: refresh-token validity invalid");
      return authFailed();
    }

    // ------------------------------------------------------------------
    // 3. Browser binding. No cookie → nothing is read, called or consumed.
    // ------------------------------------------------------------------
    const bindingSecret = readCookie(event, BINDING_COOKIE_NAME);
    if (bindingSecret === undefined) {
      return fail("no_binding");
    }

    // Take the row atomically: of N concurrent redemptions exactly one gets
    // the stored session, the rest get ConditionalCheckFailed.
    let row: Record<string, { S?: string; N?: string } | undefined>;
    try {
      const taken = await getDynamoClient().send(
        new DeleteItemCommand({
          TableName: bindingTable,
          Key: { binding_hash: { S: hashBindingSecret(bindingSecret) } },
          ConditionExpression: "attribute_exists(binding_hash)",
          ReturnValues: "ALL_OLD",
        }),
      );
      if (taken.Attributes === undefined) return fail("no_binding");
      row = taken.Attributes;
    } catch (err) {
      // ConditionalCheckFailedException = no such binding (unknown cookie,
      // already redeemed, or lost the race). Anything else is a dependency
      // error. Both fail closed; neither reaches Cognito.
      return fail(
        err instanceof Error && err.name === "ConditionalCheckFailedException"
          ? "no_binding"
          : "error",
      );
    }

    // ------------------------------------------------------------------
    // 4. Expiry and session presence.
    // ------------------------------------------------------------------
    const expiresAtSeconds = Number(row[TTL_ATTRIBUTE]?.N);
    if (!Number.isFinite(expiresAtSeconds) || nowMs() >= expiresAtSeconds * 1000) {
      return fail("expired");
    }
    const session = row["session"]?.S;
    const username = row["username"]?.S;
    if (session === undefined || session === "" || username === undefined || username === "") {
      return fail("no_session");
    }

    // ------------------------------------------------------------------
    // 5. Call Cognito.
    // ------------------------------------------------------------------
    let cognitoResult: RespondToAuthChallengeCommandOutput;
    try {
      cognitoResult = await getCognitoClient().send(
        new RespondToAuthChallengeCommand({
          ChallengeName: "CUSTOM_CHALLENGE",
          ClientId: clientId,
          Session: session,
          ChallengeResponses: {
            USERNAME: username,
            ANSWER: answer,
          },
        }),
      );
    } catch {
      return fail("rejected");
    }

    const idToken = cognitoResult.AuthenticationResult?.IdToken;
    const refreshToken = cognitoResult.AuthenticationResult?.RefreshToken;

    if (idToken === undefined || idToken === "") {
      return fail("rejected");
    }

    // ------------------------------------------------------------------
    // 6. Set cookies and return 200.
    // ------------------------------------------------------------------

    const idTokenCookie = buildSetCookie(ID_TOKEN_COOKIE_NAME, idToken, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      domain,
      maxAge: idTokenMaxAge,
    });

    const setCookieHeaders: string[] = [idTokenCookie, clearBindingCookie()];

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

    emitSigninMetric("SignInRedeem", { outcome: "ok" });
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      cookies: setCookieHeaders,
      body: JSON.stringify({ ok: true }),
    };
  };
}
