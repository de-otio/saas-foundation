/**
 * Federation-aware `addAppClient` helper for `MagicLinkIdentity`.
 *
 * Per S-C1: the `addAppClient` prop shape is the standard CDK
 * `cognito.UserPoolClientOptions` — the same shape `MagicLinkAuthSite` uses
 * internally when it auto-creates the website client — so consumers do not
 * have to learn a bespoke prop dialect.
 *
 * The v0.1 behaviour (CUSTOM_AUTH-only client, 24h refresh token, no OAuth
 * code flow) is preserved when `federationEnabled: false`. When
 * `federationEnabled: true`, the helper defaults to OAuth code flow + PKCE.
 *
 * `generateSecret: false` is always enforced — vestibulum app clients are
 * public (SPA / browser / mobile). Server-side confidential clients fall
 * back to the raw `cognitoPool.addClient` escape hatch.
 */

import { Duration, aws_cognito as cognito } from "aws-cdk-lib";

/**
 * Default ID-token TTL across all vestibulum app clients.
 * 15 min bounds the worst-case offboarding window for active sessions.
 */
export const DEFAULT_ID_TOKEN_VALIDITY = Duration.minutes(15);

/**
 * Pool-wide default refresh-token TTL for magic-link-only app clients.
 * 24 h matches vestibulum-cdk's security-conscious posture.
 */
export const DEFAULT_REFRESH_TOKEN_VALIDITY = Duration.hours(24);

/**
 * Inputs to `buildAppClientOptions`.
 */
export interface BuildAppClientOptionsInput {
  /**
   * Whether federation defaults apply. `true` when
   * `MagicLinkIdentity.federationEnabled` is `true`.
   */
  readonly federationEnabled: boolean;

  /**
   * The pool-wide default ID-token TTL (from `MagicLinkIdentity`).
   * Falls back to `DEFAULT_ID_TOKEN_VALIDITY` if the construct does not
   * set one.
   */
  readonly defaultIdTokenValidity: Duration;

  /**
   * The pool-wide default refresh-token TTL (from `MagicLinkIdentity`).
   * Falls back to `DEFAULT_REFRESH_TOKEN_VALIDITY` if the construct does
   * not set one.
   */
  readonly defaultRefreshTokenValidity: Duration;

  /**
   * Consumer-supplied `UserPoolClientOptions`. The `generateSecret: true`
   * value is rejected; all other options are passed through, with safe
   * defaults applied where the consumer did not supply overrides.
   */
  readonly props: cognito.UserPoolClientOptions;
}

/**
 * Validate the OAuth callback URLs supplied for a federation app client.
 *
 * Federation requires HTTPS-only callback URLs outside localhost.
 * Localhost (`http://localhost:*` / `http://127.0.0.1:*`) is permitted
 * to ease local development.
 *
 * @throws Error if any URL is non-HTTPS and not on localhost.
 */
export function validateFederationCallbackUrls(urls: readonly string[]): void {
  for (const url of urls) {
    if (url.startsWith("https://")) {
      continue;
    }
    if (url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1")) {
      continue;
    }
    throw new Error(
      `[vestibulum:addAppClient] federation callbackUrl '${url}' is not ` +
        `HTTPS. Federation requires HTTPS-only callback URLs outside ` +
        `localhost; http:// is permitted only for http://localhost:* and ` +
        `http://127.0.0.1:* during local development.`,
    );
  }
}

/**
 * Build the `cognito.UserPoolClientOptions` for an app client per the
 * federation-aware defaults.
 *
 * Splitting option-building from the construct-tree mutation makes the
 * logic testable without instantiating a full Cognito pool.
 */
export function buildAppClientOptions(
  input: BuildAppClientOptionsInput,
): cognito.UserPoolClientOptions {
  const { federationEnabled, props } = input;

  if (props.generateSecret === true) {
    throw new Error(
      `[vestibulum:addAppClient] generateSecret: true is not permitted via ` +
        `addAppClient. Vestibulum app clients are public (SPA / browser) ` +
        `and must not have a client secret. For server-side OAuth clients ` +
        `with a secret, use the cognitoPool.addClient escape hatch directly.`,
    );
  }

  const authFlows: cognito.AuthFlow = {
    // Magic-link bootstrap remains available even on federation pools so
    // the same pool can support both flows side-by-side.
    custom: true,
    userPassword: false,
    adminUserPassword: false,
    userSrp: false,
  };

  let oAuth = props.oAuth;

  if (federationEnabled && oAuth === undefined) {
    // Default to OAuth code flow + PKCE when the consumer did not supply
    // their own oauth block. CDK adds PKCE automatically when the code
    // flow is enabled and the client is public (generateSecret: false).
    oAuth = {
      flows: {
        authorizationCodeGrant: true,
        implicitCodeGrant: false,
        clientCredentials: false,
      },
      scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
      callbackUrls: [],
      logoutUrls: [],
    };
  }

  if (federationEnabled && oAuth?.callbackUrls !== undefined) {
    validateFederationCallbackUrls(oAuth.callbackUrls);
  }

  const refreshTokenValidity = props.refreshTokenValidity ?? input.defaultRefreshTokenValidity;

  const result: cognito.UserPoolClientOptions = {
    ...props,
    authFlows,
    preventUserExistenceErrors: true,
    enableTokenRevocation: true,
    generateSecret: false,
    idTokenValidity: props.idTokenValidity ?? input.defaultIdTokenValidity,
    refreshTokenValidity,
  };

  // Only set oAuth when it is defined to satisfy exactOptionalPropertyTypes.
  if (oAuth !== undefined) {
    return { ...result, oAuth };
  }
  return result;
}
