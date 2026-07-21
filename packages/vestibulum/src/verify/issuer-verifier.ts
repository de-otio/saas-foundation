/**
 * Generic single-issuer OIDC JWT verifier.
 *
 * Where {@link createMultiPoolVerifier} is Cognito-pool-pinned, this verifier
 * is **provider-neutral**: it pins one exact `iss` + `aud` and fetches that
 * issuer's JWKS, with **no Cognito assumptions baked into the crypto path**. It
 * is built on `aws-jwt-verify`'s generic `JwtVerifier` (the same audited crypto
 * the Cognito verifier uses) — we add **zero verification crypto**, only three
 * `customJwtCheck` gates and a narrowed reset/retry wrapper.
 *
 * ## The three fail-closed gates (WS-3.1 security MUSTs)
 *
 * `aws-jwt-verify` runs `customJwtCheck` *after* it has already validated the
 * signature, `iss`, `aud`, `exp` and `nbf`. Our check adds, in order:
 *
 *   1. **[SEC-1] `exp` presence.** The library skips the expiry check entirely
 *      when `exp` is absent — a no-`exp` token would otherwise verify forever.
 *      We reject unless `exp` is present and a finite number. (Standard expiry
 *      against `graceSeconds` has already run for a *present* `exp`.)
 *   2. **[SEC-5] algorithm allowlist.** The library accepts `EdDSA` and `PS256`
 *      when the JWKS advertises the matching key. We reject any header `alg`
 *      outside {@link PERMITTED_ALGS} (RS/ES only). This runs post-signature by
 *      design — the point is to reject an *otherwise-valid* EdDSA/PS256 token.
 *   3. **Issuer-aware token shape.** For a Cognito issuer, enforce
 *      `token_use === "id"` (reproduces `CognitoJwtInvalidTokenUseError`, and
 *      explicitly rejects an access token). For a generic OIDC issuer
 *      (Keycloak/Zitadel — config-only in WS-3.1, wired live in WS-3.3),
 *      optionally assert `typ` / `azp` per the issuer's profile.
 *
 * ## [SEC-2] Narrowed reset/retry
 *
 * A rotated signing key whose new `kid` is not yet cached surfaces as a
 * signature/key-not-found failure. Only *that* class of failure can change on
 * a JWKS refetch, so the wrapper resets + retries **exactly once, only for
 * `invalid_signature`**. Every other reason (expired, wrong aud/iss/token_use,
 * malformed, missing_exp, disallowed_alg) is permanent and fails immediately —
 * retrying them wastes work and lets an attacker thrash the JWKS cache.
 *
 * ## Namespacing note (WS-3.1 §3.5 [SEC-3])
 *
 * This verifier trusts the pinned single `iss`; the caller keys identity on the
 * bare `sub`. That is safe only for a single live issuer or a sequential
 * Cognito→Keycloak swap with `sub` preserved 1:1. Concurrent multi-issuer
 * operation needs an `{iss}#{sub}` identity key (a data migration) — deferred
 * to WS-3.3.
 */

import { JwtVerifier } from "aws-jwt-verify";
import {
  JwtExpiredError,
  JwtInvalidAudienceError,
  JwtInvalidIssuerError,
  JwtInvalidSignatureAlgorithmError,
  JwtInvalidSignatureError,
  JwtNotBeforeError,
  JwtParseError,
  JwtWithoutValidKidError,
  KidNotFoundInJwksError,
  JwksNotAvailableInCacheError,
  FetchError,
} from "aws-jwt-verify/error";

import { IssuerVerifierError } from "../errors.js";
import { PERMITTED_ALGS } from "./permitted-algs.js";

/**
 * The classic Cognito issuer host. A Cognito issuer looks like
 * `https://cognito-idp.<region>.amazonaws.com/<poolId>`. Used to decide which
 * issuer-aware token-shape branch to apply.
 */
const COGNITO_ISSUER_RE = /^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[^/]+$/;

