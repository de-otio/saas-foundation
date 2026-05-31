/**
 * Test-only helpers for issuing RS256-signed JWTs and producing matching
 * JWKS entries. Used by the edge `check-auth` and `verify-jwt` test
 * suites.
 *
 * Why hand-roll RSA signing here rather than use `jose` or similar: the
 * package's runtime has no JWT-issuing dependency (only `aws-jwt-verify`
 * for the verifier side). Adding one would inflate the dev surface for
 * what's a one-screen helper.
 */

import {
  generateKeyPairSync,
  createSign,
  createHmac,
  type KeyObject,
} from 'node:crypto';

export interface TestKeyPair {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly jwk: Record<string, unknown>;
}

/**
 * Generate an RS256 key pair and produce the matching JWK (RSA n/e form)
 * for inclusion in a test JWKS.
 */
export function generateTestKey(kid: string): TestKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });

  // Export the public key as JWK so we can plug it into a JWKS.
  const jwk = publicKey.export({ format: 'jwk' }) as {
    kty: string;
    n: string;
    e: string;
  };

  return {
    kid,
    privateKey,
    publicKey,
    jwk: {
      kid,
      kty: jwk.kty,
      n: jwk.n,
      e: jwk.e,
      alg: 'RS256',
      use: 'sig',
    },
  };
}

/** Encode an object as base64url JSON for JWT segments. */
function base64UrlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf-8')
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/** Encode a Buffer as base64url. */
function base64UrlBytes(b: Buffer): string {
  return b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export interface IssueTokenOptions {
  /** Override the alg in the JWT header. Defaults to `RS256`. */
  readonly alg?: string;
  /** Override the kid in the JWT header. Defaults to the key's kid. */
  readonly kid?: string;
  /** Skip the kid header field entirely. */
  readonly omitKid?: boolean;
  /** Body claims. Sensible defaults provided. */
  readonly claims?: Record<string, unknown>;
  /**
   * Fixed "now" in Unix seconds for deterministic timestamps.
   * Defaults to a hard-coded reference epoch when not supplied.
   */
  readonly nowSec?: number;
}

/**
 * Sign a JWT with the given RSA key. The header `kid` defaults to the
 * key's kid; the body claims default to a valid Cognito-id-token shape
 * with `token_use: 'id'` and an `exp` 1 hour in the future.
 */
export function signTestJwt(
  key: TestKeyPair,
  opts: IssueTokenOptions = {},
): string {
  const header: Record<string, unknown> = { alg: opts.alg ?? 'RS256', typ: 'JWT' };
  if (opts.omitKid !== true) {
    header['kid'] = opts.kid ?? key.kid;
  }

  // Use the caller-supplied epoch or fall back to a fixed reference time so
  // the helper never calls Date.now() directly (determinism rule for tests).
  const now = opts.nowSec ?? 1_700_000_000;
  const claims: Record<string, unknown> = {
    iss: 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_PLACEHOLDER',
    aud: 'test-client-id',
    token_use: 'id',
    'custom:tenant_id': 'acme',
    sub: 'test-sub',
    iat: now,
    nbf: now - 5,
    exp: now + 3600,
    ...opts.claims,
  };

  const headerB64 = base64UrlJson(header);
  const payloadB64 = base64UrlJson(claims);
  const signingInput = `${headerB64}.${payloadB64}`;

  // Sign with RS256. For HS256/none, the caller would patch the header
  // and we'd ignore the signature; that case is exercised via direct
  // construction (see `signHs256TestJwt`).
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(key.privateKey);

  return `${signingInput}.${base64UrlBytes(signature)}`;
}

/**
 * Build an HS256-signed JWT for the "forbidden alg" tests. The signature
 * is a real HMAC against an arbitrary secret — the test asserts the
 * verifier rejects it BEFORE checking the signature.
 */
export function signHs256TestJwt(claims: Record<string, unknown>): string {
  const header = { alg: 'HS256', typ: 'JWT', kid: 'hs-kid' };
  const headerB64 = base64UrlJson(header);
  const payloadB64 = base64UrlJson(claims);
  const input = `${headerB64}.${payloadB64}`;
  const sig = createHmac('sha256', 'shared-secret').update(input).digest();
  return `${input}.${base64UrlBytes(sig)}`;
}

/** Build an `alg: none` JWT (no signature). */
export function signNoneTestJwt(claims: Record<string, unknown>): string {
  const header = { alg: 'none', typ: 'JWT', kid: 'none-kid' };
  return `${base64UrlJson(header)}.${base64UrlJson(claims)}.`;
}

export const TEST_ISSUER =
  'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_PLACEHOLDER';
