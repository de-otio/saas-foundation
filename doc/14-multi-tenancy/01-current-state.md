# 01 — Current state

What exists in trellis today, grounded in the code. File paths are under
`trellis/apps/api/` unless noted; the schema is `trellis/prisma/schema.prisma`.

## 1. Tenant identity layer — complete

Trellis already models tenants as first-class B2B organizations:

| Model | Role |
| --- | --- |
| `Tenant` | The org (or a per-user **personal** tenant). `type: PERSONAL \| ORGANIZATION`, `status`, `slug`, `region`, `personalOwnerUserId`. |
| `TenantMember` | User↔tenant membership with `role` (OWNER/ADMIN/MEMBER/GUEST), `status`, JIT-provisioning flag. Unique on `[tenantId, userId]`. |
| `TenantIdentityProvider` | Per-tenant SSO (SAML/OIDC), Cognito provider name, attribute mapping. One per tenant. |
| `TenantRoleMapping` | IdP group → tenant role, with priority. Unique on `[tenantId, idpGroupName]`. |
| `TenantDomain` | Verified custom domains (DNS/HTTP token), for JIT SSO by email domain. |
| `TenantInvitation` | Pending email invites to a tenant. |

The routes (`routes/tenants.ts`, `tenant-members`, `tenant-idp`,
`tenant-role-mappings`, `tenant-domains`, plus `POST /api/auth/switch-tenant`)
are an **identity/admin/federation** surface. **None of them partition content
data** — they manage who belongs to which org and how they authenticate.

## 2. Content is already row-tagged with `tenantId`

~12 content models carry a `tenantId` **with a real FK relation** to `Tenant`
(`onDelete: Cascade`):

`Post`, `PostComment`, `Entity`, `Notification`, `Group`, `GroupMember`,
`EntityOwnership`, `ConnectionCode`, `ConnectionCodeRedemption`,
`TaxonomyDimension`, `TaxonomyCategory`, `TaxonomyTaxon`.

The schema comments describe `tenantId` on `Post`/`PostComment`/`Entity` as
**denormalized** — meaning the application is responsible for populating it from
the writer's active tenant. The FK exists (referential integrity + cascade
delete), but **Prisma does not auto-set it and does not auto-filter by it**.

`SecurityEvent` and `AuditEvent` carry a **nullable** `tenantId` (some events
are system-level). That nullability is a query-safety footgun — see
[05](05-enforcement-and-migration.md).

## 3. The tenant is known per request — via the JWT claim

Resolution today is **claim-based**, not host-based:

- `lambda/pre-token-generation.ts` runs on every token issue/refresh. It loads
  the user's `TenantMember` rows, picks an **active tenant** (explicit
  preference → first ORGANIZATION → personal → any ACTIVE), resolves federated
  IdP groups → role via `TenantRoleMapping`, and writes claims:
  `userId, globalRole, activeTenantId, tenantSlug, tenantRole, handle`. Cached
  in DynamoDB (3600s TTL; invalidated on tenant switch).
- `lib/auth/auth-middleware.ts` reads `custom:activeTenantId` (and friends) off
  the verified claims into `AuthContext.activeTenantId` (required; missing →
  401). It also lazily loads all ACTIVE memberships for the tenant-switcher UI.

So **every authenticated request already carries `auth.activeTenantId`.** The
hard part of "which tenant is this request?" is solved. What's missing is using
it to *scope data*.

## 4. Region is orthogonal to tenant

Trellis has a **region** concept (`US`/`EU`/`CN`) for data residency:

- `lib/request-context.ts` builds `TrellisRequestContext` with `region` +
  region `config` (no tenant field today).
- `lib/database-connection-manager.ts` keeps one connection pool **per region**
  (per connection string). Region selects *which database*.
- A user's region follows the **user** (`Session.dataRegion`), not the tenant.

Region answers *"which database/instance?"*; tenant answers *"which rows within
it?"*. They compose cleanly and independently: tenant isolation is a filter
*within* a region's dataset. (One wrinkle for org tenants spanning regions is
noted in [05](05-enforcement-and-migration.md).)

## 5. Data access pattern — no scoping choke point

- `db.ts` `createPrisma(env, region)` returns a **bare** Prisma client.
- `lib/db-query-helper.ts` `withQueryTimeoutAndRetry()` wraps a
  `(client) => Promise<T>` callback with timeout/retry — it does not see or
  constrain the `where` clause.
- `lib/database-connection-manager.ts` `executeWithRetry()` adds retry +
  circuit breaker around the query — also `tenantId`-agnostic.
- Handlers (`post-handler.ts`, `feed-handler.ts`, `media-handler.ts`, …)
  **hand-build `where` clauses** and receive `activeTenantId` as a *parameter*.
  Nothing forces them to apply it.

## 6. The gap, stated precisely

Two facts combine into a real vulnerability class:

1. **A user can belong to multiple tenants** (personal + N orgs).
2. **Reads commonly filter by `authorId` / `userId`, not `tenantId`.**

So a query like `db.post.findMany({ where: { authorId } })` returns that user's
posts **across every tenant they belong to** — a cross-tenant disclosure if the
caller is acting within a single org context. This is not theoretical; it's the
default behavior of the current unscoped queries.

The fix is an **enforced** scoping seam (so "forgot the filter" cannot happen)
plus a **database backstop** (so a code-level miss still fails closed). That is
the subject of [02](02-isolation-strategies.md), [03](03-foundation-fit.md), and
[05](05-enforcement-and-migration.md).
