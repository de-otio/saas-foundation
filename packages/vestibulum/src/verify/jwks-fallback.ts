/**
 * [JWKS-FALLBACK] Bounded stale-JWKS fallback for the generic issuer verifier.
 *
 * ## The failure mode this closes
 *
 * `aws-jwt-verify`'s JWKS cache is **in-memory and per-process**. A pod that
 * cold-starts while its IdP is unreachable cannot fetch the JWKS, so *every*
 * authenticated request 401s until the IdP returns. Co-locating the IdP with
 * the app (skybber plan 017 D1) does not create that dependency — it is
 * inherent to OIDC — but it *correlates* the two restarts, which turns a rare
 * edge into a plausible one.
 *
 * The fix is a **last-good-JWKS fallback**: on a successful JWKS fetch,
 * persist the JWKS through a caller-supplied store; when the fetch fails
 * during verifier (re)construction, serve the persisted copy instead — but
 * only if it is well-formed and **at most {@link JWKS_FALLBACK_DEFAULT_MAX_STALENESS_SECONDS}
 * old**.
 *
 * ## No Postgres dependency
 *
 * vestibulum defines only the {@link JwksCacheStore} port (two methods, both
 * string-in/string-out). The consumer supplies the implementation — trellis
 * backs it with its existing `PostgresKvStore`. vestibulum takes no database
 * dependency and no new runtime dependency of any kind.
 *
 * ## Invariants (these are the point of the feature)
 *
 * 1. **The cached value is untrusted input.** It is re-parsed with the same
 *    prototype-pollution-safe parser the library uses (`safeJsonParse`), then
 *    re-validated as a well-formed JWKS (`isJwks`) *plus* a stricter
 *    "has at least one usable signing key" check that `isJwks` does not make.
 *    Any failure is treated as a **cache miss** — never handed to the verifier.
 * 2. **Bounded staleness.** The envelope carries its own `fetchedAt`; an entry
 *    older than the configured bound (default 7 days) is rejected *even if the
 *    store returned it*, so a store that ignores or mis-implements TTL cannot
 *    grant indefinite trust. A `fetchedAt` in the future (beyond a small skew
 *    tolerance) is rejected too — otherwise a forged timestamp would extend the
 *    entry's life without bound.
 * 3. **Issuer + JWKS-URI pinning survive.** The envelope records both, and a
 *    read whose `issuer`/`jwksUri` does not match the verifier's pinned values
 *    is rejected. A store-key collision (or a re-pointed issuer) therefore
 *    cannot substitute another IdP's keys. Audience pinning is untouched: it is
 *    enforced by `aws-jwt-verify` on the token, and nothing here touches tokens.
 * 4. **The happy path is unchanged.** The network fetch is always attempted
 *    first and a successful fetch always wins; the fallback runs only after the
 *    fetch has already failed. The library's own kid-miss → refetch rotation
 *    path is untouched (this module replaces only the `Fetcher`, not the cache
 *    lookup logic), and on a successful fetch the **original bytes** are
 *    returned unmodified so the library's own parser stays authoritative.
 * 5. **Never silent.** Every fallback use emits a warning with issuer, JWKS
 *    URI, entry age, and the underlying fetch error — enough to alert on a
 *    permanently-dead IdP rather than have it masked. Failed/rejected fallbacks
 *    warn as well.
 *
 * ## Not an SSRF-guard change
 *
 * The JWKS URI is not derived from any cached data: it is the verifier's pinned
 * `jwksUri` (or `${issuer}/.well-known/jwks.json`), passed in by the library.
 * This module never constructs, rewrites, or follows a URL, so the discovery
 * SSRF guard in `discovery/private-ip.ts` / `discovery/oidc-probe.ts` is neither
 * used nor weakened here.
 */

import { SimpleFetcher, type Fetcher } from "aws-jwt-verify/https";
import { SimpleJwksCache, isJwks, type Jwk, type Jwks, type JwksCache } from "aws-jwt-verify/jwk";
import { safeJsonParse, type Json } from "aws-jwt-verify/safe-json-parse";

/** Default (and maximum sensible) staleness bound: 7 days. */
export const JWKS_FALLBACK_DEFAULT_MAX_STALENESS_SECONDS = 7 * 24 * 60 * 60;

/**
 * How far a persisted `fetchedAt` may sit in the future before the entry is
 * rejected. Covers ordinary clock skew between pods; anything beyond it looks
 * like a forged timestamp trying to buy unbounded life.
 */
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

