# JWT verification

The multi-pool verifier (`createMultiPoolVerifier`) and the
boundary-enforcement helper (`requirePool`). The smallest surface
in vestibulum where a bug becomes a tenant-isolation breach
("B2C token accepted in a B2B-tenant operation"), which is why
both helpers exist: to make the safe pattern the easy path.

Public surface is in
[`./01-package-api.md § JWT verification helpers`](./01-package-api.md#jwt-verification-helpers);
this file covers the design rationale, security properties, and
the integration shape with `@de-otio/saas-foundation`'s
`RequestContext`.

## Why a vestibulum helper, not raw `aws-jwt-verify`

`aws-jwt-verify` is the right library — battle-tested, AWS-owned,
no client-side decode-before-verify trap. Vestibulum uses it
underneath; it does not reinvent JWT verification. Per
saas-foundation's "Don't reinvent OSS" principle
([`../01-scope-and-philosophy.md § Design principles`](../01-scope-and-philosophy.md#design-principles)),
the wrapper exists to add value on top, not to abstract the
library away.

What the wrapper adds:

1. **Multi-pool dispatch.** The consumer's API process accepts
   tokens from two (or more) Cognito user pools. Each pool
   issues tokens with a different `iss` claim. The naive shape
   — one `CognitoJwtVerifier` per pool, dispatched by some
   ad-hoc reading of the JWT — is easy to get wrong (decode
   before verify, substring-match the issuer, fall through on
   unknown). The helper does it once, correctly.
2. **Stable pool key.** The verifier returns a consumer-assigned
   `poolKey` (`'b2c'`, `'b2b'`) alongside the verified claims.
   Handlers branch on `poolKey`, not on Cognito user pool IDs,
   which are environment-specific (dev vs prod) and would
   couple handler code to deploy config.
3. **`requirePool` enforcement.** A one-line check at the
   handler boundary that catches the "wrong pool" class of bug
   loudly, before any tenant-scoped query runs. Tenant
   isolation is a sub-class of authorisation; this helper is
   the authentication-side equivalent of "did the right user
   send this".
4. **Typed errors.** `MultiPoolVerifierError` with a `reason`
   discriminant suitable for structured logs; consumers do
   not catch generic `Error` and reverse-engineer the cause.

## `createMultiPoolVerifier`

```typescript
interface PoolConfig {
  /**
   * Stable identifier the consumer assigns
   * (e.g. `'b2c'` or `'b2b'`). Returned in the
   * verified-token output so handlers can branch
   * on it. NOT the Cognito pool ID.
   */
  poolKey: string;
  userPoolId: string;
  clientId: string | string[]; // app client(s) issued from this pool
  region: string;
  tokenUse: "access" | "id" | null;
}

function createMultiPoolVerifier(pools: PoolConfig[]): MultiPoolVerifier;

interface MultiPoolVerifier {
  verify(token: string): Promise<VerifiedToken>;
}

interface VerifiedToken {
  poolKey: string; // from PoolConfig
  claims: Record<string, unknown>;
  rawToken: string;
}
```

### Pool-config shape

Each `PoolConfig` is one Cognito user pool. Multiple app
clients per pool are common (web UI client, mobile client,
admin client, third-party API client) — the `clientId` field
accepts a single string or an array, and the verifier accepts
any token whose `aud` claim (or `client_id`, depending on
`tokenUse`) is in the configured set.

`tokenUse` defaults to `'access'` for the typical API case.
Setting it to `'id'` is the path for Lite-pool deployments that
move custom claims to the ID token (see
[`./06-pool-topology.md § Option C.3`](./06-pool-topology.md#path-c1-api-verifies-id-tokens)).

**Discouraged: `tokenUse: null`.** The `null` setting weakens
the `token_use` constraint to accept either an access token or
an ID token interchangeably. This is rarely what you want — the
two token types differ in audience and intended consumer
(access tokens are scoped for resource-server consumption; ID
tokens are scoped for the client). Mixing them at the API
boundary turns the `token_use` constraint from a load-bearing
check into a no-op, and removes a defensive signal against
token-confusion attacks (a leaked ID token now substitutes for
an access token without triggering a verifier mismatch).
Recommend always pinning to `'access'` or `'id'` explicitly;
reach for `null` only when an audited reason exists and the
consumer's authorisation layer compensates.

### The `poolKey` convention

`poolKey` is a consumer-controlled string. The vestibulum API
does not enforce any specific value; the convention used in the
design docs is `'b2c'` / `'b2b'` for the
[`./06-pool-topology.md`](./06-pool-topology.md) topology.
Consumers with different deployment shapes pick their own
(`'consumer'` / `'enterprise'`, `'public'` / `'private'`, etc.).

Why not the Cognito user pool ID directly? Two reasons:

1. **Environment portability.** The pool ID varies across
   dev/staging/prod (`eu-central-1_xxx` vs `eu-central-1_yyy`).
   Handler code that branches on the literal ID is broken in
   one of the environments. The stable `poolKey` decouples.
2. **Log volume / leak surface.** Pool IDs in application logs
   are a small ops-info leak (they reveal AWS region and
   tenancy structure). `poolKey` values are intentionally
   coarse and safe to log.

## Security properties

The wrapper enforces three properties that are easy to get
wrong with hand-rolled multi-pool dispatch.

### Select-by-`iss`, then verify

The verifier maintains a `Map<iss, CognitoJwtVerifier>` built
from the configured pools at construction time. Per-token
dispatch is a three-step sequence:

1. **Structurally parse** the JWT — split on `.`, base64url-decode
   the _body_ segment, parse as JSON — to extract the unverified
   `iss` claim. Pure parsing, no trust granted.
2. **Select** the verifier by exact-string lookup on the
   unverified `iss`. If the issuer is not in the map, the
   verifier throws `MultiPoolVerifierError(reason:
'unknown_issuer')` _before_ any signature work — no fallback
   verifier, no wildcard, no "try them all".
3. **Verify.** Call the selected `CognitoJwtVerifier.verify(token)`.
   The verifier is bound at construction to a _pinned JWKS_ for
   the specific Cognito user pool. Signature failure means the
   token is forged (or signed by a different pool's keys);
   signature success means the trusted `iss` matches the
   verifier's pool — by the verifier's own construction.

```typescript
async function verify(token: string) {
  const unverifiedIss = readUnverifiedIss(token); // parsing only, no trust
  const verifier = verifiersByIss.get(unverifiedIss);
  if (!verifier) {
    throw new MultiPoolVerifierError({ reason: "unknown_issuer" });
  }
  const claims = await verifier.verify(token); // pinned JWKS check
  // Signature checked successfully → claims.iss is trustworthy.
  return { poolKey: poolKeyByIss.get(unverifiedIss)!, claims, rawToken: token };
}
```

**Why this is safe.** Reading `iss` from an unverified body for
_selection_ is safe: an attacker controlling `iss` can only
_choose_ which pinned JWKS the signature will be checked against.
They can:

- Point `iss` at a configured pool — the signature still has to
  match that pool's JWKS, which they don't have.
- Point `iss` at an unconfigured value — the verifier rejects it
  before signature work.

What's **not** safe is trusting `iss` as a _claim_ before
signature verification: e.g., using the unverified `iss` to
authorise an operation, or to bind the token to a user. The
verifier never does this; consumers should not either.

```typescript
// WRONG shape (do not write this):
function badVerify(token: string) {
  const claims = JSON.parse(atob(token.split(".")[1])); // unverified
  return makeAuthDecision(claims.iss, claims.sub); // trusting iss as truth
}
```

**Why not "try each verifier".** An older shape iterates over
verifiers, catching `invalid_signature` and trying the next:

```typescript
// Do not write this either.
for (const verifier of allVerifiers) {
  try {
    return await verifier.verify(token);
  } catch {
    /* try next */
  }
}
```

This works but produces N−1 spurious `invalid_signature`
exceptions per legitimate request when N pools are configured —
noise in the underlying library's logs, wasted RSA-verify CPU,
and a confusing audit trail (every successful B2B login looks
like it generated a failed B2C verify attempt first). The
select-by-`iss` shape avoids all of that for the same security
guarantee.

### Exact-iss matching, not substring

The `iss` claim of a Cognito-issued token is the canonical URL
`https://cognito-idp.{region}.amazonaws.com/{userPoolId}`. The
wrapper matches against this **exact string** — no substring
matching, no allowance for trailing slashes, no case
normalisation.

Why exact: a substring match (`if token.iss.includes(poolId)`)
is the easy-to-get-wrong shape that accepts any token whose
issuer happens to contain the pool ID as a substring. For
Cognito pool IDs this is unlikely to bite in practice (pool
IDs are long random strings), but the same pattern in other
contexts has caused real CVEs. Vestibulum hard-codes the safer
default.

### Unknown-issuer rejection, no fallback

If the token's verified `iss` isn't in the configured pool
list, the verifier throws `MultiPoolVerifierError(reason:
'unknown_issuer')`. There is no fallback verifier, no
"accept any signed Cognito token" path, no wildcard issuer
config.

This matters when a consumer adds a third pool later and forgets
to update the verifier config. The safe failure mode is "tokens
from the new pool are rejected" (the consumer notices when they
test the integration); the unsafe one is "tokens from the new
pool are accepted with no `poolKey` set and trip the
`requirePool` check later" (caught further down, harder to
debug).

## `requirePool`

```typescript
function requirePool(token: VerifiedToken, expected: string | string[]): void;
```

Throws `MultiPoolVerifierError(reason: 'wrong_pool')` if
`token.poolKey` is not in `expected`. The error is the same
class as a verification failure so consumers can map a single
exception type to 401 / 403; the `reason` discriminant
distinguishes the cause for logs.

### Where to call it

The intended usage is at the handler boundary, after token
verification but before any tenant-scoped database query:

```typescript
app.post("/tenants/:id/members", async (req, res) => {
  const token = await verifier.verify(req.bearerToken);
  requirePool(token, "b2b"); // tenant-admin op is B2B-only
  // ... rest of handler ...
});

app.get("/me/personal-data", async (req, res) => {
  const token = await verifier.verify(req.bearerToken);
  requirePool(token, "b2c"); // personal-data op is B2C-only
  // ... rest of handler ...
});

app.get("/help", async (req, res) => {
  const token = await verifier.verify(req.bearerToken);
  requirePool(token, ["b2c", "b2b"]); // either pool is fine
  // ... rest of handler ...
});
```

The helper is a one-liner because it should be cheap to add at
every handler. Centralising via middleware is preferred where
the URL structure cleanly maps to a single pool (e.g., every
route under `/api/admin/` is B2B-only); the helper exists so
handler-level enforcement is also cheap and obvious, for
routes where the URL does not encode the constraint.

### Why not enforce via middleware only

Two reasons against middleware-only enforcement:

1. **Some routes serve both pools.** A `/help` endpoint, a
   `/health` endpoint, an `/oauth/userinfo` endpoint — these
   accept either pool's tokens, and a middleware-only
   architecture forces an awkward "allow-list of dual-pool
   routes" config. The per-handler helper sidesteps it.
2. **Programmatic verifiability.** Every handler that needs
   single-pool enforcement has a literal `requirePool(token,
'b2b')` call in its source. Static analysis can grep for
   it; PR review can spot a missing one. Middleware-only
   enforcement is configuration the reader has to trust at a
   distance.

The recommended shape is "middleware enforces the _default_ for
each URL prefix, `requirePool` enforces _exceptions_" — same
shape as the foundation `csrf` and `audit` modules end up using
elsewhere.

## Integration with foundation `RequestContext`

Foundation owns `RequestContext` — the per-request context
carrier kept on `AsyncLocalStorage`, exposed by foundation's
`request-context` module via `getRequestContext()` and the
phase-guarded `setRequestContext(next)`. The frozen-set
definition lives at
[`../04-shared-vocabulary.md § RequestContext`](../04-shared-vocabulary.md#requestcontext);
the phase-guard mechanics — replacement (not mutation) is
permitted only during the _early-request phase_, which spans
tenant resolution through auth middleware up to handler
dispatch — are owned by foundation's request-context module
and described in
[`../04-shared-vocabulary.md § RequestContext`](../04-shared-vocabulary.md#requestcontext).

Vestibulum does not require any specific `RequestContext`
shape; the verifier returns a plain object and the consumer
decides what to do with it. But the natural integration —
consumer-bound, not vestibulum-bound — is:

```typescript
// In consumer middleware:
declare module '@de-otio/saas-foundation' {
  interface RequestContext {
    readonly poolKey?: string;
  }
}

// `setRequestContext` and `getRequestContext` come from
// foundation's request-context module (re-exported from the
// package root); see ../04-shared-vocabulary.md § RequestContext
// for the phase-guard mechanics.
import { getRequestContext, setRequestContext } from '@de-otio/saas-foundation';
import { createMultiPoolVerifier, requirePool } from '@de-otio/vestibulum';

const verifier = createMultiPoolVerifier([...]);

// Auth middleware. This sits in the early-request phase: tenant
// resolution has already happened, the route handler has not
// yet dispatched. `setRequestContext` is *permitted* here
// precisely because of where in the chain it runs — the same
// call inside a handler would throw, since handler dispatch
// closes the early-request phase. See
// ../04-shared-vocabulary.md § RequestContext.
app.use(async (req, res, next) => {
  const token = await verifier.verify(req.bearerToken);
  setRequestContext({
    ...getRequestContext(),
    poolKey: token.poolKey,
    principal: { kind: 'user', userSub: token.claims.sub, sessionId: '...' },
  });
  next();
});
```

The TypeScript declaration-merging pattern is the canonical way
to extend `RequestContext` with consumer-specific fields (see
[`../04-shared-vocabulary.md § RequestContext §
Extensibility`](../04-shared-vocabulary.md#requestcontext)).
Vestibulum does **not** add `poolKey` to `RequestContext`
itself — that would push an identity-specific field into a
foundation type, breaking the layering. The consumer chooses
whether to surface it on `RequestContext`, on a local
`AuthContext`, or just as a parameter to handlers.

Why "consumer-bound": foundation's `RequestContext` is shared
across all consumers, including ones that have no identity
layer at all (a backend with custom auth, a stateless utility
service). Adding identity-shaped fields to foundation's frozen
type would force every consumer to think about pool keys, which
is exactly the kind of cross-package coupling the layering
prevents.

## `MultiPoolVerifierError`

```typescript
class MultiPoolVerifierError extends VestibulumRuntimeError {
  readonly reason:
    | "unknown_issuer"
    | "expired"
    | "invalid_signature"
    | "wrong_client_id"
    | "wrong_token_use"
    | "wrong_pool"
    | "malformed_token";
}
```

Consumers map this to 401 (or 403, depending on convention).
The `reason` discriminant is suitable for structured logs; do
not surface the discriminant to end users — it leaks
information that helps attackers refine token-forgery attempts.
A user-facing message of "authentication failed" with the
`reason` logged server-side is the right shape.

The `wrong_pool` reason is what `requirePool` throws; the others
come from `verify`.

## JWKS caching

`aws-jwt-verify` caches the JWKS per pool with a 10-minute TTL
by default. Vestibulum does not override the default; the
library's caching is correct for the typical Cognito refresh
cadence (Cognito rotates keys on a multi-year schedule, the JWKS
endpoint serves both old and new keys during the rotation
window).

Consumers running the verifier in Lambda may want to be aware
that cold-start invocations incur a JWKS fetch; the
`aws-jwt-verify` library handles this with internal locking, so
a burst of cold starts does not multiply the JWKS fetch count.

## Performance characteristics

Per-request verification is fast: RS256 signature check is
~1 ms on warm Lambdas; JWKS lookups are cached. The select-by-
`iss` dispatch adds a single `Map` lookup plus the JWT-body
JSON parse — sub-millisecond overhead. Exactly one
`verifier.verify()` call runs per token; there is no iteration,
no fall-through, and no failed signature attempt on the happy
path.

The verifier does not call out to AWS for any per-request
operation. Token verification is offline crypto against a
cached JWKS; no Cognito SDK calls. This is why it's safe to use
in the API hot path.

## Open questions

- **Should the verifier expose a way to add pools at runtime?**
  Currently `createMultiPoolVerifier` is a factory; the pool
  list is fixed at construction. A consumer adding a new pool
  has to restart their API process. This is the simplest shape;
  dynamic add/remove introduces concurrency questions (what
  happens to in-flight requests when a pool is removed?). Lean
  toward staying static; revisit if a consumer asks.
- **Should `VerifiedToken` carry the principal in a normalised
  shape?** Today it's `claims: Record<string, unknown>`; the
  consumer extracts `sub`, `email`, etc. themselves. A
  normalised `principal: Principal` field (matching foundation's
  `Principal` discriminator) would be cleaner. Counter: the
  shape of "what's in the claims" is consumer-specific (which
  custom claims, which group claim) — over-normalising forces
  vestibulum to know consumer conventions. Lean toward staying
  raw; consumers extract.
- **Edge verification.** The same multi-pool dispatch is useful
  in Lambda@Edge. The current `createMultiPoolVerifier` works
  there (`aws-jwt-verify` runs in Lambda@Edge); the wrapper
  may want an explicit "edge mode" that disables the JWKS
  fetch and accepts a pre-cached JWKS bundle, since Lambda@Edge
  cold starts pay extra for the fetch. Defer until a consumer
  hits the latency cost.
