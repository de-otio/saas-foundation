# 05 — Tenant context

`TenantId` resolution and the AsyncLocalStorage carrier that propagates
it through a request scope. Foundation owns the _type_ and the
_resolver shape_; the consumer owns the resolution logic (because
tenant resolution is application-policy).

## What it owns

- The frozen `TenantId` branded string and its validators
  (`tenantId(...)`, `isTenantId(...)`) — defined here, re-exported by
  vestibulum. Full type definition in
  [`../04-shared-vocabulary.md`](../04-shared-vocabulary.md#tenantid).
- The `TenantResolver` interface — a strategy contract that consumers
  implement.
- A small set of bundled resolvers for common patterns: subdomain
  and custom-domain lookup, plus the `Composite` combinator. Each
  has an explicit trust model documented below. Other strategies
  (header, JWT claim, path prefix) are listed as candidates and
  ship when a consumer asks; see § Candidate strategies.
- Integration with `RequestContext`
  ([`./07-logger-and-request-context.md`](./07-logger-and-request-context.md))
  — when a resolver runs, the resulting `TenantId` lands on the
  context's `tenantId` field.

## What it does _not_ own

- **Tenant database / metadata.** The `{ tenantId → tenantName, plan,
features, ... }` table is the consumer's. Foundation never reads
  tenant records; it only mints and propagates the ID.
- **Cognito-IdP-name normalisation.** Cognito's `ProviderName` is
  capped at 32 characters and has its own charset rules; trellis's
  current `tenant/idp-name.ts` derives `tenant-{cuid-truncated-to-25}`.
  This normalisation lives in the **vestibulum runtime**, not
  foundation. The split is: foundation hands vestibulum a `TenantId`;
  vestibulum decides how to fit it into Cognito's namespace.
- **Tenant CRUD (create / update / delete).** Trellis's
  `tenant/tenant-handler.ts`, `member-handler.ts`,
  `domain-handler.ts`, etc., are HTTP handlers gluing together
  Prisma queries with route shapes. These do _not_ graduate.
  Foundation has the type and the resolver; tenant administration
  is the consumer's domain.
- **Reserved-slug lists.** Trellis ships a `reserved-slugs.ts`
  (admin, www, api, …). The list is consumer-policy. Foundation's
  `tenantId(...)` validator enforces the _format_ (1–256 chars, no
  whitespace) but not the _meaning_ (no "admin"). Consumers add their
  own check.

## Design

### Why opaque to foundation

A `TenantId` is consumer-defined. Consumers may pick:

- cuid v1 (25 chars, sortable) — what trellis uses
- nanoid / ulid
- a slug (`acme-corp`) — user-facing in subdomain routing
- an opaque UUID
- something else

Foundation enforces only "string, 1–256 chars, no whitespace or
control characters" — the constraints that prevent invisible-failure
modes (whitespace in URLs, empty strings in DB indexes). Anything
finer is the consumer's choice. This stays under the frozen-type
contract documented in
[`../04-shared-vocabulary.md`](../04-shared-vocabulary.md).

### `TenantResolver` interface

```typescript
export interface TenantResolver {
  resolve(input: TenantResolverInput): Promise<TenantId | null>;
}

export interface TenantResolverInput {
  readonly request: Request;
  readonly hostname: string; // already-parsed convenience
  readonly headers: ReadonlyMap<string, string>;
  /** Pre-extracted JWT claims, if the consumer's auth layer has run. */
  readonly claims?: Readonly<Record<string, unknown>>;
}
```

A resolver returns:

- `TenantId` — resolution succeeded; this is the request's tenant.
- `null` — resolution failed _non-fatally_ (e.g., a route that has no
  tenant context, like the sign-up landing page). The middleware
  proceeds with `tenantId` unset on the `RequestContext`.

Resolvers throw to signal _fatal_ tenant-resolution failure (the
request is _expected_ to be tenant-scoped but the tenant could not
be identified — e.g., unknown subdomain). The consumer's middleware
catches and returns a 404 / 400.

### Bundled resolvers

Three classes ship in v0.1: `SubdomainTenantResolver`,
`CustomDomainTenantResolver`, and `CompositeTenantResolver`. All
three are server-trust-anchored — the value the resolver returns is
either parsed from a hostname (which the server controls via DNS) or
looked up in the consumer's DB via a hostname key. Untrusted
strategies (header, JWT claim, path prefix) are listed as candidates
below and ship when a named consumer needs one; foundation does not
front-load resolver strategies that nothing currently uses.

```typescript
// 1. Subdomain: acme.myapp.com -> "acme"
export class SubdomainTenantResolver implements TenantResolver {
  constructor(options: { baseDomain: string });
  resolve(input: TenantResolverInput): Promise<TenantId | null>;
}

// 2. Custom domain: app.acme.com -> lookup -> "acme"
export class CustomDomainTenantResolver implements TenantResolver {
  constructor(options: { lookup: (hostname: string) => Promise<TenantId | null> });
  resolve(input: TenantResolverInput): Promise<TenantId | null>;
}

// Composition: first non-null wins; errors short-circuit (do NOT
// fall through). Order resolvers verified-source-first.
export class CompositeTenantResolver implements TenantResolver {
  constructor(resolvers: ReadonlyArray<TenantResolver>);
  resolve(input: TenantResolverInput): Promise<TenantId | null>;
}
```

Trellis's existing tenant resolution is subdomain-based with a
custom-domain fallback. The cutover instantiates:

```typescript
const tenantResolver = new CompositeTenantResolver([
  new SubdomainTenantResolver({ baseDomain: "trellis.example" }),
  new CustomDomainTenantResolver({ lookup: customDomainLookup }),
]);
```

`customDomainLookup` is a closure the consumer provides — it hits
the consumer's tenant table. Foundation does not touch the DB.

### Security model per strategy

Tenant resolution is a load-bearing authorization input — every
downstream check ("does this user have access to this tenant?")
implicitly trusts the resolved `TenantId`. The trust model of _how_
that ID was obtained matters. Each bundled strategy has a different
posture:

- **`SubdomainTenantResolver`** — server-controlled via DNS. The
  hostname arriving on the request is whatever the client typed into
  the address bar, but the _meaning_ of "acme.myapp.com → acme" is
  encoded in the server's `baseDomain` config. Caveat: vulnerable to
  **subdomain takeover** when stale CNAMEs point at deprovisioned
  third-party endpoints (S3 buckets, Heroku apps). Mitigation lives
  in DNS hygiene, not the resolver — periodic sweep for dangling
  records.
- **`CustomDomainTenantResolver`** — server-controlled via the
  consumer's DB. The hostname is the key; the value comes from a
  table foundation does not write. Provided the consumer's
  `lookup(hostname)` only returns a `TenantId` for hostnames the
  tenant has demonstrated control over (DNS TXT challenge, ACME
  HTTP-01), this is the most trustworthy bundled strategy.
- **`CompositeTenantResolver`** — composes the above. Ordering
  matters: see § Composite ordering and trust below.

### Composite ordering and trust

`CompositeTenantResolver` walks its resolvers in order and returns
the first `TenantId` produced. **Order resolvers verified-source-
first.** With only server-trust-anchored strategies bundled in v0.1
(subdomain, custom-domain) this is a non-issue, but the _moment_ a
candidate strategy ships — particularly `HeaderTenantResolver` or
`PathPrefixTenantResolver` — mixed-trust composition becomes the
dangerous case:

```typescript
// WRONG: header overrides verified subdomain
new CompositeTenantResolver([
  new HeaderTenantResolver({ header: "X-Tenant-Id" }), // attacker-controlled
  new SubdomainTenantResolver({ baseDomain: "myapp.com" }),
]);

// CORRECT: verified subdomain wins; header is a fallback for routes
// where no subdomain is meaningful (admin tools authenticated by
// other means)
new CompositeTenantResolver([
  new SubdomainTenantResolver({ baseDomain: "myapp.com" }),
  new HeaderTenantResolver({ header: "X-Tenant-Id" }),
]);
```

Even the "correct" form is risky if the consumer wires a route that
the subdomain resolver returns `null` for (e.g., the bare apex
domain) — the header resolver then runs unconditionally and accepts
a client-supplied value. The doc-level guidance: **do not mix
trusted and untrusted strategies in one composite.** Use the
composite for fallback chains within a single trust class.

`Composite.resolve` short-circuits on the first non-null result and
on the first thrown error. An error from resolver #N does **not**
fall through to resolver #N+1 — the verified-source-first ordering
means an early error is meaningful (e.g., the subdomain lookup
threw because the DNS resolver is down) and should be surfaced
rather than silently retried against a less-trusted source.

### Candidate strategies

Three strategies that exist as designed shapes but do not ship in
v0.1 because no current consumer requires them. Disposition:
first-asking-consumer ships it, with the doc-level security framing
sketched here making the trade-offs visible up-front.

```typescript
// Header: X-Tenant-Id: acme. Use case: admin / API-key surfaces where
// the *caller's* identity (the API key) is the trust anchor, not the
// claimed tenant. NOT safe behind public Internet without a paired
// authorization check that verifies the caller may *act on* the
// claimed tenant.
export class HeaderTenantResolver implements TenantResolver {
  /* candidate */
}

// JWT claim: custom:tenantId in Cognito access token. Trust requires
// that the JWT has been signature-verified *before* the resolver
// reads it. If the consumer's middleware order puts tenant resolution
// before JWT verification, the claim is attacker-controllable.
export class ClaimTenantResolver implements TenantResolver {
  /* candidate */
}

// Path prefix: /t/:tenantId/.... Each route asserts membership, but
// without a paired authorization check this is an IDOR vector — any
// user can change the path segment to a different tenant. Reserved
// for cases where the route handler does explicit access-control.
export class PathPrefixTenantResolver implements TenantResolver {
  /* candidate */
}
```

A future consumer asking for one of these gets a focused review of
their middleware ordering and downstream authorization story at the
time the strategy ships. Listing them here documents the design
space without committing to maintenance.

### `resolveTenant` — the entry point

```typescript
export async function resolveTenant(
  resolver: TenantResolver,
  input: TenantResolverInput,
): Promise<TenantId | null>;
```

The thin wrapper that the consumer's middleware calls at request
entry. Resolution happens _before_ `RequestContext` is constructed so
the `tenantId` is included in the initial context object (which is
then `Object.freeze`d per the frozen-type discipline).

### Integration with `RequestContext`

`RequestContext.tenantId?: TenantId` is part of the frozen vocabulary
([`../04-shared-vocabulary.md`](../04-shared-vocabulary.md#requestcontext)).
The consumer's middleware sets it during context construction:

```typescript
// Consumer middleware
app.use(async (c, next) => {
  const tenantId = await resolveTenant(tenantResolver, {
    request: c.req.raw,
    hostname: new URL(c.req.url).hostname,
    headers: new Map(c.req.raw.headers),
    claims: c.get("claims"), // set by earlier auth middleware
  });

  const context = createRequestContext({
    requestId: crypto.randomUUID(),
    startedAt: Date.now(),
    tenantId: tenantId ?? undefined,
    // ...
  });

  return runWithRequestContext(context, async () => next());
});
```

`createRequestContext` and `runWithRequestContext` live in the
request-context module ([`./07-logger-and-request-context.md`](./07-logger-and-request-context.md)).
Foundation does not ship middleware — the consumer assembles the
pieces.

### Validation on construction

```typescript
export function tenantId(value: string): TenantId {
  if (typeof value !== "string") {
    throw new TenantIdValidationError(value, "must be a string");
  }
  // Validated against TENANT_ID_CONSTRAINTS: 1–256 chars; no
  // whitespace, C0 control chars, or DEL (pattern /^[^\s\x00-\x1f\x7f]+$/).
  // On failure: throw new TenantIdValidationError(value, reason).
  return value as TenantId;
}

export function isTenantId(value: unknown): value is TenantId {
  // True iff `value` is a string satisfying the constraints. Never throws.
}
```

`TenantIdValidationError` extends `Error` (constructor
`(input: unknown, reason: string)`; the resulting message is
`Invalid TenantId: ${reason}` and the offending input is preserved on
`.input`). It is defined alongside the `TenantId` type in
`src/types/frozen/tenant.ts`, not in a separate `validators` module.
Resolver implementations call `tenantId(rawString)` to convert their
candidate to a branded type; catching `TenantIdValidationError` is how
they decide whether a candidate string is even worth a lookup.

## TypeScript surface

```typescript
// Frozen-set type + validators (canonical definition in
// foundation/src/types/frozen/tenant.ts; the tenant module re-exports
// them for ergonomic consumption).
export type { TenantId, TenantIdConstraints } from '../types/frozen/tenant.js';
export {
  TENANT_ID_CONSTRAINTS,
  TenantIdValidationError,
  tenantId,
  isTenantId,
} from '../types/frozen/tenant.js';

// Resolution
export interface TenantResolverInput {
  readonly request: Request;
  readonly hostname: string;
  readonly headers: ReadonlyMap<string, string>;
  readonly claims?: Readonly<Record<string, unknown>>;
}

export interface TenantResolver {
  resolve(input: TenantResolverInput): Promise<TenantId | null>;
}

export async function resolveTenant(
  resolver: TenantResolver,
  input: TenantResolverInput,
): Promise<TenantId | null>;

// Bundled resolvers
export class SubdomainTenantResolver implements TenantResolver { /* ... */ }
export class CustomDomainTenantResolver implements TenantResolver { /* ... */ }
export class CompositeTenantResolver implements TenantResolver { /* ... */ }

// ALS carrier
export function runWithTenantContext<T>(tenantId: TenantId, fn: () => T): T;
export function getCurrentTenantId(): TenantId | undefined;

// Candidate (not built; ship on consumer demand)
//   class HeaderTenantResolver
//   class ClaimTenantResolver
//   class PathPrefixTenantResolver

// Resolver errors
export class TenantResolverError extends Error {
  constructor(message: string, options?: { hostname?: string; cause?: unknown });
  readonly hostname: string | undefined;
}
export class TenantNotFoundError extends Error {
  constructor(message?: string, hostname?: string);
  readonly hostname: string | undefined;
}
export class TenantAuthorizationError extends Error {
  constructor(reason: string);
  readonly reason: string;
}
```

## Caveats

- **`SubdomainTenantResolver` and Public-Suffix-List.** Trellis ships
  a `psl-snapshot.txt` to distinguish `acme.example.com`
  (`acme` is the tenant) from `acme.co.uk` (`acme.co` is not a
  tenant — `co.uk` is a public suffix). Foundation's
  `SubdomainTenantResolver` uses a configurable `baseDomain`
  parameter to side-step this complexity (`baseDomain: 'myapp.com'`
  means anything to the left is the tenant; anything that doesn't
  end in `.myapp.com` is no-tenant). Consumers that _need_ PSL
  parsing for their setup wrap a third-party PSL library themselves
  — foundation does not ship one. (Trellis's PSL snapshot is for
  domain _validation_ on tenant signup, which stays in trellis.)
- **`CustomDomainTenantResolver` cache.** Looking up
  `hostname → tenantId` on every request is expensive. Foundation
  does not cache for the consumer — caching policy is application-
  specific. The consumer wraps `lookup` with their own cache
  (in-memory LRU is usually enough).
- **The `claims` field on `TenantResolverInput` is verifier-
  dependent.** It exists on the input shape because consumer custom
  resolvers (and the future candidate `ClaimTenantResolver`) read
  from it. Whatever the consumer's auth middleware attached must
  already be signature-verified (vestibulum's JWT verifier is the
  intended source). Foundation has no way to detect an unverified
  payload — if the consumer passes raw claims into `resolveTenant`,
  the trust property is on the consumer.
- **Multi-tenancy in a single request.** Some admin operations span
  tenants ("list all tenants on this plan"). The convention:
  resolver returns `null`, the admin handler explicitly does not
  rely on `requestContext.tenantId`. Audit events for cross-tenant
  ops have `tenantId: undefined` and a metadata field documenting
  the scope. The audit schema permits this
  ([`../04-shared-vocabulary.md`](../04-shared-vocabulary.md#auditevent)).

## Open questions

- **A `TenantContext` interface bundling `TenantId` with consumer-
  attached tenant data (theme, features, etc.)?** Tempting because
  every handler that reads `tenantId` also wants to read tenant
  metadata. Counter: the metadata is consumer-shaped and lives in
  the consumer's DB; foundation should not be the cache for it.
  Consumers wanting this pattern declare-merge into `RequestContext`
  ([`../04-shared-vocabulary.md`](../04-shared-vocabulary.md#requestcontext))
  or attach a `tenant: Tenant` field via their own middleware.
  Leaning: do not ship a `TenantContext` type from foundation.
- **`CrossTenantOp` audit helper?** A small helper to construct the
  `AuditEvent { tenantId: undefined, metadata: { scope: 'cross-tenant', ... } }`
  shape. Sugar; could live in foundation. Probably yes — it
  documents the convention. Add when the audit module lands.
- **`TenantResolver.resolve` accepting a `RequestContext` rather
  than raw `Request`?** Cleaner, but circular — the resolver runs
  _before_ the context is constructed because the context wants
  `tenantId` populated. Current shape (raw request + headers +
  hostname + claims) is correct.
- **Pre-resolver hook for blocking tenants (suspended accounts)?**
  Could be a `TenantGuard` interface that runs after the resolver
  and can convert a resolved `TenantId` into a thrown
  `TenantSuspendedError`. Consumer-policy; probably skip — consumer
  middleware after `resolveTenant` does this with a single DB lookup.