/** Envelope format version. A value we do not recognise is a cache miss. */
const ENVELOPE_VERSION = 1;

/**
 * The injectable persistence port. **Optional** — a verifier built without one
 * behaves exactly as before (no store is consulted and no cache object is even
 * constructed).
 *
 * Implementations are expected to be namespaced by the caller (trellis binds a
 * `PostgresKvStore` on its own namespace), to apply their own timeouts, and to
 * treat both the key and the value as opaque.
 */
export interface JwksCacheStore {
  /** Return the previously stored value for `issuer`, or `null` if absent. */
  get(issuer: string): Promise<string | null>;
  /** Store `jwks` (an opaque string) for `issuer` with a relative TTL. */
  set(issuer: string, jwks: string, ttlSeconds: number): Promise<void>;
}

/** Minimal warn-only logger. Defaults to `console.warn`. */
export interface JwksFallbackLogger {
  warn(message: string, context: Readonly<Record<string, unknown>>): void;
}

/** Why a persisted entry was refused. Reported in the warning context. */
export type JwksCacheRejectReason =
  | "absent"
  | "unparseable"
  | "malformed_envelope"
  | "unsupported_version"
  | "issuer_mismatch"
  | "jwks_uri_mismatch"
  | "invalid_timestamp"
  | "too_stale"
  | "invalid_jwks"
  | "no_usable_signing_key";

/** Result of validating a persisted entry. */
export type JwksCacheReadResult =
  | { readonly ok: true; readonly jwks: Jwks; readonly ageSeconds: number }
  | { readonly ok: false; readonly reason: JwksCacheRejectReason };

/** Opt-in configuration for the stale-key fallback. */
export interface JwksFallbackOptions {
  /** The persistence port. Supplying this is what enables the fallback. */
  readonly store: JwksCacheStore;
  /**
   * Maximum age of a persisted JWKS that may still be served, in seconds.
   * Defaults to {@link JWKS_FALLBACK_DEFAULT_MAX_STALENESS_SECONDS} (7 days).
   * Values `<= 0` disable the fallback read entirely (writes still happen).
   */
  readonly maxStalenessSeconds?: number;
  /** Warning sink. Defaults to `console.warn`. */
  readonly logger?: JwksFallbackLogger;
  /** Injectable clock (epoch ms). Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Override the HTTPS fetch of the JWKS document. Defaults to
   * `aws-jwt-verify`'s own `SimpleFetcher` — i.e. byte-identical network
   * behaviour (same one-shot retry, same error types). Provided for hermetic
   * tests and for consumers that must route the fetch through a proxy.
   */
  readonly fetchJwks?: (
    jwksUri: string,
    requestOptions?: Record<string, unknown>,
    data?: ArrayBuffer,
  ) => Promise<ArrayBuffer>;
}

/** {@link JwksFallbackOptions} plus the issuer the verifier pinned. */
export interface JwksFallbackCacheDeps extends JwksFallbackOptions {
  /** The verifier's pinned issuer — the store key and an envelope invariant. */
  readonly issuer: string;
}