/** Config for {@link createIssuerVerifier}. */
export interface IssuerVerifierConfig {
  /** Exact `iss` to pin (also the JWKS discovery base when `jwksUri` unset). */
  readonly issuer: string;
  /** Expected `aud`. A single string or a set of acceptable audiences. */
  readonly audience: string | ReadonlyArray<string>;
  /**
   * Explicit JWKS override (air-gapped / fixture tests). When unset the library
   * derives `${issuer}/.well-known/jwks.json`.
   */
  readonly jwksUri?: string;
  /**
   * Clock-skew leeway in seconds. Defaults to `0` — the confirmed
   * `CognitoJwtVerifier` / generic `JwtVerifier` shared default (both resolve
   * `graceSeconds ?? 0` in the library's `validateJwtFields`), set explicitly
   * here so it is review-visible. Behavior parity, not a new policy.
   */
  readonly graceSeconds?: number;
  /**
   * `"cognito"` → enforce `token_use`. `"generic"` → OIDC issuer (Keycloak/
   * Zitadel); enforce optional `typ` / `azp` instead. When omitted it is
   * inferred from the issuer URL shape.
   */
  readonly issuerKind?: "cognito" | "generic";
  /** Required Cognito `token_use` (default `"id"`). Only used for cognito. */
  readonly tokenUse?: "id" | "access";
  /** Generic issuers only: expected `azp` (authorized party), if pinned. */
  readonly expectedAzp?: string;
  /** Generic issuers only: expected `typ`, if pinned (e.g. `"Bearer"`). */
  readonly expectedTyp?: string;
  /** Override the alg allowlist (defaults to {@link PERMITTED_ALGS}). */
  readonly algAllowlist?: ReadonlySet<string>;
}

/** The shape returned by {@link IssuerVerifier.verify}. */
export interface IssuerVerifiedToken {
  /** The pinned, now-verified issuer. */
  readonly issuer: string;
  /** The verified JWT payload as a plain object. */
  readonly claims: Readonly<Record<string, unknown>>;
  /** The original token string, unchanged. */
  readonly rawToken: string;
}

export interface IssuerVerifier {
  /**
   * Verify a JWT against the pinned issuer.
   * @throws {IssuerVerifierError} on any verification failure.
   */
  verify(token: string): Promise<IssuerVerifiedToken>;
}

type RawJwtVerifier = { verify(token: string): Promise<Record<string, unknown>> };

function resolveIssuerKind(config: IssuerVerifierConfig): "cognito" | "generic" {
  if (config.issuerKind !== undefined) return config.issuerKind;
  return COGNITO_ISSUER_RE.test(config.issuer) ? "cognito" : "generic";
}

/**
 * Build the `customJwtCheck` that enforces the three fail-closed gates. Runs
 * after the library's signature + standard-claim validation. Throws
 * {@link IssuerVerifierError} — which propagates unwrapped (we do not set
 * `includeRawJwtInErrors`).
 */
function buildCustomJwtCheck(
  config: IssuerVerifierConfig,
  kind: "cognito" | "generic",
): (props: { header: { alg?: string; typ?: string }; payload: Record<string, unknown> }) => void {
  const allowlist = config.algAllowlist ?? PERMITTED_ALGS;
  const tokenUse = config.tokenUse ?? "id";

  return ({ header, payload }) => {
    // [SEC-1] exp must be present and a finite number.
    const exp = payload["exp"];
    if (typeof exp !== "number" || !Number.isFinite(exp)) {
      throw new IssuerVerifierError(
        "missing_exp",
        "Token has no finite exp claim; refusing to treat it as non-expiring.",
      );
    }

    // [SEC-5] algorithm allowlist (rejects EdDSA / PS256 the library accepts).
    const alg = header.alg;
    if (typeof alg !== "string" || !allowlist.has(alg)) {
      throw new IssuerVerifierError(
        "disallowed_alg",
        `Token signing algorithm "${String(alg)}" is not in the permitted RS/ES allowlist.`,
      );
    }

    // Issuer-aware token-shape assertion.
    if (kind === "cognito") {
      if (payload["token_use"] !== tokenUse) {
        throw new IssuerVerifierError(
          "wrong_token_use",
          `Token token_use "${String(payload["token_use"])}" does not match the required "${tokenUse}".`,
        );
      }
    } else {
      // Generic OIDC (Keycloak/Zitadel). Cognito access tokens carry
      // `token_use: "access"` and no `aud`; such a token cannot reach here
      // (aud is pinned) but reject the shape defensively regardless.
      if (payload["token_use"] === "access") {
        throw new IssuerVerifierError(
          "wrong_token_use",
          "Access-token shape (token_use=access) is not accepted on the generic issuer path.",
        );
      }
      if (config.expectedTyp !== undefined && header.typ !== config.expectedTyp) {
        throw new IssuerVerifierError(
          "invalid_claim",
          `Token typ "${String(header.typ)}" does not match the required "${config.expectedTyp}".`,
        );
      }
      if (config.expectedAzp !== undefined && payload["azp"] !== config.expectedAzp) {
        throw new IssuerVerifierError(
          "invalid_claim",
          `Token azp "${String(payload["azp"])}" does not match the required "${config.expectedAzp}".`,
        );
      }
    }
  };
}

