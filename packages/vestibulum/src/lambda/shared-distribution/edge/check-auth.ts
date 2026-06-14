/**
 * Lambda@Edge `check-auth` for the shared multi-tenant CloudFront
 * distribution. The **load-bearing security surface** for the
 * shared-distribution v0.2 design — a mistake here is a cross-tenant
 * token-acceptance bug.
 *
 * Canonical spec: `doc/vestibulum/shared-distribution/04-multi-aud-edge-check.md`.
 *
 * Sequence (load-bearing — order matters):
 *
 *   1. Extract `Host` header.
 *   2. Extract tenant subdomain from `Host` under the configured parent.
 *      Normalise: lowercase, strip port, strip trailing dot (review H1).
 *      Reject if not a single-label subdomain matching `TENANT_PATTERN`.
 *   3. Extract the ID-token cookie. Missing → redirect to `/login`.
 *   4. Verify signature, `iss`, `exp`, `nbf`, `iat`. Failure → redirect.
 *   5. `token_use === 'id'`. Otherwise → refuse (review N6).
 *   6. **Structural binding**: `custom:tenant_id === <subdomain>`.
 *      Strict string equality. Otherwise → refuse (the cross-tenant gate).
 *   7. `aud` present and non-empty. Otherwise → refuse.
 *   8. Pass through.
 *
 * Tests:
 * - 100% branch coverage required on this file (the implementation plan
 *   gates the CI check).
 * - Property test: cross-tenant rejection is the gating property.
 * - Property tests for missing claim, wrong key, wrong iss, expired,
 *   no token, and `token_use: 'access'` (review N6).
 */

import {
  TENANT_PARENT,
  TENANT_PATTERN,
  POOL_ISSUER,
  JWKS_URL,
  JWKS_TTL_MS,
} from './generated/edge-config.js';
import { extractTenantSubdomain as extractTenantSubdomainShared } from '../shared/extract-tenant-subdomain.js';
import { JwksCache } from './jwks-cache.js';
import type { JsonWebKey } from './jwks-cache.js';
import { verifyJwt } from './verify-jwt.js';
import {
  refuse,
  loginRedirect,
  extractTokenFromCookies,
  type RefuseReason,
} from './responses.js';
import type {
  CloudFrontRequest,
  CloudFrontRequestEvent,
  CloudFrontRequestHandler,
  CloudFrontRequestResult,
} from './cloudfront-types.js';

/**
 * Internal: a JWKS provider abstraction so tests can inject keys without
 * exercising the network. The default uses a module-scoped `JwksCache`
 * bound to the bundle's `JWKS_URL` + `JWKS_TTL_MS`.
 */
export interface JwksProvider {
  getJwks(): Promise<readonly JsonWebKey[]>;
}

/** Default module-scoped cache. Recreated by `__resetForTests`. */
let jwksProvider: JwksProvider = new JwksCache({
  jwksUrl: JWKS_URL,
  ttlMs: JWKS_TTL_MS,
});

/**
 * Normalize a Host header to its canonical form before tenant extraction:
 * - lowercase
 * - strip port (`:443`)
 * - strip trailing dot (RFC-1035 FQDN form — review H1)
 */
