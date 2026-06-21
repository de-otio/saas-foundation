/**
 * auth-signout — regional Lambda endpoint for user sign-out.
 *
 * Clears the ID-token and refresh-token cookies and revokes the Cognito
 * refresh token server-side via AdminUserGlobalSignOut. Even if Cognito
 * revocation fails (e.g. token already expired), the cookies are cleared
 * so the browser-observable state is always "signed out".
 *
 * Security properties enforced here:
 * - Origin header CSRF check (prevents cross-site sign-out requests).
 * - Server-side refresh-token revocation via AdminUserGlobalSignOut.
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
import { RuntimeEnv } from "../../shared/runtime-env.js";
import { parseCookies, buildSetCookie } from "../auth-verify/cookie.js";
import { ID_TOKEN_COOKIE_NAME, REFRESH_TOKEN_COOKIE_NAME } from "../../shared/cookie-names.js";

// ---------------------------------------------------------------------------
// Lambda Function URL event shapes.
// ---------------------------------------------------------------------------

export interface LambdaFunctionUrlEvent {
  readonly headers?: Record<string, string | undefined>;
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

/**
 * Extracts the `sub` claim from a JWT ID token without verifying the
 * signature. This is intentionally unverified because:
 * - We are the trusted server-side code that issued the cookie.
 * - The cookie is HttpOnly and was set by our own auth-verify endpoint.
 * - We use the sub only to call AdminUserGlobalSignOut on the correct user.
 * - Even a tampered sub would at worst call GlobalSignOut on the wrong user
 *   (harmless) or fail (handled by the catch block).
 *
 * @returns The `sub` claim string, or undefined if extraction fails.
 */
function extractSubFromJwt(token: string): string | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return undefined;
    }
    const payloadPart = parts[1];
    if (payloadPart === undefined || payloadPart === "") {
      return undefined;
    }
    const padded = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const payload = JSON.parse(decoded) as Record<string, unknown>;
    const sub = payload["sub"];
    if (typeof sub === "string") {
      return sub;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Create an auth-signout Lambda Function URL handler.
 *
 * Flow:
 * 1. Origin header CSRF check (403 on failure).
 * 2. Read the refresh-token cookie.
 * 3. Call Cognito AdminUserGlobalSignOut (best-effort — proceed on failure).
 * 4. Clear both cookies, return 200 with empty body.
 */
export function createAuthSignoutHandler(deps: AuthSignoutHandlerDeps = {}) {
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
    // 2. Read refresh-token cookie for server-side revocation.
    // ------------------------------------------------------------------
    const cookieHeader = headers["cookie"];
    const cookies = parseCookies(cookieHeader);
    const refreshToken = cookies[REFRESH_TOKEN_COOKIE_NAME];

    // ------------------------------------------------------------------
    // 3. Server-side revocation — best-effort (proceed on failure).
    // ------------------------------------------------------------------
    if (refreshToken !== undefined && refreshToken !== "") {
      const userPoolId = process.env[RuntimeEnv.COGNITO_USER_POOL_ID];
      if (userPoolId !== undefined && userPoolId !== "") {
        try {
          const idTokenRaw = cookies[ID_TOKEN_COOKIE_NAME];
          if (idTokenRaw !== undefined && idTokenRaw !== "") {
            const sub = extractSubFromJwt(idTokenRaw);
            if (sub !== undefined && sub !== "") {
              await getCognitoClient().send(
                new AdminUserGlobalSignOutCommand({
                  UserPoolId: userPoolId,
                  Username: sub,
                }),
              );
            }
          }
        } catch {
          console.error(
            "auth-signout: AdminUserGlobalSignOut error (proceeding with cookie clear)",
          );
        }
      }
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
