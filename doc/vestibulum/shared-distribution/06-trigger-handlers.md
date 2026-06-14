# 06 — Trigger handlers

Mostly carryover from the prototype's Change 1 — `PreSignUp` and
`CreateAuthChallenge` read per-client config from `ClientConfig`
instead of pool-wide env vars. **One genuinely new handler:
`PreTokenGeneration`**, which must inject `custom:tenant_id` for the
edge's structural check to work.

## Shared client-config loader

A small helper at
`packages/vestibulum/src/lambda/shared-distribution/shared/client-config-loader.ts`.
It exposes **two** loaders — by Cognito app client ID and by tenant
subdomain — both returning the frozen `ClientConfigRow` type
(`@de-otio/saas-foundation/types/frozen`), not a locally-defined
`ClientConfig` interface:

```typescript
import { DynamoDBClient, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import type { ClientConfigRow } from '@de-otio/saas-foundation/types/frozen';
import { tenantSubdomain, tenantId } from '@de-otio/saas-foundation/types/frozen';
import { TtlCache } from './ttl-cache.js';

const TABLE = process.env['VESTIBULUM_CLIENT_CONFIG_TABLE'] ?? '';
const ddb = new DynamoDBClient({});
const cacheByClientId = new TtlCache<ClientConfigRow | null>({ ttlMs: 5 * 60 * 1000 });
const cacheBySubdomain = new TtlCache<ClientConfigRow | null>({ ttlMs: 5 * 60 * 1000 });

// Load by Cognito app client ID (the trigger-handler hot path).
export async function loadClientConfigByClientId(clientId: string): Promise<ClientConfigRow | null> {
  return cacheByClientId.getOrLoad(clientId, async () => {
    const resp = await ddb.send(new GetItemCommand({
      TableName: TABLE,
      Key: { clientId: { S: clientId } },
    }));
    if (!resp.Item) return null;
    return parseRow(clientId, resp.Item);   // builds a ClientConfigRow
  });
}

// Load by tenant subdomain via the `SubdomainIndex` GSI (used by the
// auth-verify / auth-signout Function URLs).
export async function loadClientConfigBySubdomain(subdomain: string): Promise<ClientConfigRow | null> {
  return cacheBySubdomain.getOrLoad(subdomain, async () => {
    const resp = await ddb.send(new QueryCommand({
      TableName: TABLE,
      IndexName: 'SubdomainIndex',
      KeyConditionExpression: 'subdomain = :sd',
      ExpressionAttributeValues: { ':sd': { S: subdomain } },
      Limit: 1,
    }));
    const item = resp.Items?.[0];
    if (!item) return null;
    return parseRow(item['clientId']?.S ?? '', item);
  });
}
```

**Fail-closed semantics.** Errors propagate. The cache stores
positive lookups only — a `null` (no row found) is not cached, so
a tenant just-created becomes visible immediately. The TTL applies
to positive lookups so updates take ≤ 5 min to propagate.

**Per-container singleton.** One DDB client and one cache per
loader per Lambda container, shared across invocations. Eviction is
per-entry on read past TTL, no background timer.

## `TtlCache` helper

A ~40-line module at
`packages/vestibulum/src/lambda/shared-distribution/shared/ttl-cache.ts`. Always stores
the promise (never an unwrapped value); avoids the microtask-ordering
race where a caller arriving between promise-resolution and the
`.then()` callback would see `undefined`:

```typescript
export interface TtlCacheOptions {
  readonly ttlMs: number;
}

interface Entry<T> {
  readonly promise: Promise<T>;
  readonly expiresAt: number;
}

export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly ttlMs: number;

  constructor({ ttlMs }: TtlCacheOptions) {
    this.ttlMs = ttlMs;
  }

  async getOrLoad(key: string, loader: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > now) {
      return entry.promise;
    }
    // Cache miss or expired — start a fresh load. Promise-coalescing
    // is implicit: concurrent callers arriving in the same tick all
    // hit the same Promise object.
    const promise = loader().catch((err) => {
      // Don't cache failures: if the load rejects, evict so the next
      // caller retries. Throwing through preserves the rejection.
      if (this.entries.get(key)?.promise === promise) {
        this.entries.delete(key);
      }
      throw err;
    });
    this.entries.set(key, { promise, expiresAt: now + this.ttlMs });
    return promise;
  }
}
```

Property tests (fast-check, numRuns 1000, seed pinned):

- Same key within TTL → single loader invocation across all callers.
- Same key after TTL → fresh loader invocation.
- Concurrent loaders for same key in the same tick → single loader
  invocation, all promises resolve with the same value (no
  `undefined` leakage).
