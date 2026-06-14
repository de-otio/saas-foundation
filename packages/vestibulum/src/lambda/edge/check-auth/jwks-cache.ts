/**
 * Module-scoped JWKS cache wrapper for Lambda@Edge `check-auth`.
 *
 * Lambda@Edge nodes survive across invocations (warm-container reuse), so
 * holding the verifier and its JWKS cache in module scope means the JWKS
 * is fetched at most once per cold start and reused for every subsequent
 * verification. This is critical for both latency (no per-request
 * round-trip to Cognito) and rate-limit safety (Cognito JWKS endpoints
 * are rate-limited; per-request fetches would breach them under load).
 *
 * TTL discipline:
 * - Hard TTL: 15 minutes. After 15 minutes the cache is invalidated and
 *   the next verification triggers a refetch. Cognito JWKS rotate rarely
 *   (roughly once per year) but the shorter TTL bounds drift between
 *   rotation and cache refresh.
 * - No stale-while-error fallback: if the refetch fails, the next
 *   verification fails closed (302). The cache never serves stale keys
 *   past the TTL — the security cost of accepting a JWT signed by a
 *   retired key outweighs the availability cost of a brief 302 storm
 *   during a JWKS rotation.
 *
 * Why a custom wrapper rather than `aws-jwt-verify`'s SimpleJwksCache
 * default: SimpleJwksCache caches indefinitely. We want a hard expiry.
 * The wrapper sits between the verifier and SimpleJwksCache and resets
 * the inner cache instance every TTL window.
 *
 * No third-party HTTP client and no `@aws-sdk/*` imports: aws-jwt-verify
 * uses the runtime's `fetch` (Node 18+), which is the only network call
 * the bundle makes.
 */

import { SimpleJwksCache, type Jwks, type JwkWithKid } from "aws-jwt-verify/jwk";
import type { JwksCache } from "aws-jwt-verify/jwk";
import type { JwtHeader, JwtPayload } from "aws-jwt-verify/jwt-model";

/** JWKS cache TTL: 15 minutes (in milliseconds). */
export const JWKS_CACHE_TTL_MS = 15 * 60 * 1000;

interface DecomposedJwt {
  header: JwtHeader;
  payload: JwtPayload;
}

/**
 * A `JwksCache` implementation that delegates to an internal
 * `SimpleJwksCache` and discards it after `ttlMs` milliseconds. The next
 * call after expiry creates a fresh inner cache, which triggers a JWKS
 * refetch.
 *
 * Fail-closed semantics: this wrapper never catches errors from the
 * inner cache. Any rejection — network failure, non-2xx response,
 * malformed JWKS — propagates up to the verifier, which surfaces it to
 * the handler, which redirects the viewer to `/login`. There is no
 * "let through on transient errors" path.
 */
export class TtlBoundedJwksCache implements JwksCache {
  private readonly ttlMs: number;
  private inner: SimpleJwksCache;
  private innerCreatedAt: number;

  /**
   * @param ttlMs - Cache lifetime in milliseconds. Falls back to
   *   `JWKS_CACHE_TTL_MS` (15 min). Exposed for tests; production
   *   callers should use the default.
   */
  public constructor(ttlMs: number = JWKS_CACHE_TTL_MS) {
    this.ttlMs = ttlMs;
    this.inner = new SimpleJwksCache();
    this.innerCreatedAt = Date.now();
  }

  /**
   * Return the current inner cache, recreating it if the TTL has expired.
   *
   * Recreation is the only way to invalidate `SimpleJwksCache`; it has no
   * public clear method. Swapping the reference is cheap.
   */
  private getActiveInner(): SimpleJwksCache {
    if (Date.now() - this.innerCreatedAt >= this.ttlMs) {
      this.inner = new SimpleJwksCache();
      this.innerCreatedAt = Date.now();
    }
    return this.inner;
  }

  public getJwk(jwksUri: string, decomposedJwt: DecomposedJwt): Promise<JwkWithKid> {
    return this.getActiveInner().getJwk(jwksUri, decomposedJwt);
  }

  public getCachedJwk(jwksUri: string, decomposedJwt: DecomposedJwt): JwkWithKid {
    return this.getActiveInner().getCachedJwk(jwksUri, decomposedJwt);
  }

  public addJwks(jwksUri: string, jwks: Jwks): void {
    this.getActiveInner().addJwks(jwksUri, jwks);
  }

  public getJwks(jwksUri: string): Promise<Jwks> {
    return this.getActiveInner().getJwks(jwksUri);
  }
}
