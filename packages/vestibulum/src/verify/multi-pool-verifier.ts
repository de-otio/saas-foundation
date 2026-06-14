/**
 * Multi-pool JWT verifier.
 *
 * The two-pool federation topology requires consumer APIs to accept tokens
 * from multiple Cognito user pools and to route operations to the correct
 * pool. Getting this wrong is a tenant-isolation breach, so the runtime ships
 * a verifier that makes the safe pattern the easy one.
 *
 * ## Select-by-iss pattern (B-J)
 *
 * The verifier uses the select-by-iss pattern: read the unverified `iss`
 * claim from the JWT header to select which configured pool's verifier to
 * use, then let that verifier check the signature. This is safe because:
 *
 * - `iss` is only trusted AFTER the matching verifier successfully validates
 *   the signature. The `iss` value is untrusted input until then.
 * - Each verifier is bound to a pinned JWKS (the pool's `/.well-known/jwks.json`).
 *   A token claiming an `iss` that matches pool A cannot be verified using
 *   pool B's keys — the signature check prevents cross-pool forgery.
 * - If `iss` is unknown (not in our configured pool map), we reject immediately
 *   with `unknown_issuer` rather than trying all verifiers.
 *
 * This replaces the older "try each verifier in turn" pattern which generated
 * N-1 spurious `invalid_signature` exceptions per legitimate request.
 *
 * ## Safety
 *
 * The select-by-iss pattern does NOT allow the unverified `iss` to influence
 * trust decisions before verification. The pattern is:
 * 1. Decode (not verify) the JWT to extract the `iss` claim.
 * 2. Look up the matching pool verifier by exact `iss` URL.
 * 3. Run the verifier — it validates signature, expiry, audience, etc.
 * 4. Only if step 3 succeeds is the `iss` trusted.
 *
 * See doc/vestibulum/05-jwt-verification.md § Select-by-iss pattern.
 */

import { CognitoJwtVerifier } from "aws-jwt-verify";
import {
  CognitoJwtInvalidClientIdError,
  CognitoJwtInvalidTokenUseError,
  JwtExpiredError,
  JwtInvalidClaimError,
  JwtInvalidSignatureAlgorithmError,
  JwtInvalidSignatureError,
  JwtParseError,
} from "aws-jwt-verify/error";

import { MultiPoolVerifierError } from "../errors.js";

/**
 * Configuration for one Cognito user pool participating in the
 * multi-pool verifier.
 */
export interface PoolConfig {
  /**
   * Stable identifier the consumer assigns (e.g. `'b2c'` or
   * `'b2b'`). Returned in the verified-token output so handlers
   * can branch on it. NOT the Cognito pool ID.
   */
  readonly poolKey: string;

  /** Cognito User Pool ID (e.g. `us-east-1_abcdef`). */
  readonly userPoolId: string;

  /**
   * The app client ID(s) that may legitimately issue tokens from
   * this pool. Matched against the JWT's `client_id` (access
   * tokens) or `aud` (ID tokens) claim.
   */
  readonly clientId: string | string[];

  /** AWS region the user pool lives in. */
  readonly region: string;

  /**
   * Required `token_use` claim value.
   *
   * - `'access'` — only access tokens accepted.
   * - `'id'`     — only ID tokens accepted.
   * - `null`     — both accepted (unsafe; avoid unless you know why).
   *
   * S-V6: the safer default is `'access'` or `'id'`; `null` is
   * documented here as the unsafe permissive value. Callers should
   * always pin to the specific token type their operation requires.
   */
  readonly tokenUse: "access" | "id" | null;
}

/** The shape returned by {@link MultiPoolVerifier.verify}. */
export interface VerifiedToken {
  /**
   * The {@link PoolConfig.poolKey} of the pool that verified the
   * token. Handlers should use this (not the `iss` claim) when
   * branching on token origin.
   */
  readonly poolKey: string;

  /**
   * The verified JWT payload as a plain object. The shape varies
   * by token type and pool configuration; consumers cast on the
   * specific claims they need.
   */
  readonly claims: Readonly<Record<string, unknown>>;

  /** The original token string, unchanged. */
  readonly rawToken: string;
}

/**
 * A multi-pool verifier that accepts tokens from any of a
 * configured list of Cognito user pools, validates them against
 * an exact issuer allowlist, and reports back which pool the
 * token came from.
 */
export interface MultiPoolVerifier {
  /**
   * Verify a JWT and return its verified claims plus the
   * originating pool key.
   *
   * @throws {MultiPoolVerifierError} on any verification failure.
   */
  verify(token: string): Promise<VerifiedToken>;
}

/**
 * Build the canonical Cognito issuer URL for a pool.
 *
 * Exported for test use; not part of the package public surface.
 */
export function canonicalIssuer(region: string, userPoolId: string): string {
  return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
}

/**
 * Internal record bound to one configured pool: its canonical
 * issuer URL, the cached `aws-jwt-verify` instance, and the
 * consumer-supplied `poolKey`.
 */
interface PoolEntry {
  readonly poolKey: string;
  readonly issuer: string;
  readonly verifier: ReturnType<typeof CognitoJwtVerifier.create>;
}

