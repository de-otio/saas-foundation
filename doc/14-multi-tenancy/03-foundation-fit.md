# 03 — Fit with `@de-otio/saas-foundation/tenant`

What the foundation tenant module provides, what it deliberately does **not**,
and exactly which parts trellis should adopt now vs later.

## What the module is

A **resolution + context-propagation** layer. Two halves:

### Half 1 — resolution (deriving a `TenantId` from a request)

- `TenantResolver` interface: `resolve(input) => Promise<TenantId | null>`,
  where `input` carries `request`, lower-cased `hostname`, lowered `headers`,
  and optional pre-verified `claims`.
- Bundled strategies:
  - `SubdomainTenantResolver` — `acme.app.com` → `acme` (server-trust-anchored
    via your DNS zone).
  - `CustomDomainTenantResolver` — full host → consumer `lookup(host)` (the most
    trustworthy bundled strategy; resolves through your own verified-domain DB).
  - `CompositeTenantResolver` — tries resolvers in order; **refuses** to mix
    `server-trust-anchored` with `untrusted` resolvers (constructor throws), so
    an untrusted strategy can't override a verified one.
- `TenantId` is a **branded string** (1–256 chars, no whitespace/control chars)
  with `tenantId()` / `isTenantId()`.
- Errors: `TenantResolverError` (fatal lookup failure — DNS/DB down, distinct
  from "no match" which is `null`), `TenantNotFoundError`,
  `TenantAuthorizationError` (reserved for consumer guards, e.g. suspended).

### Half 2 — context propagation (the ALS carrier)

- `tenantStorage: AsyncLocalStorage<TenantId>` — one process-global instance.
- `runWithTenantContext(tenantId, fn)` — runs `fn` (and everything it awaits)
  with the tenant in ambient context.
- `getCurrentTenantId(): TenantId | undefined` — read it at the data layer;
  `undefined` outside any scope.

## What the module explicitly does NOT do

> "every downstream 'does this user have access to this tenant?' check
> implicitly trusts the resolved TenantId" — `resolver.ts`

It is a **trust boundary for resolution only**. There is **no** data-layer
isolation: no query scoping, no row filtering, no Postgres RLS, no Prisma
middleware. **Authorization and data isolation are the consumer's job.** This is
the right boundary — it's also exactly the part trellis must build.

## How trellis should use it

### Adopt now: the ALS carrier (Half 2) — exact fit

This is the missing piece that turns trellis's `activeTenantId` claim into an
*ambient* value the data layer can enforce against without threading it through
every function signature:

1. After auth resolves `auth.activeTenantId`, wrap the request:
   `runWithTenantContext(tenantId(auth.activeTenantId), () => handle(request))`.
2. The Prisma client extension and/or RLS connection setup read
   `getCurrentTenantId()` to scope queries (see
   [05](05-enforcement-and-migration.md)).

Today `activeTenantId` is passed as a *parameter* to some handlers and ignored
by most queries. The ALS carrier replaces that error-prone threading with an
ambient value that the enforcement seam reads — so individual handlers can no
longer "forget" to pass it.

### Don't adopt (yet): the resolution strategies (Half 1)

Trellis resolves the tenant from the **verified JWT claim** (`activeTenantId`),
not from the hostname. The subdomain/custom-domain strategies solve a *different*
problem (host → tenant) that trellis's authenticated API doesn't have. Forcing
them in now would be the same filename-heuristic mistake the migration kept
catching.

Two places the strategies **do** become useful later, and are worth keeping in
mind:

- **Custom-domain → tenant routing.** Trellis already has `TenantDomain`
  (verified custom domains). If the product later serves tenant-branded
  experiences at `app.example.com`, `CustomDomainTenantResolver` with a `lookup`
  backed by `TenantDomain` is the right tool — and its trust model (resolve only
  through verified domains) matches `TenantDomain`'s verification flow exactly.
- **A claims-based resolver.** If trellis wants resolution to go through the
  foundation interface uniformly, it can implement a tiny `TenantResolver` that
  reads `claims["custom:activeTenantId"]` and returns `tenantId(...)`. Optional
  — the value is already on `AuthContext`; the only benefit is interface
  uniformity if/when host-based resolution is added alongside.

### Consider: `TenantId` branding at the boundary

Validating `auth.activeTenantId` through `tenantId()` once at the auth seam
gives a branded value to pass into `runWithTenantContext`, turning "is this a
real tenant id" into a type-level guarantee downstream. Cheap, and it catches
empty-string/`""` active-tenant claims (the PreTokenGeneration Lambda writes
`""` when there's no active membership) before they reach the data layer.

## Boundary summary

| Concern | Owner |
| --- | --- |
| Resolve tenant from request (host) | foundation strategies — **later**, for custom domains |
| Resolve tenant from JWT claim | trellis (already done in PreTokenGeneration + auth-middleware) |
| Carry tenant through the request | **foundation ALS carrier — adopt now** |
| Scope queries by tenant (app) | trellis (Prisma extension — build) |
| Enforce isolation at the DB | trellis (Postgres RLS — build) |
| Authorize tenant access / suspension | trellis (guards; may throw foundation's `TenantAuthorizationError`) |