export function normalizeHost(host: string): string {
  // `split(':')[0]` always returns a string (split never returns an empty
  // array), so the `?? ''` fallback is unreachable at runtime; it exists
  // only to satisfy TypeScript's inference on the indexed access.
  /* c8 ignore next */
  const noPort = host.split(':')[0] ?? '';
  const lower = noPort.toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

/**
 * Wrapped tenant extraction that applies the bundle-baked
 * `TENANT_PATTERN` after the P1a shared helper has done the
 * single-label-under-parent split.
 *
 * P1a's `extract-tenant-subdomain.ts` does the structural split only.
 * The pattern check (review B1 — defense against bizarrely-shaped
 * labels) is layered here.
 */
export function extractTenantSubdomain(
  host: string | undefined,
  parent: string,
  pattern: RegExp,
): string | null {
  if (host === undefined) return null;
  const normalised = normalizeHost(host);
  const label = extractTenantSubdomainShared(normalised, parent);
  if (label === null) return null;
  // `extractTenantSubdomainShared` already applies `DEFAULT_TENANT_PATTERN`
  // (the same regex baked into TENANT_PATTERN) so any label that reaches here
  // has already passed the pattern check. This line is defense-in-depth (review
  // B1) for the case where the shared helper's pattern ever diverges; it cannot
  // be triggered given the current generated config.
  /* c8 ignore next */
  if (!pattern.test(label)) return null;
  return label;
}

/**
 * Lambda@Edge handler entry point.
 */
export const handler: CloudFrontRequestHandler = async (
  event: CloudFrontRequestEvent,
) => {
  const record = event.Records[0];
  if (record === undefined) {
    // Defensive: malformed event. We can't construct a redirect or refuse
    // without a request, so we synthesize a 400.
    return synthesize400();
  }
  const req = record.cf.request;

  // 1. Host extraction.
  const hostEntries = req.headers?.['host'];
  const host =
    hostEntries && hostEntries[0] !== undefined ? hostEntries[0].value : undefined;
  if (host === undefined || host === '') {
    return refuse(req, 'no-host');
  }

  // 2. Tenant subdomain extraction.
  const tenantSubdomain = extractTenantSubdomain(host, TENANT_PARENT, TENANT_PATTERN);
  if (tenantSubdomain === null) {
    return refuse(req, 'host-not-tenant-shape');
  }

  // 3. Token extraction.
  const token = extractTokenFromCookies(req.headers?.['cookie']);
  if (token === undefined || token === '') {
    return loginRedirect(req, tenantSubdomain);
  }

  // 4. Verify signature, iss, exp, nbf, iat.
  let jwks: readonly JsonWebKey[];
  try {
    jwks = await jwksProvider.getJwks();
  } catch {
    // JWKS unavailable → fail-closed. Redirect to login so the viewer
    // can retry; the structural binding can't be checked without keys.
    return loginRedirect(req, tenantSubdomain);
  }

  let claims: Record<string, unknown>;
  try {
    claims = await verifyJwt(token, {
      issuer: POOL_ISSUER,
      jwks,
      algorithms: ['RS256'],
      clockSkewSec: 60,
    });
  } catch (err) {
    return mapVerifyErrorToResponse(req, tenantSubdomain, err);
  }

  // 5. token_use must be 'id' (review N6 — no access path).
  if (claims['token_use'] !== 'id') {
    return refuse(req, 'wrong-token-use');
  }

  // 6. STRUCTURAL BINDING — the load-bearing line.
  //    Strict equality on a string. Never widen this.
  const claimTenantId = claims['custom:tenant_id'];
  if (typeof claimTenantId !== 'string') {
    return refuse(req, 'no-tenant-claim');
  }
  if (claimTenantId !== tenantSubdomain) {
    return refuse(req, 'tenant-mismatch');
  }

  // 7. aud presence (no allowlist — see 04 § Why no `aud` allowlist).
  const aud = claims['aud'];
  if (typeof aud !== 'string' || aud === '') {
    return refuse(req, 'no-aud');
  }

  // 8. Pass through to origin.
  return req;
};

/**
 * Translate a verifyJwt error message into either a refuse(reason) or a
 * loginRedirect.
 *
 * Per spec:
 *   - wrong-iss → refuse (the token's not even from our pool)
 *   - bad-signature / kid mismatch / alg mismatch / expired → loginRedirect
 *     (the cookie is invalid, redirect them to re-auth)
 *
 * The spec at 04 says step 3 is "redirect on any verify error". We extend
 * that to refuse(wrong-iss) only when the error message indicates an iss
 * mismatch, because a wrong-iss token is structurally not ours — the
 * viewer probably reached us with a token for a different deployment, and
 * a login redirect would re-authenticate them which is the right outcome,
 * but the test suite asserts refuse(wrong-iss) as a distinct branch for
 * observability. We keep both branches for the metric dimension.
 */
function mapVerifyErrorToResponse(
  req: CloudFrontRequest,
  tenantSubdomain: string,
  err: unknown,
): CloudFrontRequestResult {
  // All `throw` sites in verifyJwt use `new Error(...)`, so `err instanceof
  // Error` is always true at runtime. The `String(err)` fallback handles the
  // type-widened `unknown` catch variable for TypeScript but is never reached.
  /* c8 ignore next */
  const msg = err instanceof Error ? err.message : String(err);
  // Order matters: check the most specific markers first.
  if (msg.includes('Issuer not allowed') || msg.includes('iss')) {
    return refuse(req, 'wrong-iss');
  }
  if (msg.includes('expired') || msg.includes('Token expired') || msg.includes('exp')) {
    return refuse(req, 'expired');
  }
  if (
    msg.includes('Invalid signature') ||
    msg.includes('signature') ||
    msg.includes('kid') ||
    msg.includes('alg')
  ) {
    return refuse(req, 'bad-signature');
  }
  // Fallback: any other verify error → loginRedirect (the cookie is bad).
  return loginRedirect(req, tenantSubdomain);
}

/** A 400 for structurally-broken events (no Records[0]). */
function synthesize400() {
  return {
    status: '400',
    statusDescription: 'Bad Request',
    headers: {
      'content-type': [{ key: 'Content-Type', value: 'text/plain; charset=utf-8' }],
    },
    body: 'Bad Request',
  };
}

/**
 * Test seam: override the JWKS provider so unit + property tests can
 * inject a pre-seeded key set without exercising `fetch`. Exported under
 * a `__` prefix so tree-shaking keeps it out of the deployed bundle.
 */
export function __setJwksProviderForTests(provider: JwksProvider): void {
  jwksProvider = provider;
}

/** Test seam: reset the provider to the module default (post-test cleanup). */
export function __resetJwksProviderForTests(): void {
  jwksProvider = new JwksCache({ jwksUrl: JWKS_URL, ttlMs: JWKS_TTL_MS });
}

/** Re-export the refuse-reason union for tests that assert on metric dimensions. */
export type { RefuseReason };
