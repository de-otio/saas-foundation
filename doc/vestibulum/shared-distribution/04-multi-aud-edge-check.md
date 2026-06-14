# 04 — Multi-`aud` edge check

The single load-bearing security change vs. the prototype's per-
tenant pinned-`aud` design. Gets its own doc because a mistake here
is a cross-tenant token-acceptance bug.

## What the edge function does

Inputs: a viewer request — `Host` header, cookies, URI, method.
Outputs: either the request continues to the origin (pass), or a
redirect to the login page (refuse).

Sequence:

```typescript
export const handler: CloudFrontRequestHandler = async (event) => {
  const req = event.Records[0].cf.request;

  // 1. Extract the host.
  const host = req.headers?.['host']?.[0]?.value;
  if (host === undefined || host === '') return refuse(req, 'no-host');

  // 2. Extract the tenant subdomain under the configured parent
  //    (normalise: lowercase, strip port, strip trailing dot, match pattern).
  const tenantSubdomain = extractTenantSubdomain(host, TENANT_PARENT, TENANT_PATTERN);
  if (tenantSubdomain === null) return refuse(req, 'host-not-tenant-shape');

  // 3. Extract the token from cookies. Missing → redirect to login.
  const token = extractTokenFromCookies(req.headers?.['cookie']);
  if (token === undefined || token === '') return loginRedirect(req, tenantSubdomain);

  // 4. Fetch the cached JWKS keys. Unavailable → fail-closed to login.
  let jwks: readonly JsonWebKey[];
  try {
    jwks = await jwksProvider.getJwks();
  } catch {
    return loginRedirect(req, tenantSubdomain);
  }

  // 5. Verify signature, iss, exp, nbf, iat. verifyJwt requires the
  //    fetched `jwks` array — it picks the key whose `kid` matches.
  let claims: Record<string, unknown>;
  try {
    claims = await verifyJwt(token, {
      issuer: POOL_ISSUER,         // https://cognito-idp.<region>.amazonaws.com/<poolId>
      jwks,                        // currently-cached JWKS keys
      algorithms: ['RS256'],       // RS256-only allowlist
      clockSkewSec: 60,
    });
  } catch (err) {
    // verify errors are routed through mapVerifyErrorToResponse:
    //   wrong-iss / expired / bad-signature → refuse(<reason>);
    //   any other verify error → loginRedirect (the cookie is bad).
    return mapVerifyErrorToResponse(req, tenantSubdomain, err);
  }

  // 6. token_use MUST be 'id' (checked before the structural binding).
  //    Under V1 PreTokenGeneration trigger format, `custom:tenant_id`
  //    is only injected into ID tokens — access tokens always lack it.
  //    V2 access-token claim support is a future feature gated behind
  //    an explicit construct prop.
  if (claims['token_use'] !== 'id') {
    return refuse(req, 'wrong-token-use');
  }

  // 7. Structural check: Host's tenant subdomain MUST equal custom:tenant_id.
  //    A missing/non-string claim is a distinct refuse reason.
  const claimTenantId = claims['custom:tenant_id'];
  if (typeof claimTenantId !== 'string') {
    return refuse(req, 'no-tenant-claim');
  }
  if (claimTenantId !== tenantSubdomain) {
    return refuse(req, 'tenant-mismatch');         // do NOT redirect to login — refuse hard
  }

  // 8. `aud` must be present and non-empty (Cognito guarantees this for the pool).
  //    We do NOT compare against an explicit allowlist — see "Why no `aud` allowlist".
  const aud = claims['aud'];
  if (typeof aud !== 'string' || aud === '') {
    return refuse(req, 'no-aud');
  }

  // 9. Pass through to origin.
  return req;
};
```

Verify errors are not all treated identically: `mapVerifyErrorToResponse`
inspects the error message and returns `refuse('wrong-iss')`,
`refuse('expired')`, or `refuse('bad-signature')` for the recognised
markers, falling back to `loginRedirect` for anything else (a generally
bad cookie). The full refuse-reason union the handler can emit is
`no-host`, `host-not-tenant-shape`, `tenant-mismatch`, `no-tenant-claim`,
`wrong-iss`, `wrong-token-use`, `bad-signature`, `expired`, `no-aud`.

