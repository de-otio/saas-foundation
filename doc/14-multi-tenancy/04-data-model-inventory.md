# 04 — Data-model inventory

Every model classified for isolation. Source: `trellis/prisma/schema.prisma`
(~68 models). This drives which tables get RLS policies and which need schema
changes before enforcement is safe.

## A. Tenant infrastructure (the tenant *is* the subject)

`Tenant`, `TenantMember`, `TenantDomain`, `TenantIdentityProvider`,
`TenantRoleMapping`, `TenantInvitation`.

Scoped by `id`/`tenantId` already. Access is gated by membership + role, not by
the ambient-tenant filter (an OWNER reads their own `TenantMember` roster). RLS
here keys on `tenant_id = current` for the child tables; `Tenant` itself is
read by id with a membership check.

## B. Already `tenantId`-scoped content — ready for enforcement

`Post`, `PostComment`, `Entity`, `Notification`, `Group`, `GroupMember`,
`EntityOwnership`, `ConnectionCode`, `ConnectionCodeRedemption`,
`TaxonomyDimension`, `TaxonomyCategory`, `TaxonomyTaxon`.

- Have `tenantId` + FK to `Tenant`. **These get RLS policies and the Prisma
  extension's auto-filter directly.**
- Action: audit writes to confirm `tenantId` is always populated from the
  *active* tenant (the schema calls these "denormalized" — the app owns
  correctness). Add a not-null + RLS `WITH CHECK` so a write with the wrong/empty
  tenant fails closed.

## C. Scoped-by-relation (no own `tenantId`, but reachable)

These inherit tenant via a parent in group B. Two ways to handle them:

- `PostMedia`, `PostSentiment`, `PostSubject`, `PostCommentMedia`,
  `CommentSentiment`, `PostTaxonomyTag`, `EntityTaxonomyTag` — join/child rows
  off `Post`/`PostComment`/`Entity`/taxonomy.
- `LinkCheck` — off `Post`/`PostComment` (nullable each).

**Decision per table:** either (1) **denormalize `tenantId`** onto the child
(fast, RLS-able directly, costs a column + backfill), or (2) rely on the
parent's scoping (RLS via a join/subquery in the policy — correct but slower,
and easy to get subtly wrong). Recommendation: **denormalize `tenantId` onto the
high-traffic children** (`PostMedia`, `PostSentiment`, `LinkCheck`) for simple,
fast RLS; leave pure join tables keyed by already-scoped parents.

## D. Global by design — must NOT be tenant-scoped

These are intentionally cross-tenant; scoping them would break the product:

- `MediaFile` — **content-addressed** (SHA-256), deduplicated across tenants.
  Isolation concern is *access* (can tenant X reference blob Y?), not row
  ownership. Keep global; enforce via the *referencing* row's tenant
  (`PostMedia`/`PostCommentMedia`) and a per-tenant access check on fetch. Note
  the side effects: cross-tenant dedupe means storage accounting and "delete my
  data" must reason about shared blobs.
- `DirectMessage` — crosses personal tenants by design (user↔user). Scope by
  **participant**, not tenant. If org-private messaging is ever required, that's
  a *new* `TenantMessage` model, not a change here.
- `DomainReputation`, `EmailSuppression`, `FeatureToggle`, `IngestState`,
  `RoleMetadata` — operator/global infrastructure. Stay global.
- `Activity` (ActivityPub) — federation graph is global by protocol.

These tables get **no** tenant RLS; document them explicitly as the allowlist so
"no policy" reads as a decision, not an omission.

## E. User-owned, cross-tenant — scope by user, not tenant

`CircleConfig`, `CircleReadState`, `CustomAudience`, `CustomAudienceMember`,
`UploadSession`, `MfaEnrollment`, `UserEncryptionKey`, `CrossRegionConsent`,
`NotificationPreference`, `LinkReport`, `ParentalLink`, `DeletionAuditLog`,
`Invitation` (social, ≠ `TenantInvitation`).

These belong to a **user** who may span tenants; the correct boundary is
`userId`, not `tenantId`. Keep user-scoped. (`Notification` is the exception —
it *is* tenant-tagged, group B.)

## F. The `User` model — special

A user is **not** tenant-bound: one `personalTenantId` (1:1) plus N org
`tenantMemberships`. So `User` rows are not tenant-scoped; what's tenant-scoped
is the *membership* (`TenantMember`) and the user's *content* (group B). Profile
visibility across tenants is an authorization question, not a row-isolation one.

## Gaps to fix before/with enforcement

| # | Model | Issue | Action |
| --- | --- | --- | --- |
| 1 | `ProductTaxonomyTag` | References a `productId` but **`Product` is not in the schema** — orphaned; `productId` has no FK and no tenant path. | Define `Product` (with `tenantId`) or remove the table. Blocks RLS reasoning about it. |
| 2 | `PostGeoIndex` | No `tenantId`, no FK — links by `postUri`/`entityRef` strings. Location data is sensitive. | Denormalize `tenantId` for fast, safe tenant-scoped geo queries. |
| 3 | `SecurityEvent`, `AuditEvent` | **Nullable** `tenantId` (system events). A naive `WHERE tenant_id = ?` drops system rows; a missing filter leaks. | Decide the contract; RLS policy must allow `tenant_id IS NULL` reads only for operator roles. |
| 4 | `LinkCheck`, `LinkReport` | Tenant only via relation/`userId`. | Denormalize `tenantId` onto `LinkCheck`; `LinkReport` stays user-scoped (group E). |
| 5 | `MediaFile` | Cross-tenant dedupe ⇒ shared-blob deletion & quota semantics. | Document the access-check-on-reference model; decide quota accounting. |

## Inventory summary

- **Scoped now (B):** ~12 models — enforce directly.
- **Scoped-by-relation (C):** ~8 — denormalize the hot ones, policy the rest.
- **Global by design (D):** ~9 — explicit no-RLS allowlist.
- **User-scoped (E):** ~13 — boundary is `userId`.
- **Gaps (F-table):** 5 items to resolve before claiming full coverage.

The point of the inventory: RLS is only "complete" if *every* table is either
policied or on the documented global/user-scoped allowlist. A table that is
neither is a silent hole.