/**
 * Map an `aws-jwt-verify` error (or a passthrough {@link IssuerVerifierError}
 * from the customJwtCheck) onto the {@link IssuerVerifierError} taxonomy.
 *
 * Order matters: the temporal/claim subclasses are checked before their
 * `JwtInvalidClaimError` base.
 */
function toIssuerError(err: unknown): IssuerVerifierError {
  if (err instanceof IssuerVerifierError) return err;
  if (err instanceof JwtExpiredError) {
    return new IssuerVerifierError("expired", "Token has expired.");
  }
  if (err instanceof JwtNotBeforeError) {
    return new IssuerVerifierError("not_yet_valid", "Token is not yet valid (nbf in the future).");
  }
  if (err instanceof JwtInvalidIssuerError) {
    return new IssuerVerifierError("unknown_issuer", "Token issuer does not match the pinned issuer.");
  }
  if (err instanceof JwtInvalidAudienceError) {
    return new IssuerVerifierError("wrong_audience", "Token audience does not match the pinned audience.");
  }
  // Signature / key-not-found / JWKS-fetch: the ONLY retryable class. A key
  // rotated in after the last JWKS fetch presents as a missing kid, a fresh
  // JWKS fetch, or a signature mismatch — all cases where a reset+refetch can
  // legitimately change the outcome. A genuine JWKS-down still fails closed
  // (the single retry also fails and this error is thrown → 401).
  if (
    err instanceof JwtInvalidSignatureError ||
    err instanceof JwtInvalidSignatureAlgorithmError ||
    err instanceof KidNotFoundInJwksError ||
    err instanceof JwtWithoutValidKidError ||
    err instanceof JwksNotAvailableInCacheError ||
    err instanceof FetchError
  ) {
    return new IssuerVerifierError("invalid_signature", "Token signature could not be verified.");
  }
  if (err instanceof JwtParseError) {
    return new IssuerVerifierError("malformed_token", "Token is not a well-formed JWT.");
  }
  return new IssuerVerifierError("malformed_token", "Token could not be verified.");
}

/**
 * Create a generic single-issuer OIDC verifier.
 *
 * The underlying `JwtVerifier` (and thus its JWKS cache) is lazily
 * (re)constructed. On an `invalid_signature` failure the wrapper resets the
 * verifier once and retries — nothing else is retried ([SEC-2]).
 */
export function createIssuerVerifier(config: IssuerVerifierConfig): IssuerVerifier {
  if (typeof config.issuer !== "string" || config.issuer.length === 0) {
    throw new Error("createIssuerVerifier: issuer is required");
  }
  const kind = resolveIssuerKind(config);
  const customJwtCheck = buildCustomJwtCheck(config, kind);
  const audience: string | string[] =
    typeof config.audience === "string" ? config.audience : [...config.audience];
  const graceSeconds = config.graceSeconds ?? 0;

  const build = (): RawJwtVerifier =>
    JwtVerifier.create({
      issuer: config.issuer,
      audience,
      ...(config.jwksUri !== undefined ? { jwksUri: config.jwksUri } : {}),
      graceSeconds,
      customJwtCheck,
    });

  let verifier: RawJwtVerifier = build();

  const runOnce = async (token: string): Promise<IssuerVerifiedToken> => {
    const claims = await verifier.verify(token);
    return { issuer: config.issuer, claims, rawToken: token };
  };

  return {
    async verify(token: string): Promise<IssuerVerifiedToken> {
      if (typeof token !== "string" || token.length === 0) {
        throw new IssuerVerifierError("malformed_token", "Token is empty or not a string.");
      }
      try {
        return await runOnce(token);
      } catch (err) {
        const mapped = toIssuerError(err);
        // [SEC-2] retry ONLY on a signature/key failure — the one reason a JWKS
        // refetch can change. All other reasons fail immediately.
        if (mapped.reason === "invalid_signature") {
          verifier = build();
          try {
            return await runOnce(token);
          } catch (retryErr) {
            throw toIssuerError(retryErr);
          }
        }
        throw mapped;
      }
    },
  };
}
