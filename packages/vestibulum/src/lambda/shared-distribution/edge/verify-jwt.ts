/**
 * JWT verification for the shared-distribution edge handler.
 *
 * Wraps `aws-jwt-verify`'s `verifyJwtSync` with a strict posture:
 *
 * - **Algorithms: RS256 only.** No HS256, no `none`. We reject before
 *   handing off to `verifyJwtSync` so the lower verifier never sees a
 *   non-RS256 token. (`verifyJwtSync` itself only does signature
 *   verification against the JWK's algorithm, but pre-rejecting here is
 *   defence-in-depth and keeps the error surface explicit.)
 * - **`kid` is mandatory.** The JWT header must carry a `kid`, and that
 *   `kid` must exist in the JWKS set as currently cached. No fallback to
 *   "the only key" if the kid is missing — even if the kid was in a
 *   previous cached set. See review fix H6.
 * - **`iss` is pinned.** Verified by `verifyJwtSync` via the `issuer` option.
 * - **`exp` / `nbf` honoured with clock skew.** Via `graceSeconds`.
 * - **`aud` not checked here.** The handler enforces the
 *   `Host ↔ custom:tenant_id` binding; `aud` allow-list at the edge is
 *   intentionally absent (see `04-multi-aud-edge-check.md`). We pass
 *   `audience: null` so `verifyJwtSync` doesn't enforce it.
 */

import { verifyJwtSync } from 'aws-jwt-verify/jwt-verifier';
import { decomposeUnverifiedJwt } from 'aws-jwt-verify/jwt';
import type { Jwks, Jwk, JwkWithKid } from 'aws-jwt-verify/jwk';
import type { JwtPayload } from 'aws-jwt-verify/jwt-model';

import type { JsonWebKey } from './jwks-cache.js';

/**
 * Verification options.
 *
 * `algorithms` is typed as `readonly ('RS256')[]` — narrow on purpose.
 * TypeScript will reject literal `'HS256'` at the call site. We still
 * verify at runtime in case the type is widened by a `Array<string>` cast.
 */
export interface VerifyJwtOptions {
  /** Expected `iss` claim value. Exact match required. */
  readonly issuer: string;
  /** Currently-cached JWKS keys. The verifier picks the one whose `kid` matches. */
  readonly jwks: readonly JsonWebKey[];
  /** Allowed algorithms. RS256 only is supported. */
  readonly algorithms: readonly 'RS256'[];
  /** Clock skew tolerance in seconds, applied to `exp` and `nbf`. */
  readonly clockSkewSec: number;
}

/**
 * Verify a JWT and return its decoded claims as a plain record.
 *
 * Throws on any verification failure:
 * - Malformed JWT structure.
 * - `alg` not in the allow-list.
 * - `kid` missing from the JWT header.
 * - `kid` not present in the supplied JWKS.
 * - Signature mismatch.
 * - `iss` mismatch.
 * - `exp`/`nbf`/`iat` validation failure (with clock skew applied).
 *
 * The thrown error's `message` is opaque — the caller treats any error as a
 * "refuse" outcome and does not surface the reason to the viewer.
 */
export function verifyJwt(
  token: string,
  opts: VerifyJwtOptions,
): Promise<Record<string, unknown>> {
  // All validation is synchronous but the API is Promise-based for call-site
  // uniformity. Errors are returned as Promise.reject() so callers using
  // `await` and `.rejects` both work correctly.
  try {
    return Promise.resolve(verifyJwtSync_(token, opts));
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/** Synchronous inner implementation — all throws become Promise.reject via the wrapper. */
function verifyJwtSync_(
  token: string,
  opts: VerifyJwtOptions,
): Record<string, unknown> {
  if (typeof token !== 'string' || token === '') {
    throw new Error('verifyJwt: token must be a non-empty string');
  }

  // Step 1: decompose so we can read the header and pick the right JWK.
  // This is signature-unverified data; we only use the `alg` and `kid`
  // fields for routing.
  const decomposed = decomposeUnverifiedJwt(token);
  const header = decomposed.header;

  // Step 2: alg must be RS256. The type narrows the allow-list, but we
  // also check at runtime as belt-and-braces.
  if (typeof header.alg !== 'string' || !opts.algorithms.includes(header.alg as 'RS256')) {
    throw new Error(`verifyJwt: unsupported alg "${String(header.alg)}"`);
  }
  // `opts.algorithms` is typed as `readonly 'RS256'[]`, so `includes` can only
  // return true for 'RS256'. If line 79 passes, `header.alg` must be 'RS256'.
  // This second check is belt-and-braces against a call-site type widening
  // (e.g. casting `['RS256', 'RS384']` as `'RS256'[]`); it cannot fire with
  // the current `algorithms: ['RS256']` call site.
  /* c8 ignore next 3 */
  if (header.alg !== 'RS256') {
    throw new Error(`verifyJwt: alg must be RS256, got "${header.alg}"`);
  }

  // Step 3: kid must be a non-empty string and present in the JWKS.
  if (typeof header.kid !== 'string' || header.kid === '') {
    throw new Error('verifyJwt: header.kid missing');
  }
  const kid = header.kid;

  const matchedJwk = opts.jwks.find(
    (k) => typeof k['kid'] === 'string' && k['kid'] === kid,
  );
  if (matchedJwk === undefined) {
    throw new Error(`verifyJwt: kid "${kid}" not in JWKS`);
  }

  // Step 4: hand the matched JWK to verifyJwtSync along with the pinned
  // issuer and clock skew. We pass a Jwks wrapper so the lower API
  // doesn't have to re-search (`verifyJwtSync` accepts either a Jwks or
  // a single Jwk; we pass the single matched JWK directly).
  const jwksForVerify: Jwks = { keys: [matchedJwk as unknown as Jwk] };

  let payload: JwtPayload;
  try {
    payload = verifyJwtSync(token, jwksForVerify, {
      issuer: opts.issuer,
      audience: null, // aud allow-list intentionally absent — see 04 § Why no aud allowlist.
      graceSeconds: opts.clockSkewSec,
      customJwtCheck: ({ jwk, header: h }) => {
        // Belt-and-braces: refuse if the matched JWK isn't the one we picked,
        // or if the alg drifted between steps. Defensive against
        // hypothetical aws-jwt-verify changes. alg is already verified at
        // step 2 and customJwtCheck receives the same immutable header, so
        // this branch cannot be triggered by any current code path.
        /* c8 ignore next 3 */
        if (h.alg !== 'RS256') {
          throw new Error('alg-drift');
        }
        const jwkWithKid = jwk as JwkWithKid;
        // We pass a single-key JWKS containing the already-matched key, so
        // verifyJwtSync will always return the same key. This check guards
        // against hypothetical future internal changes to aws-jwt-verify that
        // could cause a different key to be used; it cannot be triggered by
        // any current code path.
        /* c8 ignore next 3 */
        if (jwkWithKid.kid !== kid) {
          throw new Error('kid-drift');
        }
      },
    });
  } catch (err) {
    // Re-wrap so callers see a uniform error type.
    // `aws-jwt-verify` exclusively throws Error subclasses, so `err instanceof
    // Error` is always true here. The `String(err)` fallback handles the
    // TypeScript `unknown` catch variable but is unreachable at runtime.
    /* c8 ignore next 3 */
    throw new Error(
      `verifyJwt: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Step 5: defensive exp check — aws-jwt-verify already enforces this,
  // but if the payload somehow lacks `exp` we reject (Cognito always
  // emits `exp`, but be defensive).
  if (typeof payload['exp'] !== 'number') {
    throw new Error('verifyJwt: exp missing');
  }

  return payload;
}