- Loader rejects → entry evicted, next call invokes loader again.
- Loader rejects but a NEW load started before eviction → the new
  load is not evicted by the old load's rejection (verified by
  `this.entries.get(key)?.promise === promise` check).

Property test (fast-check, numRuns 1000):

- Same key within TTL → same value, single loader invocation.
- Same key after TTL → fresh loader invocation.
- Concurrent loaders for same key → single loader invocation,
  all promises resolve with the same value.
- Loader error → entry not cached; next call invokes loader again.

## `PreSignUp` (modified)

Reads per-client `allowedEmailDomains` instead of pool-wide env.

```typescript
import { loadClientConfigByClientId } from '../shared/client-config-loader.js';

export const handler = async (event: PreSignUpTriggerEvent) => {
  const clientId = event.callerContext.clientId;
  // `event.callerContext.clientId` is Cognito-set, not user-set. Trustworthy.

  const cfg = await loadClientConfigByClientId(clientId);
  if (!cfg) {
    // Unknown client. In shared-pool, this only happens for an app
    // client created outside the admin Lambda — e.g. a manually
    // added one. Refuse signup; admin Lambda's reconciler will
    // surface the orphan.
    throw new Error('Signup not allowed');
  }

  const email = event.request.userAttributes.email?.toLowerCase().trim();
  if (!email) throw new Error('Signup not allowed');

  const domain = email.split('@')[1];
  if (!domain || !cfg.allowedEmailDomains.includes(domain)) {
    // Generic error — don't leak whether the domain or the email
    // was the problem. Matches the prototype's mitigation #4.
    throw new Error('Signup not allowed');
  }

  return event;
};
```

What changed vs. single-tenant `PreSignUp`:

- Reads `allowedEmailDomains` from `ClientConfig`, not env.
- No pool-wide fallback. Unknown client → refuse.
- Cold-start path adds one DDB GetItem; cached for 5 min.

## `CreateAuthChallenge` (modified)

Builds magic-link URL using per-client `siteBaseUrl`.

```typescript
export const handler = async (event: CreateAuthChallengeTriggerEvent) => {
  const cfg = await loadClientConfigByClientId(event.callerContext.clientId);
  if (!cfg) throw new Error('Auth challenge failed');

  // ... existing magic-link token generation ...

  const link = `${cfg.siteBaseUrl}/login/callback#tok=${token}`;
  await ses.sendEmail({ /* ... uses `link` and the existing template ... */ });

  return event;
};
```

What changed: source of `siteBaseUrl`. Otherwise identical.

**Fail-closed posture is critical here.** A fallback to a default
`siteBaseUrl` would issue magic links pointing at the wrong
tenant's subdomain — a cross-tenant redirect, the exact bug the
shared-distribution design is built to prevent. Even an apparently
helpful fallback (default to the parent landing page) is wrong:
the link recipient would land at the parent, fail to find a
session, and end up confused. Always refuse rather than misroute.

## `PreTokenGeneration` (new)

**This handler is load-bearing for shared-distribution mode.** It
injects `custom:tenant_id` into every token issued by the pool;
without it, the edge's structural check rejects every request.

The default handler ships as a thin `wrapPreTokenHandler` wrapper
(see below) so the load-bearing claim injection lives in one place;
the illustrative shape it is equivalent to:

```typescript
import type { PreTokenGenerationTriggerEvent } from 'aws-lambda';
import { loadClientConfigByClientId } from '../shared/client-config-loader.js';