const defaultLogger: JwksFallbackLogger = {
  warn(message, context) {
    // eslint-disable-next-line no-console
    console.warn(message, context);
  },
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Stricter than the library's `isJwk`: a key is *usable for verification* only
 * if it has a `kid` (the library looks keys up by `kid` and ignores the rest),
 * is not marked encryption-only, and carries the parameters its `kty` requires.
 *
 * `isJwks` alone accepts `{ "keys": [{ "kty": "RSA" }] }` — structurally a JWKS,
 * operationally useless, and exactly the shape a poisoned cache entry would
 * take to look valid.
 */
function isUsableSigningJwk(jwk: Jwk): boolean {
  if (!isNonEmptyString(jwk.kid)) return false;
  if (jwk.use !== undefined && jwk.use !== "sig") return false;
  switch (jwk.kty) {
    case "RSA":
      return isNonEmptyString(jwk.n) && isNonEmptyString(jwk.e);
    case "EC":
      return isNonEmptyString(jwk.crv) && isNonEmptyString(jwk.x) && isNonEmptyString(jwk.y);
    case "OKP":
      return isNonEmptyString(jwk.crv) && isNonEmptyString(jwk.x);
    default:
      return false;
  }
}

/**
 * Validate an untrusted persisted entry. Pure — no I/O, no clock read (the
 * caller passes `nowMs`), so every branch is directly testable.
 *
 * Exported for the test suite and for consumers that want to assert on a stored
 * value; treat as package-internal API.
 */
export function readCachedJwks(
  raw: string | null,
  expected: {
    readonly issuer: string;
    readonly jwksUri: string;
    readonly nowMs: number;
    readonly maxStalenessSeconds: number;
  },
): JwksCacheReadResult {
  if (raw === null || raw.length === 0) return { ok: false, reason: "absent" };
  if (expected.maxStalenessSeconds <= 0) return { ok: false, reason: "too_stale" };

  let parsed: Json;
  try {
    // Same prototype-pollution-safe parse the library applies to a fetched JWKS.
    parsed = safeJsonParse(raw);
  } catch {
    return { ok: false, reason: "unparseable" };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "malformed_envelope" };
  }
  const envelope = parsed;

  if (envelope["v"] !== ENVELOPE_VERSION) return { ok: false, reason: "unsupported_version" };

  // Issuer pinning (mirrors the verifier-level iss pin): a store-key collision or a re-pointed
  // issuer must not be able to substitute another IdP's keys.
  if (envelope["issuer"] !== expected.issuer) return { ok: false, reason: "issuer_mismatch" };
  if (envelope["jwksUri"] !== expected.jwksUri) return { ok: false, reason: "jwks_uri_mismatch" };

  const fetchedAt = envelope["fetchedAt"];
  if (typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt) || fetchedAt <= 0) {
    return { ok: false, reason: "invalid_timestamp" };
  }
  // A future timestamp would extend the entry's usable life without bound.
  if (fetchedAt > expected.nowMs + CLOCK_SKEW_TOLERANCE_MS) {
    return { ok: false, reason: "invalid_timestamp" };
  }

  const ageMs = Math.max(0, expected.nowMs - fetchedAt);
  if (ageMs > expected.maxStalenessSeconds * 1000) return { ok: false, reason: "too_stale" };

  const jwks: Json = envelope["jwks"] ?? null;
  if (!isJwks(jwks)) return { ok: false, reason: "invalid_jwks" };
  if (!jwks.keys.some(isUsableSigningJwk)) return { ok: false, reason: "no_usable_signing_key" };

  return { ok: true, jwks, ageSeconds: Math.floor(ageMs / 1000) };
}

/** Serialise a freshly fetched JWKS into the persisted envelope form. */
export function buildJwksEnvelope(args: {
  readonly issuer: string;
  readonly jwksUri: string;
  readonly fetchedAtMs: number;
  readonly jwks: Jwks;
}): string {
  return JSON.stringify({
    v: ENVELOPE_VERSION,
    issuer: args.issuer,
    jwksUri: args.jwksUri,
    fetchedAt: args.fetchedAtMs,
    jwks: args.jwks,
  });
}

const utf8Decoder = new TextDecoder("utf8", { fatal: true, ignoreBOM: true });
const utf8Encoder = new TextEncoder();

/** Decode fetched bytes to a JWKS, or `null` if they are not one. */
function decodeJwks(bin: ArrayBuffer): Jwks | null {
  let parsed: Json;
  try {
    parsed = safeJsonParse(utf8Decoder.decode(bin));
  } catch {
    return null;
  }
  return isJwks(parsed) ? parsed : null;
}

