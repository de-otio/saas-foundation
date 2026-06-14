/**
 * JWKS fetch + cache for the shared-distribution Lambda@Edge `check-auth`
 * handler.
 *
 * Posture (review fix H6):
 * - TTL is fixed at construction (default 15 min via the construct prop;
 *   the bundle config bakes a literal value in).
 * - On refresh, the new JWKS set **completely replaces** the old set.
 *   No union with previous keys. A token whose `kid` was valid in the
 *   previous set but is absent from the freshly-refreshed set is
 *   rejected at signature verification.
 * - Errors propagate (fail-closed). The cache entry is cleared so the
 *   next call retries instead of locking to a transient failure.
 * - Parse error of the fetched JWKS → reject (do not store malformed
 *   JSON or non-object responses).
 *
 * The cache holds at most one entry (one JWKS URL per bundle), so we
 * keep the state shape minimal — no Map.
 */

/**
 * Minimal JWK shape we expose to callers. We deliberately don't import
 * `aws-jwt-verify`'s `Jwk` type here because this module is small enough
 * to be self-contained and keeps the contract obvious at the boundary.
 *
 * The verifier accepts any object that JSON-parsed from a Cognito JWKS;
 * we re-narrow on the consuming side.
 */
export type JsonWebKey = Record<string, unknown>;

/**
 * Options for the `fetch`-like function the cache uses. Defaulted to the
 * global `fetch` (Node 20+ ships it). Tests override.
 */
export type JwksFetcher = (url: string) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** Time source. Tests override. */
export type ClockFn = () => number;

export interface JwksCacheOptions {
  /** JWKS endpoint URL. Validated as a non-empty string by the caller. */
  readonly jwksUrl: string;
  /** Cache lifetime in milliseconds. Must be a positive finite number. */
  readonly ttlMs: number;
  /** Override the HTTP fetcher (tests). Defaults to global `fetch`. */
  readonly fetcher?: JwksFetcher;
  /** Override the clock (tests). Defaults to `Date.now`. */
  readonly clock?: ClockFn;
}

/**
 * JWKS cache. Single-key store. Methods are async because the underlying
 * fetch is.
 */
export class JwksCache {
  private readonly jwksUrl: string;
  private readonly ttlMs: number;
  private readonly fetcher: JwksFetcher;
  private readonly clock: ClockFn;

  private cachedKeys: readonly JsonWebKey[] | undefined = undefined;
  private cachedAt = 0;

  public constructor(opts: JwksCacheOptions) {
    if (!opts.jwksUrl) {
      throw new TypeError('JwksCache: jwksUrl is required');
    }
    if (!(opts.ttlMs > 0) || !Number.isFinite(opts.ttlMs)) {
      throw new TypeError('JwksCache: ttlMs must be a positive finite number');
    }
    this.jwksUrl = opts.jwksUrl;
    this.ttlMs = opts.ttlMs;
    this.fetcher = opts.fetcher ?? defaultFetcher;
    this.clock = opts.clock ?? Date.now;
  }

  /**
   * Return the cached JWKS key set, fetching+caching on miss or when the TTL
   * has elapsed since the last successful fetch.
   *
   * On error: clears any prior cached set and rethrows. The next call will
   * attempt a fresh fetch (no error-caching).
   *
   * On refresh, the cached set is **fully replaced** — there is no union
   * with the previous set.
   */
  public async getJwks(): Promise<readonly JsonWebKey[]> {
    const now = this.clock();
    if (this.cachedKeys !== undefined && now - this.cachedAt < this.ttlMs) {
      return this.cachedKeys;
    }

    let response: Awaited<ReturnType<JwksFetcher>>;
    try {
      response = await this.fetcher(this.jwksUrl);
    } catch (err) {
      this.cachedKeys = undefined;
      this.cachedAt = 0;
      throw err;
    }

    if (!response.ok) {
      this.cachedKeys = undefined;
      this.cachedAt = 0;
      throw new Error(`JWKS fetch failed: HTTP ${response.status}`);
    }

    let parsed: unknown;
    try {
      const body = await response.text();
      parsed = JSON.parse(body);
    } catch (err) {
      this.cachedKeys = undefined;
      this.cachedAt = 0;
      throw new Error(
        `JWKS parse failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as { keys?: unknown }).keys)
    ) {
      this.cachedKeys = undefined;
      this.cachedAt = 0;
      throw new Error('JWKS parse failed: missing `keys` array');
    }

    const keys = (parsed as { keys: unknown[] }).keys.filter(
      (k): k is JsonWebKey => k !== null && typeof k === 'object',
    );

    // Full replace — no union with the prior set (review fix H6).
    this.cachedKeys = Object.freeze(keys.slice());
    this.cachedAt = now;
    return this.cachedKeys;
  }
}

/** Production fetcher. Wraps the global `fetch`. */
const defaultFetcher: JwksFetcher = async (url: string) => {
  const r = await fetch(url);
  return {
    ok: r.ok,
    status: r.status,
    text: () => r.text(),
  };
};