export const handler = async (event: PreTokenGenerationTriggerEvent) => {
  const cfg = await loadClientConfigByClientId(event.callerContext.clientId);
  if (!cfg) {
    // No row → no tenant claim → edge will reject. Throwing here
    // gives a clearer error path: the token mint itself fails,
    // and Cognito surfaces a specific error code rather than the
    // user seeing a successful login followed by 401 at the edge.
    throw new Error('Tenant configuration missing');
  }

  event.response = {
    claimsOverrideDetails: {
      claimsToAddOrOverride: {
        'custom:tenant_id': cfg.tenantId,
      },
    },
  };

  return event;
};
```

**No fallback path.** If the row is missing, the token mint fails.
This is intentional — a token without `custom:tenant_id` cannot
pass the edge check, so issuing it at all is misleading. Better to
surface the configuration error at the auth step where Cognito
reports it cleanly.

### Allowing consumer customisation

A consumer may want to inject *additional* claims (e.g. user role,
feature flags) beyond `custom:tenant_id`. The chosen mechanism:
**replace-the-trigger, wrapped with `wrapPreTokenHandler` to enforce
the `custom:tenant_id` contract at runtime.**

The wrapper:

1. Loads `ClientConfig` for the caller's `clientId`, passes the
   result to the consumer's handler as `ctx.tenantConfig`.
2. Pre-sets
   `event.response.claimsOverrideDetails.claimsToAddOrOverride['custom:tenant_id']`
   before invoking the consumer handler.
3. Runs the consumer's handler.
4. **Asserts** `custom:tenant_id` is still set after the consumer
   handler returns. If the handler overwrote / deleted it, the
   wrapper throws — token mint fails, Cognito reports the error
   immediately at login, no silent edge-rejection downstream.

`wrapPreTokenHandler` lives at
`packages/vestibulum/src/lambda/shared-distribution/shared/wrap-pre-token-handler.ts`.
There is **no** `@de-otio/vestibulum/lambda/shared` subpath export —
the package declares a single `"."` export. The bundled
shared-distribution trigger imports it via the relative module path;
the shape below is illustrative:

```typescript
import { wrapPreTokenHandler } from '../shared/wrap-pre-token-handler.js';

export const handler = wrapPreTokenHandler(async (event, ctx) => {
  // ctx.tenantConfig is already loaded.
  // event.response.claimsOverrideDetails.claimsToAddOrOverride
  // already has custom:tenant_id pre-set.
  event.response.claimsOverrideDetails!.claimsToAddOrOverride!['custom:role']
    = lookupUserRoleFromMyDb(event.userName);
  return event;
});
```

Wrapper implementation sketch:

```typescript
export function wrapPreTokenHandler<E extends PreTokenGenerationTriggerEvent>(
  inner: (event: E, ctx: PreTokenContext) => Promise<E>,
): (event: E) => Promise<E> {
  return async (event) => {
    const cfg = await loadClientConfigByClientId(event.callerContext.clientId);
    if (!cfg) throw new Error('Tenant configuration missing');

    event.response = event.response ?? {};
    event.response.claimsOverrideDetails = event.response.claimsOverrideDetails ?? {};
    event.response.claimsOverrideDetails.claimsToAddOrOverride = {
      ...event.response.claimsOverrideDetails.claimsToAddOrOverride,
      'custom:tenant_id': cfg.tenantId,
    };

    const result = await inner(event, { tenantConfig: cfg });

    // Contract enforcement (overrides).
    const finalTenantId =
      result.response?.claimsOverrideDetails?.claimsToAddOrOverride?.['custom:tenant_id'];
    if (finalTenantId !== cfg.tenantId) {
      throw new Error(
        `wrapPreTokenHandler: handler must not overwrite custom:tenant_id ` +
        `(expected '${cfg.tenantId}', got '${finalTenantId}')`,
      );
    }

    // Contract enforcement (suppressions).
    //
    // Cognito processes `claimsToSuppress` AFTER `claimsToAddOrOverride`.
    // Without this guard, a buggy or malicious consumer handler can set
    // `claimsToSuppress: ['custom:tenant_id']` while leaving overrides
    // intact; the final minted token would lack the claim entirely and
    // the edge would silently refuse every subsequent request from the
    // user. Catching it here surfaces the bug at token-mint time, where
    // Cognito reports it to the auth flow, not later as a silent 4xx.
    const suppressed = result.response?.claimsOverrideDetails?.claimsToSuppress;
    if (Array.isArray(suppressed) && suppressed.includes('custom:tenant_id')) {
      throw new Error(
        `wrapPreTokenHandler: handler must not suppress custom:tenant_id`,
      );
    }

    return result;
  };
}
```

Required property tests:

- Wrapper sets `custom:tenant_id` from `ClientConfig` even when inner
  handler doesn't touch claims at all.
- Inner handler overwriting `custom:tenant_id` → wrapper throws.
- Inner handler adding `'custom:tenant_id'` to `claimsToSuppress` →
  wrapper throws.
- Inner handler throwing → wrapper propagates (does not swallow).
- Inner handler returning event with no `claimsToAddOrOverride` →
  wrapper still has `custom:tenant_id` set (pre-injection survives).

Rejected alternative: **Lambda-invoke claims augmenter from the
bundled trigger.** Adds one Lambda hop per token mint (~10–30 ms
warm, up to seconds on cold). The wrapper approach has zero
additional Lambda overhead and equivalent safety guarantees.

CDK wiring:

```typescript
const customPreTokenGen = new lambda.Function(this, 'CustomPreTokenGen', {
  // bundled with wrapPreTokenHandler + the consumer's logic
});
identity.grantReadClientConfig(customPreTokenGen);
identity.preTokenGeneration(customPreTokenGen);  // replaces the default
```

When a consumer wires `preTokenGeneration(...)`, the construct's
default PreTokenGen is **not** installed. The consumer Lambda is
the sole trigger; the wrapper ensures the load-bearing claim is
still set.

## `DefineAuthChallenge` and `VerifyAuthChallengeResponse` (no change)

These handlers don't touch per-client config — they only deal with
the magic-link token state machine. Unchanged from single-tenant.

## `auth-verify` Function URL (modified)

Reads `Host` header to determine which tenant the user is verifying
against. Looks up the tenant's `clientId` via `ClientConfig`'s
`SubdomainIndex` (read-only, not the load path; happens once per
verification, fine to add a DDB read).

**Refresh-token flow uses `GetTokensFromRefreshToken`, NOT
`REFRESH_TOKEN_AUTH`.** Refresh-token rotation (the security
best practice we enable in `createUserPoolClient`) is incompatible
with `InitiateAuth(REFRESH_TOKEN_AUTH)`. The `auth-verify` handler
calls the [`GetTokensFromRefreshToken` API](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_GetTokensFromRefreshToken.html)
on refresh, which returns new ID, access, AND refresh tokens, and
invalidates the old refresh token (with the 60-second grace
period configured in `createUserPoolClient`).

```typescript
import { parseCookies, buildSetCookie } from '../../handlers/auth-verify/cookie.js';

