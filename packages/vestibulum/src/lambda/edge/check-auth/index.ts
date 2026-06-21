/**
 * Lambda@Edge `check-auth` — viewer-request JWT verifier.
 *
 * Runs on every CloudFront viewer-request behind the protected site. Verifies
 * the Cognito ID-token cookie against the pool's JWKS using `aws-jwt-verify`,
 * with these guarantees:
 *
 * - **Algorithm allow-list = RS256 only.** `alg: none`, `HS*`, and any other
 *   value is rejected before signature verification. Closes the classic
 *   `alg: none` / HS256-key-confusion holes.
 * - **JWKS cache = 15 min hard TTL**, module-scoped (survives warm-container
 *   reuse). No stale-while-error fallback.
 * - **Fail-closed.** Any exception during verification — missing cookie,
 *   malformed JWT, signature mismatch, JWKS fetch failure, audience/issuer
 *   mismatch, expired token — produces a 302 to `/login`. There is no
 *   pass-through.
 * - **No log writes anywhere.** Mandatory Mitigation 1: Lambda@Edge log
 *   suppression. The execution role has no `logs:PutLogEvents` permission
 *   (WS-08 builds the role this way); even so, the source must emit nothing.
 *   CloudWatch logs from Lambda@Edge land in the edge region, outside the
 *   consumer's data-residency boundary — emitting nothing is the only safe
 *   posture. ESLint enforces the no-log rule for `lib/lambda-edge/**`; CI
 *   greps the source and the bundle (WS-12).
 * - **No `@aws-sdk/*` imports.** Bundle size is capped at 1 MB and metric
 *   emission is out of scope for v0.x of this handler (sampled emission
 *   would require an SDK client; tracked separately).
 * - **Synth-time string injection for config.** Lambda@Edge cannot read
 *   environment variables, so WS-08 patches the `// __VESTIBULUM_CONFIG__`
 *   block below at deploy time with concrete values.
 *
 * The handler returns either the original request (ALLOW — CloudFront
 * forwards it to the origin) or a `CloudFrontResultResponse` (302 to
 * `/login`).
 */

import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { JwtHeader } from "aws-jwt-verify/jwt-model";
import { TtlBoundedJwksCache } from "./jwks-cache.js";
import { getCookieValue, type CloudFrontHeaders } from "./cookie.js";
import { resolveCognitoEndpoint, type ResolvedCognitoEndpoint } from "./jwks-region-resolver.js";
import { ID_TOKEN_COOKIE_NAME } from "../../shared/cookie-names.js";

/**
 * Edge-runtime configuration shape. WS-08 emits a concrete object that
 * replaces the `__VESTIBULUM_CONFIG__` placeholder block below at synth
 * time. Field order is part of the contract; do not rearrange without
 * coordinating with the construct's renderer.
 */
export interface VestibulumEdgeConfig {
  /** Cognito User Pool ID, e.g. `eu-central-1_aBcDeFgHi`. */
  readonly userPoolId: string;
  /** Cognito App Client ID for the website client. */
  readonly clientId: string;
  /** Home region (where MagicLinkAuthSite is deployed). Used for future
   * metric emission; the JWKS region is derived from the pool ID instead. */
  readonly homeRegion: string;
  /** Cookie name the ID-token is stored under. */
  readonly idTokenCookieName: string;
  /** Path to redirect unauthenticated viewers to. */
  readonly loginPath: string;
}

// Deploy-time config-injection seam. Lambda@Edge cannot read environment
// variables, and the consumer supplies the pool/client ids as deploy-time
// CloudFormation tokens (not concrete at synth) — so `MagicLinkAuthSite`'s
// `CheckAuthConfigBaker` custom resource string-replaces the three
// `PLACEHOLDER_*` literals below with concrete values at deploy time and
// republishes the function version. The literals are intentionally invalid
// (`resolveCognitoEndpoint` rejects the pool id): if a build ever ships them,
// every request fails CLOSED to /login rather than trusting a wrong pool.
//
// `idTokenCookieName` and `loginPath` are NOT injected — they are concrete and
// must match the regional handlers, so they come from the shared constant.
let VESTIBULUM_CONFIG: VestibulumEdgeConfig = {
  userPoolId: "PLACEHOLDER_USER_POOL_ID",
  clientId: "PLACEHOLDER_CLIENT_ID",
  homeRegion: "PLACEHOLDER_REGION",
  idTokenCookieName: ID_TOKEN_COOKIE_NAME,
  loginPath: "/login",
};

/**
 * Module-scoped JWKS cache. Lambda@Edge warm-container reuse means this
 * survives across invocations; the wrapper enforces a 15-minute hard TTL.
 *
 * Declared `let` (not `const`) so `__resetForTests` can swap in a fresh
 * cache between tests — the wrapper exposes no clear method.
 */
let jwksCache = new TtlBoundedJwksCache();

/** Resolved endpoint cached at first use; recomputed if the config rotates. */
let resolvedEndpoint: ResolvedCognitoEndpoint | undefined;

/** Verifier instance, built lazily so misconfigured deploys fail per-request,
 * not at module load (which would 502 the whole edge node). */
let verifier: ReturnType<typeof createInternalVerifier> | undefined;

/**
 * Build a `CognitoJwtVerifier` configured for ID tokens, single audience,
 * 60-second clock skew, and an RS256-only `alg` check. The RS256 check is
 * implemented via `customJwtCheck` because `aws-jwt-verify` itself accepts
 * RS256/RS384/RS512 — we want only RS256.
 */