function encodeJwks(jwks: Jwks): ArrayBuffer {
  const bytes = utf8Encoder.encode(JSON.stringify(jwks));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * A {@link Fetcher} that persists the last-good JWKS and, when the network
 * fetch fails, serves a bounded-stale persisted copy instead.
 *
 * Deliberately implemented at the `Fetcher` seam rather than by replacing the
 * whole `JwksCache`: the library's kid-miss → refetch rotation logic, its
 * penalty box, and its parser all stay exactly as shipped.
 */
class StaleFallbackFetcher implements Fetcher {
  private readonly delegate: Fetcher["fetch"];
  private readonly logger: JwksFallbackLogger;
  private readonly now: () => number;
  private readonly maxStalenessSeconds: number;

  constructor(private readonly deps: JwksFallbackCacheDeps) {
    const simple = new SimpleFetcher();
    this.delegate = deps.fetchJwks ?? simple.fetch.bind(simple);
    this.logger = deps.logger ?? defaultLogger;
    this.now = deps.now ?? Date.now;
    this.maxStalenessSeconds =
      deps.maxStalenessSeconds ?? JWKS_FALLBACK_DEFAULT_MAX_STALENESS_SECONDS;
  }

  async fetch(
    uri: string,
    requestOptions?: Record<string, unknown>,
    data?: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    let bytes: ArrayBuffer;
    try {
      bytes = await this.delegate(uri, requestOptions, data);
    } catch (err) {
      // The IdP is unreachable / returned non-200. This is the case the whole
      // feature exists for.
      const cached = await this.tryCached(uri, err);
      if (cached !== null) return cached;
      throw err;
    }

    const fresh = decodeJwks(bytes);
    if (fresh === null) {
      // Reachable but not serving a JWKS (broken deploy, captive portal, …).
      // Do NOT persist it. Prefer a good stale copy; if there is none, hand the
      // original bytes back so the library raises its own JwksValidationError —
      // byte-identical to the pre-fallback behaviour.
      const cached = await this.tryCached(
        uri,
        new Error("JWKS endpoint responded but the body is not a well-formed JWKS"),
      );
      return cached ?? bytes;
    }

    // Successful fetch — always wins. Persist best-effort, then return the
    // ORIGINAL bytes untouched.
    await this.persist(uri, fresh);
    return bytes;
  }

  /** Best-effort persist. A store failure must never fail verification. */
  private async persist(jwksUri: string, jwks: Jwks): Promise<void> {
    try {
      await this.deps.store.set(
        this.deps.issuer,
        buildJwksEnvelope({
          issuer: this.deps.issuer,
          jwksUri,
          fetchedAtMs: this.now(),
          jwks,
        }),
        this.maxStalenessSeconds,
      );
    } catch (err) {
      this.logger.warn("vestibulum: JWKS cache write failed (fallback may be unavailable)", {
        event: "jwks_cache_write_failed",
        issuer: this.deps.issuer,
        jwksUri,
        error: describeError(err),
      });
    }
  }

  /**
   * Read + validate the persisted entry. Returns the encoded JWKS bytes on a
   * usable hit, `null` on any miss/rejection. Warns in every case — a fallback
   * that fires, and a fallback that could not fire, are both operational
   * signals about a dead IdP.
   */
  private async tryCached(jwksUri: string, cause: unknown): Promise<ArrayBuffer | null> {
    const base = {
      issuer: this.deps.issuer,
      jwksUri,
      fetchError: describeError(cause),
    };

    let raw: string | null;
    try {
      raw = await this.deps.store.get(this.deps.issuer);
    } catch (err) {
      this.logger.warn("vestibulum: JWKS fetch failed and the fallback store read also failed", {
        event: "jwks_fallback_unavailable",
        ...base,
        reason: "store_error",
        storeError: describeError(err),
      });
      return null;
    }

    const result = readCachedJwks(raw, {
      issuer: this.deps.issuer,
      jwksUri,
      nowMs: this.now(),
      maxStalenessSeconds: this.maxStalenessSeconds,
    });

    if (!result.ok) {
      this.logger.warn("vestibulum: JWKS fetch failed and no usable cached JWKS is available", {
        event: "jwks_fallback_unavailable",
        ...base,
        reason: result.reason,
        maxStalenessSeconds: this.maxStalenessSeconds,
      });
      return null;
    }

    this.logger.warn(
      "vestibulum: JWKS fetch failed — serving a STALE cached JWKS (IdP may be down)",
      {
        event: "jwks_fallback_used",
        ...base,
        ageSeconds: result.ageSeconds,
        maxStalenessSeconds: this.maxStalenessSeconds,
        keyCount: result.jwks.keys.length,
      },
    );
    return encodeJwks(result.jwks);
  }
}

/**
 * Build the `aws-jwt-verify` `JwksCache` that adds the bounded stale-key
 * fallback. Everything except the `Fetcher` is the library default
 * (`SimplePenaltyBox`, the library's own `jwksParser`).
 *
 * Construct one **per `JwtVerifier` instance**: the in-memory JWKS must still
 * be dropped when the verifier is rebuilt, or the [SEC-2] signature-failure
 * reset would no longer force a refetch.
 */
export function createStaleFallbackJwksCache(deps: JwksFallbackCacheDeps): JwksCache {
  if (!isNonEmptyString(deps.issuer)) {
    throw new Error("createStaleFallbackJwksCache: issuer is required");
  }
  return new SimpleJwksCache({ fetcher: new StaleFallbackFetcher(deps) });
}