const ID_TOKEN_MAX_AGE = 15 * 60;             // 15 minutes
const REFRESH_TOKEN_MAX_AGE = 30 * 24 * 60 * 60;  // 30 days

export const handler = async (event: FunctionUrlEvent) => {
  // The Host header is the tenant subdomain ONLY when this Function
  // URL is invoked through CloudFront (as origin/behaviour). Direct
  // .on.aws invocation bypasses the tenant resolution and is refused.
  const host = event.headers?.['host'];
  const subdomain = extractTenantSubdomain(host, TENANT_PARENT);
  if (subdomain == null) return errorResponse(400, 'invalid host');

  const tenantConfig = await loadClientConfigBySubdomain(subdomain);
  if (!tenantConfig) return errorResponse(404, 'tenant not found');

  const cookies = parseCookies(event.headers?.['cookie']);
  const domain = `${subdomain}.${TENANT_PARENT}`;

  // Refresh path: { refresh: true } in the body + a `refresh-token` cookie.
  if (bodyHas(event, 'refresh', true)) {
    const oldRefreshToken = cookies['refresh-token'];
    const resp = await cognito.send(new GetTokensFromRefreshTokenCommand({
      ClientId: tenantConfig.clientId,
      RefreshToken: oldRefreshToken,
    }));
    const auth = resp.AuthenticationResult;
    // Set two cookies: id-token (Lax, Path=/) and the rotated refresh-token
    // (Strict, Path=/auth-verify). There is no single `session=` cookie.
    const setCookies = [
      buildSetCookie('id-token', auth!.IdToken!, {
        httpOnly: true, secure: true, sameSite: 'Lax', path: '/',
        domain, maxAge: ID_TOKEN_MAX_AGE,
      }),
    ];
    if (auth?.RefreshToken) {
      setCookies.push(buildSetCookie('refresh-token', auth.RefreshToken, {
        httpOnly: true, secure: true, sameSite: 'Strict', path: '/auth-verify',
        domain, maxAge: REFRESH_TOKEN_MAX_AGE,
      }));
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      multiValueHeaders: { 'Set-Cookie': setCookies },
      body: JSON.stringify({ ok: true }),
    };
  }

  // Magic-link redemption path: RespondToAuthChallenge against
  // tenantConfig.clientId, then the same two-cookie Set-Cookie shape.
};
```

Same Function URL serves all tenants. Same Lambda code. The
`Host` discriminates.

The handler sets **two** cookies via `buildSetCookie`
(`packages/vestibulum/src/lambda/handlers/auth-verify/cookie.ts`):

- **`id-token`** — `HttpOnly; Secure; SameSite=Lax; Path=/`, 15-minute Max-Age.
- **`refresh-token`** — `HttpOnly; Secure; SameSite=Strict; Path=/auth-verify`, 30-day Max-Age.

There is no `session=` cookie and no `setRotatedTokensCookie` helper.

### Critical constraint: Function URLs MUST be invoked through CloudFront

The `auth-verify` and `auth-signout` Function URLs read the `Host`
header to determine the tenant. This works **only** when the
Function URL is invoked through CloudFront (as an origin behind a
behaviour). Direct invocation via the Function URL's `.on.aws`
hostname would carry `Host: <url-id>.lambda-url.<region>.on.aws`,
not the tenant subdomain — and tenant resolution would fail.

CDK wiring must:

1. Put both Function URLs behind CloudFront origins (separate
   behaviours for `/auth-verify` and `/auth-signout`).
2. Configure the origin to forward `Host` as-is (CloudFront forwards
   the original viewer Host by default for custom origins).
3. NOT publicise the raw `.on.aws` URLs.

The Function URL's IAM auth (`AuthType: NONE` for the public paths,
since the user agent doesn't carry SigV4 credentials) means anyone
who discovers the `.on.aws` URL could call it directly. The
`extractTenantSubdomain` check at the top of the handler is the
fallback: direct invocation produces a `.on.aws` Host, which doesn't
match `TENANT_PARENT`, so the handler returns 400. **Fail-closed**,
but documented so direct invocation isn't relied upon by anyone.

## `auth-signout` Function URL (modified)

Same pattern. Reads Host to scope the sign-out cookie clear to the
correct tenant subdomain.

It clears **both** cookies (matching the pair `auth-verify` set),
scoped to the exact tenant subdomain (no leading dot), via
`buildSetCookie` with `maxAge: 0`:

```typescript
const exactDomain = `${subdomain}.${TENANT_PARENT}`;
const clearCookies = [
  buildSetCookie('id-token', '', {
    httpOnly: true, secure: true, sameSite: 'Lax', path: '/',
    domain: exactDomain, maxAge: 0,
  }),
  buildSetCookie('refresh-token', '', {
    httpOnly: true, secure: true, sameSite: 'Strict', path: '/auth-verify',
    domain: exactDomain, maxAge: 0,
  }),
];