/**
 * Decode the `iss` claim from a JWT without verifying the signature.
 *
 * This is intentionally unverified — it is only used to SELECT which
 * pool verifier to try. The actual trust decision happens after the
 * verifier successfully validates the signature (select-by-iss pattern).
 *
 * Returns `undefined` if the token is structurally invalid.
 */
function decodeIssUnchecked(token: string): string | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const payload = parts[1];
    if (payload === undefined || payload === "") return undefined;
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const obj = JSON.parse(decoded) as Record<string, unknown>;
    const iss = obj["iss"];
    return typeof iss === "string" ? iss : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Create a {@link MultiPoolVerifier} from a list of pool configs.
 *
 * Each {@link PoolConfig} becomes one `CognitoJwtVerifier`. The
 * configs may not share canonical issuer URLs — two entries for
 * the same `(region, userPoolId)` pair is a programming error and
 * throws synchronously.
 */
export function createMultiPoolVerifier(pools: ReadonlyArray<PoolConfig>): MultiPoolVerifier {
  if (pools.length === 0) {
    throw new Error("createMultiPoolVerifier: at least one PoolConfig is required");
  }

  const entries = new Map<string, PoolEntry>();
  for (const pool of pools) {
    const issuer = canonicalIssuer(pool.region, pool.userPoolId);
    if (entries.has(issuer)) {
      throw new Error(`createMultiPoolVerifier: duplicate pool for issuer ${issuer}`);
    }
    const verifier = CognitoJwtVerifier.create({
      userPoolId: pool.userPoolId,
      clientId: pool.clientId,
      tokenUse: pool.tokenUse,
    });
    entries.set(issuer, {
      poolKey: pool.poolKey,
      issuer,
      verifier,
    });
  }

  return {
    async verify(token: string): Promise<VerifiedToken> {
      if (typeof token !== "string" || token.length === 0) {
        throw new MultiPoolVerifierError("malformed_token", "Token is empty or not a string.");
      }

      // B-J: Select-by-iss pattern.
      // 1. Decode (without verifying) the `iss` claim.
      // 2. Look up the matching pool entry by exact issuer URL.
      // 3. Run that pool's verifier — validates signature, expiry, audience.
      // 4. Only if verification succeeds is the token trusted.
      //
      // This avoids the "try each pool in turn" N-1 exception pattern,
      // and makes token processing O(1) in pool count.
      const unverifiedIss = decodeIssUnchecked(token);
      if (unverifiedIss === undefined) {
        throw new MultiPoolVerifierError("malformed_token", "Token is not a well-formed JWT.");
      }

      const entry = entries.get(unverifiedIss);
      if (entry === undefined) {
        // The `iss` claim does not match any configured pool.
        // Reject immediately — no need to try any verifier.
        throw new MultiPoolVerifierError(
          "unknown_issuer",
          "Token issuer does not match any configured pool.",
        );
      }

      // Run the verifier for the selected pool. This is the only
      // place where signature, expiry, audience, etc. are checked.
      // The `iss` value from step 1 is only trusted if this succeeds.
      try {
        const payload = await entry.verifier.verify(token);
        return {
          poolKey: entry.poolKey,
          claims: payload,
          rawToken: token,
        };
      } catch (err: unknown) {
        throw mapError(err);
      }
    },
  };
}

/**
 * Enforce that a verified token came from one of the expected pools.
 *
 * Throws {@link MultiPoolVerifierError} with reason `'wrong_pool'`
 * on mismatch (S-V1: `wrong_pool` is now in the reason union).
 *
 * @example
 * ```ts
 * const token = await verifier.verify(req.bearerToken);
 * requirePool(token, 'b2b');   // tenant-admin op
 * ```
 */
export function requirePool(token: VerifiedToken, expected: string | ReadonlyArray<string>): void {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(token.poolKey)) {
    throw new MultiPoolVerifierError(
      "wrong_pool",
      `Token poolKey "${token.poolKey}" is not in the expected ` + `set [${allowed.join(", ")}].`,
    );
  }
}

/**
 * Map an `aws-jwt-verify` error onto the runtime's
 * {@link MultiPoolVerifierError} taxonomy.
 */
function mapError(err: unknown): MultiPoolVerifierError {
  if (err instanceof JwtExpiredError) {
    return new MultiPoolVerifierError("expired", "Token has expired.");
  }
  if (err instanceof CognitoJwtInvalidClientIdError) {
    return new MultiPoolVerifierError(
      "wrong_client_id",
      "Token client_id does not match any configured app client.",
    );
  }
  if (err instanceof CognitoJwtInvalidTokenUseError) {
    return new MultiPoolVerifierError(
      "wrong_token_use",
      "Token token_use does not match the configured value.",
    );
  }
  if (err instanceof JwtInvalidSignatureError || err instanceof JwtInvalidSignatureAlgorithmError) {
    return new MultiPoolVerifierError("invalid_signature", "Token signature is invalid.");
  }
  if (err instanceof JwtParseError) {
    return new MultiPoolVerifierError("malformed_token", "Token is not a well-formed JWT.");
  }
  if (err instanceof JwtInvalidClaimError) {
    return new MultiPoolVerifierError("malformed_token", "Token has an invalid claim.");
  }
  return new MultiPoolVerifierError("malformed_token", "Token could not be verified.");
}