function createInternalVerifier(endpoint: ResolvedCognitoEndpoint) {
  return CognitoJwtVerifier.create(
    {
      userPoolId: VESTIBULUM_CONFIG.userPoolId,
      tokenUse: "id",
      clientId: VESTIBULUM_CONFIG.clientId,
      graceSeconds: 60,
      customJwtCheck: ({ header }: { header: JwtHeader }) => {
        // Reject any algorithm other than RS256. Belt-and-braces against
        // `alg: none` and HS256 key-confusion: aws-jwt-verify would already
        // reject `alg: none`, but its default RSA verifier accepts
        // RS256/384/512; we deliberately restrict to RS256 alone.
        if (header.alg !== "RS256") {
          throw new Error("unexpected_alg");
        }
      },
      // Override the inferred issuer with the explicitly-derived one so the
      // verifier never falls back to a guess when the pool ID is malformed.
      issuer: endpoint.issuer,
    },
    { jwksCache },
  );
}

/**
 * Lazily build (and memoise) the verifier on first verification. We can't do
 * this at module-load time because a misconfigured pool ID would crash the
 * Lambda@Edge function on every cold start with a 5xx; doing it per-request
 * lets us redirect to `/login` instead, which is the user-visible behaviour
 * we want for all failure modes.
 */
function getVerifier(): ReturnType<typeof createInternalVerifier> | undefined {
  if (verifier) {
    return verifier;
  }
  if (!resolvedEndpoint) {
    resolvedEndpoint = resolveCognitoEndpoint(VESTIBULUM_CONFIG.userPoolId);
  }
  if (!resolvedEndpoint) {
    return undefined;
  }
  verifier = createInternalVerifier(resolvedEndpoint);
  return verifier;
}

/**
 * CloudFront viewer-request event shape (minimal subset we touch).
 */
export interface CloudFrontRequestEvent {
  readonly Records: ReadonlyArray<{
    readonly cf: {
      readonly request: CloudFrontRequest;
    };
  }>;
}

/** CloudFront viewer-request `request` object (minimal subset). */
export interface CloudFrontRequest {
  readonly headers?: CloudFrontHeaders;
  readonly uri?: string;
  readonly method?: string;
  readonly querystring?: string;
}

/** CloudFront result-response object (used for the 302). */
export interface CloudFrontResultResponse {
  readonly status: string;
  readonly statusDescription: string;
  readonly headers: CloudFrontHeaders;
}

/**
 * The Lambda@Edge handler return value: either the original request (ALLOW)
 * or a synthesised response (DENY → 302).
 */
export type CheckAuthResult = CloudFrontRequest | CloudFrontResultResponse;

/**
 * Build the deterministic 302-to-login response.
 */
function redirectToLogin(): CloudFrontResultResponse {
  return {
    status: "302",
    statusDescription: "Found",
    headers: {
      location: [{ key: "Location", value: VESTIBULUM_CONFIG.loginPath }],
      "cache-control": [{ key: "Cache-Control", value: "no-store, max-age=0" }],
    },
  };
}

/**
 * Lambda@Edge viewer-request entry point.
 *
 * @param event - The CloudFront viewer-request event. Exactly one record is
 *   expected; we read `Records[0].cf.request`.
 * @returns The original request (ALLOW) or a 302 response (DENY).
 */
export async function handler(event: CloudFrontRequestEvent): Promise<CheckAuthResult> {
  // Defensive: any missing structural piece → fail closed.
  const record = event?.Records?.[0];
  const request = record?.cf?.request;
  if (!request) {
    return redirectToLogin();
  }

  try {
    const token = getCookieValue(request.headers, VESTIBULUM_CONFIG.idTokenCookieName);
    if (token === undefined || token === "") {
      return redirectToLogin();
    }

    const v = getVerifier();
    if (!v) {
      return redirectToLogin();
    }

    await v.verify(token);

    // Verified. Return the original request so CloudFront forwards to origin.
    return request;
  } catch {
    // Catch EVERY exception. The fail-closed posture means a 302 to /login
    // is the only outcome on any verifier or runtime error. Never re-throw.
    return redirectToLogin();
  }
}

/**
 * Factory variant of the handler for dependency injection in tests.
 *
 * The module-level `handler` export is used for the deployed bundle (synth-
 * time config injection). This factory allows tests to override config and
 * inject a test JWKS cache without mutating module state.
 */
export function createEdgeCheckAuthHandler(config?: Partial<VestibulumEdgeConfig>) {
  if (config) {
    VESTIBULUM_CONFIG = { ...VESTIBULUM_CONFIG, ...config };
    resolvedEndpoint = undefined;
    verifier = undefined;
    jwksCache = new TtlBoundedJwksCache();
  }
  return handler;
}

/**
 * Test-only: reset module-scope state and (optionally) override the config.
 * Exported under a `__`-prefixed name so tree-shaking keeps it out of the
 * production bundle.
 */
export function __resetForTests(configOverride?: Partial<VestibulumEdgeConfig>): void {
  resolvedEndpoint = undefined;
  verifier = undefined;
  jwksCache = new TtlBoundedJwksCache();
  if (configOverride) {
    VESTIBULUM_CONFIG = { ...VESTIBULUM_CONFIG, ...configOverride };
  }
}

/**
 * Test-only: pre-seed the JWKS cache with a JWK set so verification calls
 * don't try to fetch from the network.
 */
export function __seedJwksForTests(
  jwksUri: string,
  jwks: { keys: Array<Record<string, unknown>> },
): void {
  jwksCache.addJwks(jwksUri, jwks as unknown as Parameters<typeof jwksCache.addJwks>[1]);
}