return {
  statusCode: 303,
  headers: { location: `${tenantConfig.siteBaseUrl}/` },
  multiValueHeaders: { 'Set-Cookie': clearCookies },
};
```

## SES bounce handler (no change)

Bounces are pool-wide; the bounce handler quarantines on user
`sub`, not on tenant. Cross-tenant by design — same human across
multiple tenants gets one quarantine state.

The `BOUNCE_HMAC_SECRET` is also pool-wide. Rotation affects all
tenants on the identity simultaneously.

## Bundle list

`packages/vestibulum-cdk/scripts/lambda-entries/` adds entries for:

- `pre-signup-shared-distribution.ts` (or refactor existing
  `pre-signup.ts` to detect mode at build time via env)
- `create-auth-challenge-shared-distribution.ts`
- `pre-token-generation-shared-distribution.ts`
- `auth-verify-shared-distribution.ts`
- `auth-signout-shared-distribution.ts`

Each bundles the corresponding `@de-otio/vestibulum` factory plus
the shared `client-config-loader` and `ttl-cache`.

**Decision: two parallel bundle sets**, not mode-detecting bundles.
Mode detection at runtime would add branches in the handler and a
runtime-env coupling that's hard to test in isolation. Parallel
sets: two explicit bundles, two explicit construct types
(`MagicLinkIdentity` vs. `SharedDistributionIdentity`), one
unambiguous reading of which is which. The bundle-size cost of
duplication is small relative to the test/review clarity gain.

The bundles are SHA-256-hashed and committed in
`lambda-bundles.lock.json` as usual.

## Tests required

For the modified handlers:

- `PreSignUp` with stubbed DDB returns per-client allowlist;
  admit/reject behaves per allowlist.
- `PreSignUp` with no row → "Signup not allowed".
- `PreSignUp` with DDB error → throws (fail-closed).
- `CreateAuthChallenge` with stubbed DDB builds link with
  per-client `siteBaseUrl`.
- `CreateAuthChallenge` with DDB error → throws (fail-closed).
- `PreTokenGeneration` injects `custom:tenant_id` from row.
- `PreTokenGeneration` with no row → throws.
- `TtlCache` properties (fresh load, cached load, expiry,
  coalesce, error not cached).
- `auth-verify` resolves tenant from Host, redeems magic-link
  against the correct app client.
- `auth-verify` with unknown subdomain → 404.

For the property test gate (fast-check):

- A magic-link issued for tenant A is **never** redeemable
  against tenant B's auth-verify endpoint.
- A signup attempt with an email matching tenant A's allowlist but
  via tenant B's app client → rejected.

These properties are the gates that turn "we hope cross-tenant
isolation works" into "cross-tenant isolation works for any input
the property generator can produce".
