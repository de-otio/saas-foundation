/**
 * Derive Cognito issuer / JWKS URI from a User Pool ID.
 *
 * Cognito User Pool IDs encode the region as the prefix before the
 * underscore: `<region>_<random>` (e.g. `eu-central-1_aBcDeFgHi`). The
 * issuer URL and the `.well-known/jwks.json` URI are both deterministic
 * functions of region + pool ID. We compute them in-process so the
 * synth-time config only has to inject the pool ID (and home region for
 * the JWKS hostname); we do not need to inject the full URLs.
 *
 * Why a separate module: keeps the parsing logic isolated from the
 * handler and easily testable, and lets the construct (WS-08) reuse the
 * same logic when validating consumer-supplied pool IDs without dragging
 * in `aws-jwt-verify`.
 *
 * Security notes:
 * - We validate the pool ID shape with a tight regex. Any failure to
 *   parse is treated as a fatal config error by the caller; check-auth
 *   maps that to a 302, never a pass-through.
 * - The region is taken from the pool ID itself, never from the edge
 *   runtime's `AWS_REGION` (which would be the edge region, not the
 *   home region the pool lives in).
 */

/**
 * Result of resolving a User Pool ID to its issuer + JWKS coordinates.
 */
export interface ResolvedCognitoEndpoint {
  /** The AWS region encoded in the User Pool ID (e.g. `eu-central-1`). */
  readonly region: string;
  /** The Cognito issuer URL: `https://cognito-idp.<region>.amazonaws.com/<poolId>`. */
  readonly issuer: string;
  /** The JWKS URL: `<issuer>/.well-known/jwks.json`. */
  readonly jwksUri: string;
}

// Cognito pool ID grammar: `<region>_<alnum>+`. Region prefix matches the
// AWS region naming convention: lowercase letters, digits, and dashes.
// The pool-suffix is alphanumeric (no underscores after the first one).
const POOL_ID_RE = /^([a-z]{2,}-[a-z]+(?:-[a-z]+)?-\d)_([A-Za-z0-9]+)$/;

/**
 * Parse a Cognito User Pool ID into its region + JWKS coordinates.
 *
 * @param userPoolId - The User Pool ID, e.g. `eu-central-1_aBcDeFgHi`.
 * @returns The resolved endpoint, or `undefined` if the pool ID is malformed.
 */
export function resolveCognitoEndpoint(userPoolId: string): ResolvedCognitoEndpoint | undefined {
  if (typeof userPoolId !== "string") {
    return undefined;
  }
  const match = POOL_ID_RE.exec(userPoolId);
  if (!match) {
    return undefined;
  }
  const region = match[1];
  if (region === undefined) {
    return undefined;
  }
  const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
  return {
    region,
    issuer,
    jwksUri: `${issuer}/.well-known/jwks.json`,
  };
}
