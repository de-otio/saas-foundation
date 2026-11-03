/**
 * auth-signout — regional Lambda endpoint for user sign-out.
 *
 * Clears the ID-token and refresh-token cookies and revokes the user's Cognito
 * refresh tokens server-side via AdminUserGlobalSignOut. Even if revocation
 * fails the cookies are cleared, so the browser-observable state is always
 * "signed out" — but a failed revocation is no longer silent: it emits a
 * `SignOutRevocation` metric with a closed outcome enum.
 *
 * Why the ID token and not the refresh token: the refresh cookie is scoped to
 * `Path=/auth-verify`, so a browser never sends it to `/auth-signout`. The ID
 * token cookie is `Path=/` and always arrives.
 *
 * Security properties enforced here:
 * - POST only, `Content-Type: application/json`, same-origin `Origin` (as
 *   `/auth-verify`): a GET, a form post or a cross-site request cannot sign a
 *   user out (prevents cross-site sign-out requests).
 * - The user to sign out comes from a VERIFIED ID token (signature, issuer,
 *   audience, `token_use`), never from an unverified cookie: anyone who knew a
 *   user's `sub` could otherwise sign that user out.
 * - Expiry is the one check that is relaxed: an ID token that has already
 *   EXPIRED is still accepted, provided its `exp` is no more than the app
 *   client's refresh-token validity in the past
 *   (`VESTIBULUM_REFRESH_TOKEN_VALIDITY_SECONDS`, default 30 days). The ID token
 *   outlives its usefulness long before the refresh token does, and the refresh
 *   cookie never reaches this endpoint, so without this a user whose ID token
 *   lapsed could not revoke their refresh token. Trade-off: an old (but
 *   genuine, correctly signed) ID token can sign its user out. That is a
 *   low-impact action — the user signs in again — and is what the endpoint is
 *   for. Beyond the window the token is refused like any unverified token.
 * - The IAM action the construct grants (`cognito-idp:AdminUserGlobalSignOut`)
 *   is the one this code calls; a synth test keeps the two in step.
 *
 * Direct Function URL access is blocked by CloudFront Origin Access Control
 * (OAC) at the AWS IAM layer — see auth-verify for the full discussion.
 *
 * @see doc/01-package-design.md §Refresh-token revocation on signout
 * @see doc/01-package-design.md §Cookie and CSRF posture
 */

import {
  CognitoIdentityProviderClient,
  AdminUserGlobalSignOutCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { Jwks } from "aws-jwt-verify/jwk";
import { RuntimeEnv } from "../../shared/runtime-env.js";
import {
  DEFAULT_REFRESH_TOKEN_VALIDITY_SECONDS,
  emitSigninMetric,
  parseRefreshTokenValiditySeconds,
  readCookie,
} from "../../shared/signin.js";
import { buildSetCookie } from "../auth-verify/cookie.js";
import { ID_TOKEN_COOKIE_NAME, REFRESH_TOKEN_COOKIE_NAME } from "../../shared/cookie-names.js";

// ---------------------------------------------------------------------------
// Lambda Function URL event shapes.
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
   * ONLY via this `cookies` array, not via `Set-Cookie`/`multiValueHeaders`.
   * See AWS docs: "Invoking Lambda function URLs" § Cookies.
   */
  cookies?: string[];
  body?: string;
}

/**
 * Injectable dependencies for the auth-signout handler.
 */
export interface AuthSignoutHandlerDeps {
  readonly cognitoClient?: CognitoIdentityProviderClient;
  /**
   * Verifies an ID token and returns the pool username to sign out. MUST throw
   * on any invalid token. Defaults to `aws-jwt-verify` against this pool and
   * client. Injected in tests.
   */
  readonly verifyIdToken?: (token: string) => Promise<{ readonly username: string }>;
  /**
   * Preloads the default verifier's key set instead of fetching it from the
   * pool's JWKS endpoint. Injected in tests; unused when `verifyIdToken` is.
   */
  readonly jwks?: Jwks;
}

export { DEFAULT_REFRESH_TOKEN_VALIDITY_SECONDS, parseRefreshTokenValiditySeconds };

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function forbidden(): LambdaFunctionUrlResult {
  return { statusCode: 403 };
}

function buildClearCookieHeaders(domain: string): string[] {
  const idTokenClear = buildSetCookie(ID_TOKEN_COOKIE_NAME, "", {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    domain,
    maxAge: 0,
  });

  const refreshTokenClear = buildSetCookie(REFRESH_TOKEN_COOKIE_NAME, "", {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/auth-verify",
    domain,
    maxAge: 0,
  });

  return [idTokenClear, refreshTokenClear];
}

/** Closed set of revocation outcomes, emitted as a metric. */
type RevocationOutcome = "revoked" | "no_id_token" | "unverified" | "error";