## The structural binding: `Host` ↔ `custom:tenant_id`

The single most important line in the function:

```typescript
if (claimTenantId !== tenantSubdomain) return refuse(req, 'tenant-mismatch');
```

This is the cross-tenant gate. A token issued for `acme` presented
at `bob.tenants.example.com` is rejected here. A token with no
`custom:tenant_id` (or a non-string one) is rejected one step
earlier with `refuse(req, 'no-tenant-claim')`. A token whose
`custom:tenant_id` doesn't match the Host is rejected here with
`refuse(req, 'tenant-mismatch')`.

The check is **strict equality on a string**. No casing
normalisation (subdomain extraction already lowercases), no
trimming, no regex shenanigans. Anything that turns this into a
substring check or a regex match is a bug — review must reject any
such change.

The check must come **before** any code path that proceeds to
origin or refresh-token reissue. It must come **after** signature
verification — checking the claim before the signature is verified
admits forged tokens.

## Why no `aud` allowlist at the edge

Two reasons against, both load-bearing:

1. **Onboarding a tenant must not require re-deploying the edge.**
   If the edge function carries a static `aud` allowlist baked at
   synth time, then every new tenant requires regenerating the
   edge bundle, re-deploying Lambda@Edge (with its ~5–10 minute
   propagation), and a new SHA-256 in the bundle lock manifest.
   That's not pure-data onboarding.
2. **`iss` pinning is sufficient.** A token whose `iss` matches
   our pool was, by definition, issued by Cognito against one of
   our app clients — there's no other way to mint a token with
   that issuer. So `aud` will be one of our clients' IDs, but
   *which* one doesn't matter at the edge: the binding is
   `Host` ↔ `custom:tenant_id`, not `Host` ↔ `aud`.

What we'd lose by skipping the `aud` allowlist (consciously):

- **Rogue-client detection.** If an attacker somehow created an
  app client on our pool — which requires Cognito write
  permission, which only the admin Lambda has — they could issue
  tokens with that client's `aud`. The edge accepts those. The
  attacker would still need to satisfy
  `Host` ↔ `custom:tenant_id`, which requires the rogue client
  to have a `ClientConfig` row with a `tenantId` that matches a
  legitimate tenant's subdomain. Both of those require admin
  Lambda compromise. At that point, the attacker has full
  control regardless of the edge's `aud` check.

  Mitigation: the admin Lambda's audit log (every
  create/update/delete + caller identity) is the detection
  surface for rogue clients, not the edge.

- **Stale-client guarding.** If a tenant was deleted but their
  refresh token is still valid (≤ 30 d), can it issue new access
  tokens? `RefreshToken` against a deleted client fails at
  Cognito (the client no longer exists). So no.

## Why no `aud` allowlist via DDB lookup at the edge

An alternative considered: the edge function reads `ClientConfig`
by `aud` value and asserts the row exists and `tenantId` matches
`Host`. Three reasons against:

1. **Lambda@Edge can't reach regional DDB efficiently.** Edge
   replicas run in CloudFront PoPs; the table sits in one home
   region. Cross-region DDB call adds 50–200 ms to every request,
   degrades the auth path, and creates an edge → home-region
   availability coupling that defeats CloudFront's resilience
   posture.
2. **DDB caching at the edge is hard.** Lambda@Edge containers
   are short-lived and globally distributed; a TTL cache buys
   little. Caching invalidation on tenant changes is even harder
   to coordinate across PoPs.
3. **It buys nothing the structural check doesn't already buy.**
   The edge only needs to confirm "this token's tenant claim
   matches the host". That's a string compare on what's already
   in the token. No DDB needed.

## JWT verification posture

The verifier inherits from the bundled single-tenant `check-auth`'s
posture. Specifics:

- **Algorithms: RS256 only.** No `HS256`, no `none`. Hardcoded
  allowlist, not configurable.
