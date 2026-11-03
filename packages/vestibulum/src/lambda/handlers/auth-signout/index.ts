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
 * - Origin header CSRF check (prevents cross-site sign-out requests).
 * - The user to sign out comes from a VERIFIED ID token (signature, issuer,
 *   audience, expiry, `token_use`), never from an unverified cookie: anyone who
 *   knew a user's `sub` could otherwise sign that user out.
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
import { RuntimeEnv } from "../../shared/runtime-env.js";
import { emitSigninMetric, readCookie } from "../../shared/signin.js";
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
}

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
 * 1. Origin header CSRF check (403 on failure).
 * 2. Read and VERIFY the ID-token cookie.
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
  ): Promise<{ readonly username: string }> {
    if (deps.verifyIdToken) return deps.verifyIdToken(token);
    defaultVerifier ??= CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: "id" });
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

    let username: string;
    try {
      username = (await verifyIdToken(idTokenRaw, userPoolId, clientId)).username;
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

    const originHeader = headers["origin"];
    if (originHeader === undefined || originHeader === "") {
      return forbidden();
    }
    const expectedOrigin = `https://${domain}`;
    if (originHeader !== expectedOrigin) {
      return forbidden();
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
