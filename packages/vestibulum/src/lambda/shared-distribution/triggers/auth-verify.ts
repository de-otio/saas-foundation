/**
 * Shared-distribution `auth-verify` Function URL handler.
 *
 * Serves all tenants from a single Lambda. The `Host` header discriminates
 * which tenant the request belongs to — works only when invoked through
 * CloudFront (which forwards the original viewer Host). Direct `.on.aws`
 * invocations are refused with 400 (fail-closed).
 *
 * Two paths:
 *   1. Magic-link redemption: POST with `{ session, challengeAnswer, email }`.
 *   2. Refresh: POST with `{ refresh: true }` and a `refresh-token` cookie.
 *      Uses `GetTokensFromRefreshToken` (NOT `InitiateAuth/REFRESH_TOKEN_AUTH`)
 *      because refresh-token rotation is enabled and is incompatible with
 *      `REFRESH_TOKEN_AUTH`.
 *
 * Security properties:
 *   - Host MUST be a valid tenant subdomain (not a .on.aws direct invoke).
 *   - ClientConfig loaded per subdomain — fail-closed on DDB error.
 *   - No PII in logs.
 */

import {
  CognitoIdentityProviderClient,
  RespondToAuthChallengeCommand,
  GetTokensFromRefreshTokenCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { extractTenantSubdomain } from '../shared/extract-tenant-subdomain.js';
import { loadClientConfigBySubdomain } from '../shared/client-config-loader.js';
import { parseCookies, buildSetCookie } from '../../handlers/auth-verify/cookie.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** ID-token cookie Max-Age in seconds (15 minutes). */
const ID_TOKEN_MAX_AGE = 15 * 60;
/** Refresh-token cookie Max-Age in seconds (30 days). */
const REFRESH_TOKEN_MAX_AGE = 30 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Event / result shapes (Lambda Function URL v2 format)
// ---------------------------------------------------------------------------

export interface FunctionUrlEvent {
  readonly headers?: Record<string, string | undefined>;
  readonly body?: string | null;
  readonly requestContext?: {
    readonly http?: {
      readonly method?: string;
    };
  };
}

export interface FunctionUrlResult {
  statusCode: number;
  headers?: Record<string, string>;
  multiValueHeaders?: Record<string, string[]>;
  body?: string;
}

// ---------------------------------------------------------------------------
// Injectable dependencies for testability
// ---------------------------------------------------------------------------

export interface AuthVerifyDeps {
  readonly cognitoClient?: CognitoIdentityProviderClient;
  readonly tenantParent?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorResponse(status: number, message: string): FunctionUrlResult {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: message }),
  };
}