- **`iss` pin.** The issuer URL is baked into the bundle at synth
  time: `https://cognito-idp.<region>.amazonaws.com/<poolId>`.
  Tokens with any other issuer rejected.
- **JWKS cache: 15-minute TTL.** Fetched lazily on first verify
  per container; refreshed in-process after TTL expiry.
  Fail-closed on fetch errors — the verifier rejects the token
  rather than serving stale keys past TTL.
- **Clock skew: 60 seconds.** Applied to `exp` and `nbf`.
- **`exp` required.** Tokens without `exp` rejected (Cognito
  always sets `exp`, but defensive).
- **No `kid` fallback.** The token's `kid` must match one of the
  fetched JWKS entries; if not, rejected (don't fall back to
  unsigned).

The implementation is shared with the single-tenant
`MagicLinkAuthSite`'s `check-auth` — packaged as the existing
[`05-jwt-verification.md`](../05-jwt-verification.md) verifier
plus the multi-`aud` (no `aud` allowlist) and Host-aware shape.

## Subdomain extraction

```typescript
function extractTenantSubdomain(host: string, parent: string): string | null {
  // Strip port if present.
  const hostNoPort = host.split(':')[0].toLowerCase();
  // Strip RFC-1035 trailing dot (FQDN form). Some HTTP clients send
  // `acme.tenants.example.com.`; CloudFront may or may not normalise.
  const hostNorm = hostNoPort.replace(/\.$/, '');
  // Parent is normalised at bundle-generation time to also lack a
  // trailing dot.
  if (!hostNorm.endsWith('.' + parent)) return null;
  const candidate = hostNorm.slice(0, hostNorm.length - parent.length - 1);
  // Must be a single DNS label (no further dots).
  if (candidate.includes('.')) return null;
  if (candidate.length === 0) return null;
  // Must match the configured pattern.
  if (!TENANT_PATTERN.test(candidate)) return null;
  return candidate;
}
```

Tests required:

- `acme.tenants.example.com` → `acme`
- `ACME.TENANTS.EXAMPLE.COM` → `acme` (case-folded)
- `acme.tenants.example.com:443` → `acme` (port stripped)
- **`acme.tenants.example.com.` → `acme` (trailing dot stripped)**
- **`acme.tenants.example.com.:443` → `acme` (trailing dot + port)**
- `acme.bob.tenants.example.com` → `null` (multi-level)
- `tenants.example.com` → `null` (apex)
- `.tenants.example.com` → `null` (empty label)
- `.acme.tenants.example.com` → `null` (leading dot)
- `acme-.tenants.example.com` → `null` (trailing dash)
- `1acme.tenants.example.com` → `null` (leading digit)
- `acme.evil.com` → `null` (wrong parent)
- `evilacme.tenants.example.com` → `evilacme` (correctly extracted; the substring "acme" doesn't match)

## Required property tests (fast-check)

Run with `numRuns: 1000`, seed pinned to the repo's standard
(`0xc0ffee`).

```typescript
import fc from 'fast-check';

// Property: a token issued for tenantA never authorises tenantB.
test('cross-tenant rejection', () => {
  fc.assert(fc.property(
    fc.tuple(tenantId(), tenantId()).filter(([a, b]) => a !== b),
    async ([tenantA, tenantB]) => {
      const token = await issueTestToken({ tenantId: tenantA });
      const resp = await checkAuth(makeEvent({
        host: `${tenantB}.tenants.example.com`,
        cookie: `session=${token}`,
      }));
      expect(resp.status).toBe('refuse');
      expect(resp.reason).toBe('tenant-mismatch');
    },
  ));
});

// Property: a token without custom:tenant_id is always rejected.
test('missing claim rejection', () => {
  fc.assert(fc.property(
    fc.record({ host: hostString(), sub: emailString() }),
    async ({ host, sub }) => {
      const token = await issueTestToken({ sub, omitTenantClaim: true });
      const resp = await checkAuth(makeEvent({ host, cookie: `session=${token}` }));
      expect(resp.status).toBe('refuse');
    },
  ));
});

// Property: a request with no token is redirected to the tenant's login.
test('no token → tenant-scoped redirect', () => {
  fc.assert(fc.property(
    tenantId(),
    async (tenant) => {
      const resp = await checkAuth(makeEvent({ host: `${tenant}.tenants.example.com` }));
      expect(resp.status).toBe('redirect');
      expect(resp.location).toMatch(new RegExp(`^https://${tenant}\\.tenants\\.example\\.com/login`));
    },
  ));
});