/**
 * Create an auth-signout Lambda Function URL handler.
 *
 * Flow:
 * 1. Method (405), Origin (403) and content-type (415) checks.
 * 2. Read and VERIFY the ID-token cookie (an expired token is accepted up to
 *    the refresh-token validity in the past; see the file header).
 * 3. Call Cognito AdminUserGlobalSignOut for the verified user (best-effort —
 *    cookies are cleared regardless, and the outcome is emitted as a metric).
 * 4. Clear both cookies, return 200 with empty body.
 */
export function createAuthSignoutHandler(deps: AuthSignoutHandlerDeps = {}) {
  let defaultCognitoClient: CognitoIdentityProviderClient | undefined;
  let defaultVerifier:
    | { verify(token: string): Promise<{ sub: string; [claim: string]: unknown }> }
    | undefined;

  function getCognitoClient(): CognitoIdentityProviderClient {
    if (deps.cognitoClient) return deps.cognitoClient;
    defaultCognitoClient ??= new CognitoIdentityProviderClient({});
    return defaultCognitoClient;
  }

  async function verifyIdToken(
    token: string,
    userPoolId: string,
    clientId: string,
    graceSeconds: number,
  ): Promise<{ readonly username: string }> {
    if (deps.verifyIdToken) return deps.verifyIdToken(token);
    if (defaultVerifier === undefined) {
      // Signature, issuer, audience and `token_use` are checked exactly as
      // before. `graceSeconds` lets `exp` (and `nbf`) lie that far in the past
      // (the refresh-token window) instead of zero.
      const created = CognitoJwtVerifier.create({
        userPoolId,
        clientId,
        tokenUse: "id",
        graceSeconds,
      });
      if (deps.jwks) created.cacheJwks(deps.jwks);
      defaultVerifier = created;
    }
    const payload = await defaultVerifier.verify(token);
    // `cognito:username` is the exact value the Admin APIs take; it equals `sub`
    // on pools that sign in by alias, but is authoritative where they differ.
    const username = payload["cognito:username"];
    return { username: typeof username === "string" && username !== "" ? username : payload.sub };
  }

  async function revoke(
    cookieSource: LambdaFunctionUrlEvent,
    userPoolId: string,
    clientId: string,
  ): Promise<RevocationOutcome> {
    const idTokenRaw = readCookie(cookieSource, ID_TOKEN_COOKIE_NAME);
    if (idTokenRaw === undefined) return "no_id_token";

    // A misconfigured window must not silently widen to "accept anything".
    const graceSeconds = parseRefreshTokenValiditySeconds(
      process.env[RuntimeEnv.REFRESH_TOKEN_VALIDITY_SECONDS],
    );
    if (graceSeconds === undefined) return "error";

    let username: string;
    try {
      username = (await verifyIdToken(idTokenRaw, userPoolId, clientId, graceSeconds)).username;
    } catch {
      return "unverified";
    }

    try {
      await getCognitoClient().send(
        new AdminUserGlobalSignOutCommand({ UserPoolId: userPoolId, Username: username }),
      );
      return "revoked";
    } catch {
      return "error";
    }
  }

  return async function handler(event: LambdaFunctionUrlEvent): Promise<LambdaFunctionUrlResult> {
    const headers = event.headers ?? {};

    // ------------------------------------------------------------------
    // 1. CSRF check via Origin header.
    // ------------------------------------------------------------------
    const domain = process.env[RuntimeEnv.DOMAIN];
    if (domain === undefined || domain === "") {
      console.error("auth-signout: VESTIBULUM_DOMAIN not set");
      return { statusCode: 500 };
    }

    // Sign-out changes state (it revokes the user's refresh tokens), so it is a
    // POST, never a GET a link, an image tag or a prefetcher could issue.
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
    // 2-3. Verify the ID token, then revoke. Never blocks the cookie clear.
    // ------------------------------------------------------------------
    const userPoolId = process.env[RuntimeEnv.COGNITO_USER_POOL_ID];
    const clientId = process.env[RuntimeEnv.COGNITO_CLIENT_ID];
    let outcome: RevocationOutcome = "error";
    if (userPoolId !== undefined && userPoolId !== "" && clientId !== undefined && clientId !== "") {
      outcome = await revoke(event, userPoolId, clientId);
    } else {
      console.error("auth-signout: pool or client id not configured");
    }
    emitSigninMetric("SignOutRevocation", { outcome });
    if (outcome === "error" || outcome === "unverified") {
      // Closed enum only — no token, username or error text.
      console.error(`auth-signout: revocation ${outcome} (proceeding with cookie clear)`);
    }

    // ------------------------------------------------------------------
    // 4. Clear cookies and respond 200.
    // ------------------------------------------------------------------
    const clearHeaders = buildClearCookieHeaders(domain);

    return {
      statusCode: 200,
      cookies: clearHeaders,
    };
  };
}