function authFailed(): FunctionUrlResult {
  return errorResponse(401, 'Authentication failed');
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAuthVerifyHandler(deps: AuthVerifyDeps = {}) {
  let defaultCognito: CognitoIdentityProviderClient | undefined;

  function getCognito(): CognitoIdentityProviderClient {
    if (deps.cognitoClient) return deps.cognitoClient;
    defaultCognito ??= new CognitoIdentityProviderClient({});
    return defaultCognito;
  }

  return async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
    const headers = event.headers ?? {};

    // ------------------------------------------------------------------
    // 1. Host check — must be a valid tenant subdomain.
    //    Direct .on.aws invocations don't match TENANT_PARENT → 400.
    // ------------------------------------------------------------------
    const tenantParent =
      deps.tenantParent ?? process.env['VESTIBULUM_TENANT_PARENT'];
    if (tenantParent == null || tenantParent === '') {
      console.error('auth-verify: VESTIBULUM_TENANT_PARENT not set');
      return errorResponse(500, 'Internal configuration error');
    }

    const host = headers['host'];
    const subdomain = extractTenantSubdomain(host, tenantParent);
    if (subdomain == null) {
      return errorResponse(400, 'invalid host');
    }

    // ------------------------------------------------------------------
    // 2. Load ClientConfig for the resolved subdomain.
    // ------------------------------------------------------------------
    const tenantConfig = await loadClientConfigBySubdomain(subdomain).catch((err) => {
      console.error('auth-verify: DDB error loading client config', err);
      throw err; // fail-closed: propagate
    });
    if (!tenantConfig) {
      return errorResponse(404, 'tenant not found');
    }

    const cookies = parseCookies(headers['cookie']);
    let bodyParsed: Record<string, unknown> | null = null;
    if (event.body !== undefined && event.body !== null && event.body !== '') {
      try {
        bodyParsed = JSON.parse(event.body) as Record<string, unknown>;
      } catch {
        return authFailed();
      }
    }

    // ------------------------------------------------------------------
    // 3a. Refresh path: uses GetTokensFromRefreshToken (NOT REFRESH_TOKEN_AUTH).
    // ------------------------------------------------------------------
    if (bodyParsed !== null && bodyParsed['refresh'] === true) {
      const oldRefreshToken = cookies['refresh-token'];
      if (oldRefreshToken == null || oldRefreshToken === '') {
        return authFailed();
      }

      let refreshResult;
      try {
        refreshResult = await getCognito().send(
          new GetTokensFromRefreshTokenCommand({
            ClientId: tenantConfig.clientId,
            RefreshToken: oldRefreshToken,
          }),
        );
      } catch {
        console.error('auth-verify: GetTokensFromRefreshToken error');
        return authFailed();
      }

      const authResult = refreshResult.AuthenticationResult;
      const newIdToken = authResult?.IdToken;
      const newRefreshToken = authResult?.RefreshToken;

      if (newIdToken == null || newIdToken === '') {
        return authFailed();
      }

      const domain = `${subdomain}.${tenantParent}`;
      const setCookies: string[] = [
        buildSetCookie('id-token', newIdToken, {
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
          path: '/',
          domain,
          maxAge: ID_TOKEN_MAX_AGE,
        }),
      ];

      if (newRefreshToken != null && newRefreshToken !== '') {
        setCookies.push(
          buildSetCookie('refresh-token', newRefreshToken, {
            httpOnly: true,
            secure: true,
            sameSite: 'Strict',
            path: '/auth-verify',
            domain,
            maxAge: REFRESH_TOKEN_MAX_AGE,
          }),
        );
      }

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        multiValueHeaders: { 'Set-Cookie': setCookies },
        body: JSON.stringify({ ok: true }),
      };
    }

    // ------------------------------------------------------------------
    // 3b. Magic-link redemption path.
    // ------------------------------------------------------------------
    if (bodyParsed === null) {
      return authFailed();
    }

    const session = bodyParsed['session'];
    const challengeAnswer = bodyParsed['challengeAnswer'];
    const email = bodyParsed['email'];

    if (
      typeof session !== 'string' ||
      typeof challengeAnswer !== 'string' ||
      typeof email !== 'string'
    ) {
      return authFailed();
    }

    let cognitoResult;
    try {
      cognitoResult = await getCognito().send(
        new RespondToAuthChallengeCommand({
          ChallengeName: 'CUSTOM_CHALLENGE',
          ClientId: tenantConfig.clientId,
          Session: session,
          ChallengeResponses: {
            USERNAME: email,
            ANSWER: challengeAnswer,
          },
        }),
      );
    } catch {
      console.error('auth-verify: RespondToAuthChallenge error');
      return authFailed();
    }

    const idToken = cognitoResult.AuthenticationResult?.IdToken;
    const refreshToken = cognitoResult.AuthenticationResult?.RefreshToken;

    if (idToken == null || idToken === '') {
      return authFailed();
    }

    const domain = `${subdomain}.${tenantParent}`;
    const setCookies: string[] = [
      buildSetCookie('id-token', idToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/',
        domain,
        maxAge: ID_TOKEN_MAX_AGE,
      }),
    ];

    if (refreshToken != null && refreshToken !== '') {
      setCookies.push(
        buildSetCookie('refresh-token', refreshToken, {
          httpOnly: true,
          secure: true,
          sameSite: 'Strict',
          path: '/auth-verify',
          domain,
          maxAge: REFRESH_TOKEN_MAX_AGE,
        }),
      );
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      multiValueHeaders: { 'Set-Cookie': setCookies },
      body: JSON.stringify({ ok: true }),
    };
  };
}

/** Default exported handler. */
export const handler = createAuthVerifyHandler();