// Property: a token signed with the wrong key is always rejected.
test('wrong-key rejection', () => {
  fc.assert(fc.property(
    fc.record({ host: hostString(), tenantId: tenantId() }),
    async ({ host, tenantId }) => {
      const token = await issueTestToken({ tenantId, signWithWrongKey: true });
      const resp = await checkAuth(makeEvent({ host, cookie: `session=${token}` }));
      expect(resp.status).toBe('refuse');
    },
  ));
});

// Property: a token with the wrong issuer is always rejected.
test('wrong-iss rejection', () => {
  // similar shape
});

// Property: an expired token is always rejected.
test('expired token rejection', () => {
  // similar shape
});
```

The first property — cross-tenant rejection — is the test that
must pass. If it ever fails, ship is blocked.

## What an attacker would need to break this

| Attack                                         | Required capability                                                               | Mitigation                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------- |
| Use tenant A's token at tenant B               | Steal a token AND access tenant B's CloudFront                                    | Structural check; cookies subdomain-scoped  |
| Forge `custom:tenant_id` in a real token        | Pre-token-generation Lambda compromise OR Cognito-internal compromise              | Pool-level access controls                  |
| Forge a token signed with our pool's key       | Compromise the pool's signing key (Cognito-managed, no public extraction)          | Trust the AWS-managed key custody           |
| Replace JWKS cache with attacker keys           | Compromise the edge function or our pool's JWKS endpoint                          | TLS pinning is implicit (HTTPS to AWS)      |
| Create a rogue app client                      | Compromise the admin Lambda OR consumer's IAM principal                            | Admin-Lambda IAM controls; audit log         |
| Skip the structural check via input crafting    | Find a subdomain string that compares-equal to `custom:tenant_id` by accident      | Strict-equality enforced by review + tests   |

The structural check is the linchpin. **Code review of any change
that touches the `Host` ↔ `custom:tenant_id` comparison must be
mandatory and must verify all property tests still pass.**

## Bundle implications

**Lambda@Edge does not support environment variables**
([AWS docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-at-edge-function-restrictions.html)).
Config values must be baked into the bundle source at synth time
(not injected as env vars at runtime). The bundle pipeline reads
construct props and emits a generated TypeScript module:

```typescript
// packages/vestibulum-cdk/lambda-bundles/check-auth/generated/edge-config.ts
// AUTO-GENERATED at synth time. SHA-256 of this file participates in the
// bundle's overall hash; changes require explicit reviewer ack.
export const TENANT_PARENT = 'tenants.example.com';     // trailing dot stripped
export const TENANT_PATTERN = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;
export const POOL_ISSUER = 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_xxxxx';
export const JWKS_URL = 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_xxxxx/.well-known/jwks.json';
export const JWKS_TTL_MS = 900_000;  // 15 minutes; overridable via construct prop
```

The build step (`scripts/build-bundles.ts`) generates this module
from `SharedDistributionIdentityProps` and writes
`lambda-bundles/check-auth/`. The `lambda-bundles.lock.json` hash
covers both the generated config and the static handler code; any
change to either re-hashes and requires reviewer ack.

The edge bundle adds (vs. single-tenant prototype):

- Subdomain extraction with trailing-dot normalisation (~35 LOC).
- Generated `edge-config.ts` module.
- Multi-`aud` check (no allowlist, just `iss` + structural binding).

No new runtime dependencies. Bundle size delta: < 1 KB compressed.

The CDK construct uses CDK's `cloudfront.experimental.EdgeFunction`
(or equivalent) which enforces the no-env-vars restriction at synth.
Attempting to set env vars will fail with a clear error.

## Security headers (CloudFront Response Headers Policy)

A hardened `ResponseHeadersPolicy` is attached to the CloudFront
distribution by default. Browser-visible login pages are served
behind it:

```typescript
new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
  securityHeadersBehavior: {
    strictTransportSecurity: {
      accessControlMaxAge: Duration.days(730),   // 2 years
      includeSubdomains: true,
      preload: true,
      override: true,
    },
    contentTypeOptions: { override: true },     // X-Content-Type-Options: nosniff
    frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
    referrerPolicy: {
      referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
      override: true,
    },
    xssProtection: { protection: true, modeBlock: true, override: true },
    contentSecurityPolicy: {
      // Tight default for the login pages (no inline scripts, no remote eval).
      // Consumer overrides if their login page needs more.
      contentSecurityPolicy:
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      override: true,
    },
  },
  customHeadersBehavior: {
    customHeaders: [
      { header: 'Permissions-Policy', value: 'accelerometer=(), camera=(), geolocation=(), microphone=(), payment=()', override: true },
    ],
  },
});
```

Consumer overrides the entire policy via
`SharedDistributionIdentityProps.responseHeadersPolicy`; the
default is applied if unset.

## JWKS posture risks

The JWKS cache TTL is 15 minutes (overridable via
`SharedDistributionIdentityProps.jwksTtl`). Two posture risks
worth knowing:

1. **Stale-key acceptance window.** After Cognito rotates a signing
   key out of JWKS, edge containers with a cached JWKS set will
   accept tokens signed with the rotated-out key for up to
   `jwksTtl`. Cognito's rotation pattern (add new key first, leave
   both for a grace period, then remove old key) limits the
   real-world impact: a token signed with a fresh-but-cached old
   key remains valid only during the period when Cognito itself
   would still accept it. Document as accepted risk.

2. **Availability tail on JWKS endpoint failure.** The `TtlCache`
   does not cache errors. If the JWKS endpoint is transiently
   unreachable past TTL, every viewer request triggers a fresh
   fetch attempt and fails. Edge auth becomes fully unavailable
   until the endpoint recovers. **Fail-closed**, but full blast
   radius. Mitigation: monitor `JWKSFetchErrors` metric and alarm
   aggressively (see [`08-observability-and-audit.md`](08-observability-and-audit.md)).

On cache refresh, the new JWKS set **completely replaces** the old
set (no union, no `kid` fallback). A token's `kid` not present in
the freshly-refreshed JWKS → rejected, even if it was in the
previous set.

## Resolved design questions

- **`token_use` at the edge: `id`.** The edge verifies the `id`
  token, not the `access` token. `id` carries `custom:tenant_id`
  reliably under the V1 PreTokenGeneration trigger format the
  construct uses (V2 would be needed for access-token claims, with
  no offsetting benefit). Aligns with the prototype's single-tenant
  check-auth.
- **Refresh-token flow lives in the `auth-verify` Function URL,
  not at the edge.** Lambda@Edge can't reach regional Cognito
  efficiently (50–200 ms cross-region penalty per refresh), and
  edge functions are awkward homes for cookie-rewriting logic.
  The Function URL is Host-aware and serves all tenants from one
  Lambda — see
  [`06-trigger-handlers.md`](06-trigger-handlers.md) §
  `auth-verify`.
- **Edge logging: expose log groups, don't aggregate.** Lambda@Edge
  logs land in 5–10 regional CloudWatch log groups per identity
  (one per active PoP region). The construct exposes
  `identity.edgeLogGroups: ILogGroup[]` as a public field so
  consumers can subscribe them to whatever sink fits their
  existing observability stack (Kinesis Firehose → central log
  group, CloudWatch Insights cross-region query, third-party
  observability tool). The construct does **not** ship a default
  aggregation — that's a consumer-environment choice. Documented
  in the ops runbook.
