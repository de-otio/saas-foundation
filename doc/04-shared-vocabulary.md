# 04 — Shared vocabulary

The frozen cross-package type set. These nine types form the
contract that holds the runtime packages together: foundation mints
six (`TenantId`, `TenantSubdomain`, `ClientConfigRow`, `AuditEvent`,
`RequestContext`, `SecretRef`) and vestibulum mints three
(`ClaimResolverInput`, `ClaimResolverOutput`, `ProvisionerInput`).
They live under each package's `src/types/frozen/` — the path the CI
fanout gate watches. Consumers import them; vestibulum re-exports the
four it surfaces directly and reads the rest via the
`@de-otio/saas-foundation/types/frozen` subpath. A change to any
shape here ripples through every package and every consumer
simultaneously, which is why they require an RFC and a coordinated
bump ([`05-versioning-and-releases.md`](05-versioning-and-releases.md)).

The set is deliberately small. Everything else — module-internal
helpers, AWS SDK input shapes, per-handler request/response types —
lives inside one package and can churn freely.

## Immutability convention

**Every field on every type in this doc carries `readonly`. Every
`Record<>` is `Readonly<Record<>>`. Every array is `ReadonlyArray<>`.**
The convention is uniform — not "where mutation would be a problem,"
but everywhere. The reviewer-cost rationale lives in
[`10-ai-maintained-conventions.md § Immutability is the default`](10-ai-maintained-conventions.md#1-immutability-is-the-default);
the short version is that a reviewer who knows a value is immutable
does not have to investigate "who else might mutate this?" — the
question doesn't apply.

The first review pass caught one drift here
([B-K](review/2026-05-24-initial-design-pass.md#b-k--claimresolverinputuserattributes-clientmetadata-drift-between-vocabulary-and-package-api));
the convention exists to prevent the class.

## Property-based brand checkers

Every brand checker exported from this set (`isTenantId`,
`isSecretRef`, `isAuditEvent`, etc.) and every constructor
(`tenantId(...)`, `secretRef(...)`) ships with **property-based
tests** using `fast-check`. The test file generates 1000 random
inputs across both the valid and invalid spaces and asserts the
checker's invariants (validator and constructor agree; the inverse
holds; the brand is preserved across round-trips).

Brand checkers are the highest-leverage place for property-based
tests because their bugs ripple through every consumer that
imports the type. The cost is low (one test file per type, one
generator per validator); the catch rate is much higher than
hand-written examples.

## Where each type is defined

All frozen-set type _definitions_ live in a single, layer-0
location per package. Logic (validators, factories, AsyncLocalStorage
plumbing) lives in the per-module directories; types do not. The
split exists so the layering rule in
[`03-package-relationships.md`](03-package-relationships.md#cycle-prevention)
can hold without contradicting itself (`RequestContext` is a layer-1
concept that references `TenantId` — a layer-2 concept; both can
import from layer 0 without violating the rule). It also gives the
CI fanout gate one path per package to watch instead of many.

| Type                  | Defined in                                       | Re-exported by      | Reason                                                                 |
| --------------------- | ------------------------------------------------ | ------------------- | ---------------------------------------------------------------------- |
| `TenantId`            | `foundation/src/types/frozen/tenant.ts`          | `vestibulum`        | Multi-tenancy is a foundation concern; identity is one consumer        |
| `AuditEvent`          | `foundation/src/types/frozen/audit.ts`           | `vestibulum`        | Audit log persistence is in foundation; identity emits events into it  |
| `RequestContext`      | `foundation/src/types/frozen/request-context.ts` | `vestibulum`        | AsyncLocalStorage carrier; foundation owns the lifecycle               |
| `SecretRef`           | `foundation/src/types/frozen/secrets.ts`         | `vestibulum`        | Secrets primitive in foundation; IdP managers consume                  |
| `TenantSubdomain`     | `foundation/src/types/frozen/tenant-subdomain.ts`| — (via subpath)     | Per-tenant subdomain routing in shared-distribution; foundation owns tenancy primitives |
| `ClientConfigRow`     | `foundation/src/types/frozen/client-config-row.ts`| — (via subpath)    | Persisted shared-distribution per-tenant config row; read by the edge / trigger loaders |
| `ClaimResolverInput`  | `vestibulum/src/types/frozen/callbacks.ts`       | — (not re-exported) | Cognito-shaped; not a foundation concern                               |
| `ClaimResolverOutput` | `vestibulum/src/types/frozen/callbacks.ts`       | — (not re-exported) | Consumer→vestibulum contract; deployed Lambdas receive consumer output |
| `ProvisionerInput`    | `vestibulum/src/types/frozen/callbacks.ts`       | — (not re-exported) | Cognito-shaped; not a foundation concern                               |

Re-exports keep the consumer's import surface flat. A consumer using
vestibulum imports `TenantId` from `@de-otio/vestibulum` and never
needs to know foundation defined it. The corollary: foundation
cannot re-export from vestibulum (no upward arrows;
[`03-package-relationships.md`](03-package-relationships.md)).

## `TenantId`

```typescript
declare const TenantIdBrand: unique symbol;

export type TenantId = string & { readonly [TenantIdBrand]: true };

export interface TenantIdConstraints {
  readonly minLength: 1;
  readonly maxLength: 256;
  readonly pattern: RegExp; // /^[^\s\x00-\x1f\x7f]+$/  — no whitespace, no C0 controls, no DEL
}

export function tenantId(value: string): TenantId;
export function isTenantId(value: unknown): value is TenantId;
```

**Why a branded string.** Tenant IDs are consumer-defined — cuid,
uuid, slug, opaque hash, anything — and foundation must not impose
a format. But a `string` typed as `TenantId` should not be
assignable from a raw string without going through validation, or
the type system gives no warning about confusing a tenant ID with,
say, a user ID. Branded strings give a zero-runtime-cost nominal
type without committing to a structural shape.

**Constraints**, enforced by `tenantId(...)`:

- 1–256 characters. (Lower bound: no empty strings as tenant
  identifiers. Upper bound: DB index size predictability; 256 is
  arbitrary but generous.)
- No whitespace or control characters. (Tenant IDs end up in URLs,
  logs, and Cognito normalisation chains; whitespace causes
  invisible-failure modes.)
- No other character restrictions at this level. Specific
  destinations (Cognito's `ProviderName`, S3 prefix, DynamoDB
  partition key) normalise further at use site, not here.

**Identity in storage.** Tenant IDs are opaque to foundation. The
consumer's database is the source of truth for the
`{tenantId → ... }` mappings. Foundation provides the type and the
validator; the consumer provides the values.

**Forbidden.** `TenantId` is not a class. No methods, no mutation,
no internal state. It is a string for all wire / storage purposes;
the brand is type-system-only and erases at compile time.

## `AuditEvent`

```typescript
export interface AuditEvent {
  readonly id: string; // ulid; ordered, sortable
  readonly timestamp: string; // ISO 8601, UTC, ms precision
  readonly tenantId?: TenantId; // absent for cross-tenant events
  readonly actor: AuditActor;
  readonly action: AuditAction;
  readonly resource?: AuditResource;
  readonly outcome: "success" | "failure";
  readonly failureReason?: string; // populated iff outcome === 'failure'
  readonly severity: "info" | "warning" | "error";
  readonly requestId?: string; // links to RequestContext
  readonly traceId?: string; // distributed tracing
  readonly ipAddress?: string; // already scrubbed if region requires
  readonly userAgent?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export type AuditActor =
  | {
      kind: "user";
      userSub: string;
      /** Set for federated logins; absent for native Cognito sign-ins. */
      idp?: { providerName: string; providerType: "OIDC" | "SAML" };
    }
  | { kind: "service"; serviceName: string }
  | { kind: "system"; component: string } // e.g., a scheduled job
  | { kind: "anonymous" }; // unauthenticated request

export interface AuditResource {
  readonly kind: string; // open string; conventions per consumer
  readonly id: string;
}

export type AuditAction =
  | "auth.login"
  | "auth.logout"
  | "auth.federated_link"
  | "idp.create"
  | "idp.update"
  | "idp.delete"
  | "data.read"
  | "data.create"
  | "data.update"
  | "data.delete"
  | (string & {}); // open: consumers add their own
```

**Why frozen.** This is the persisted shape. Once a field is written
to the audit table, renaming or removing it forces a migration of
every prior row. Hence the discipline of forcing an RFC for shape
changes.

**Open vs closed enums.** `outcome` and `severity` are closed —
they shape persistence (retention tiers, alerting). `action` and
`AuditResource.kind` are **open string unions** — the well-known
values get autocomplete, but consumers extend the set without an
API bump. `AuditActor.kind` is closed because the four cases above
exhaust the meaningful provenance levels; a new kind needs an RFC.

**Severity → retention.** Foundation's audit log default retention:

- `info`: 30 days.
- `warning`: 180 days.
- `error`: 400 days (just over a typical annual audit cycle).

These defaults are GDPR-storage-minimisation-friendly. Foundation
does not default to industry-maximum retention (SOX/7y, HIPAA/6y)
because saas-foundation targets DACH/EU SaaS workloads; consumers
in regulated verticals lengthen via `AuditStoreOptions`
([`foundation/06-audit-log.md`](foundation/06-audit-log.md)). The
retention values are persisted on the row via DynamoDB TTL at write
time; changing the policy post-write does not retroactively change
retention. The frozen-set guarantees keep the severity enum stable.

**Metadata.** `metadata` is the extension point for fields foundation
doesn't know about. It carries `JsonValue` only (no `Date`, no
functions, no class instances) so the audit log can round-trip via
JSON without loss. Consumers should treat unknown metadata keys
defensively — what's written today may not be what's queried
tomorrow.

**No PII in top-level fields.** `ipAddress` is scrubbed by region
policy _before_ the event is constructed
(`foundation/src/net/ip-scrubber`); `userAgent` is full-fidelity
because it's a security signal (UA mismatch is a session-takeover
heuristic). `metadata` is consumer-controlled and must follow the
consumer's privacy rules — foundation does not scrub it.

**ID generation.** `id` is a ulid (lexicographically sortable,
embeds timestamp). Foundation depends on the `ulid` npm package —
no in-house implementation, per the "Don't reinvent OSS" principle
([`01-scope-and-philosophy.md`](01-scope-and-philosophy.md#design-principles))
— and the audit event constructor calls it. Consumers cannot
supply their own id (prevents replay-style collisions).

## `RequestContext`

```typescript
export interface RequestContext {
  readonly requestId: string; // generated per request
  readonly startedAt: number; // epoch ms
  readonly tenantId?: TenantId;
  readonly principal?: Principal;
  readonly traceId?: string;
  readonly region?: string; // AWS region the request is being served from
  readonly residencyRegion?: string; // where this tenant's data lives, if different
  readonly clientIp?: string; // trusted-proxy resolved
}

export type Principal =
  | { kind: "user"; userSub: string; sessionId: string }
  | { kind: "service"; serviceName: string }
  | { kind: "anonymous" };
```

**Carried via AsyncLocalStorage.** Foundation's `request-context`
module owns the lifecycle: middleware constructs the context at
request entry, sets it on the ALS, and any code in the request
scope reads via `getRequestContext()`. The shape is frozen so deep
helpers (logger, audit-event-builder) can rely on its fields
existing.

**Construction order.** Tenant resolution runs _before_ the
`RequestContext` is constructed — the resolver may need to read
headers, hostname, or path, and may itself perform I/O. The
canonical request-entry sequence: (1) parse the request, (2) run
the `TenantResolver` to obtain a `TenantId`, (3) construct the
`RequestContext` with that value, (4) bind to ALS, (5) dispatch to
the handler. The per-package design in
[`foundation/05-tenant-context.md`](foundation/05-tenant-context.md)
expands on the resolver shape and the bundled resolver strategies.

**Optional fields are honest.** `tenantId` is optional because some
requests (sign-up, login, IdP-discovery probes) have no tenant
context yet. `principal` is optional because the request may be
anonymous. `region` and `residencyRegion` are optional because
single-region deployments don't need them.

**Extensibility via declaration merging.** Consumers extend
`RequestContext` with custom fields via TS declaration merging:

```typescript
// in consumer code
declare module "@de-otio/saas-foundation" {
  interface RequestContext {
    readonly featureFlags?: ReadonlySet<string>;
  }
}
```

The added field appears on all `RequestContext` reads in the
consumer's codebase. Foundation modules cannot read it (they don't
know the augmented shape), which is correct — foundation operates
on what foundation defines.

**Immutable, but replaceable during the early-request phase.** The
interface uses `readonly` on every field; the runtime object is
`Object.freeze`d before being set on the ALS. _Mutation_ of the
context mid-request is forbidden — the kind of bug that manifests
as a heisenbug.

_Replacement_ with a fresh frozen object via
`setRequestContext({...getRequestContext(), principal})` is
permitted, but only during the **early-request phase**, defined as:
after tenant resolution, after auth verification, and before the
route handler runs. Foundation's `request-context` module exposes
`setRequestContext` with a runtime guard that throws if called once
the handler dispatch has begun. The intended use is for middleware
to thread late-bound fields (`principal`, `traceId`, `clientIp`)
into the context as the chain populates them; not for handlers to
tweak context ad hoc. The per-module design in
[`foundation/07-logger-and-request-context.md`](foundation/07-logger-and-request-context.md)
specifies the guard mechanics.

## `SecretRef`

```typescript
export interface SecretRef {
  readonly arn: string; // Secrets Manager ARN
  readonly versionId?: string; // pinned version; absent = AWSCURRENT
}

export function secretRef(arn: string, versionId?: string): SecretRef;
export function isSecretRef(value: unknown): value is SecretRef;
```

**Why structured, not branded.** A secret reference has two distinct
fields (ARN and optional version pin). A flat branded string forces
parsing at every use site or loses the version information.

**ARN validation.** `secretRef(...)` validates the ARN matches
`arn:aws:secretsmanager:<region>:<account>:secret:<name>-<6char>`.
Malformed ARNs throw at construction, not at first network call.

**No `value` field.** A `SecretRef` never carries the plaintext
secret value. Resolution to plaintext is done by foundation's
secrets module via `resolveSecret(ref: SecretRef): Promise<string>`,
and the plaintext lives only on the call stack of the consumer of
that promise.

**Version pinning.** When a secret is rotated, vestibulum's
`IdpSecretsClient.store` returns a new `versionId`. The IdP manager
persists the SecretRef _with_ the version ID so subsequent reads
get the version the IdP was configured with. Pinning to `AWSCURRENT`
(omitting `versionId`) is the consumer's choice for fast rotation;
pinning a version is the choice for stability.

## `ClaimResolverInput` and `ProvisionerInput`

Defined in vestibulum, not foundation, because they are Cognito-trigger-
shaped. Reproduced in summary here; full definition in
[`vestibulum/01-package-api.md`](vestibulum/) (transplant of
vestibulum's existing `02-runtime-api.md`).

```typescript
export interface ClaimResolverInput {
  readonly userSub: string;
  readonly userAttributes: Readonly<Record<string, string>>;
  readonly clientId: string;
  readonly triggerSource: KnownClaimTriggerSource | (string & {});
  readonly identity:
    | { kind: "cognito" }
    | { kind: "federated"; providerName: string; providerType: "OIDC" | "SAML" };
  readonly federatedGroups: readonly string[];
  readonly isRefresh: boolean;
  /**
   * Caller-supplied metadata from `AdminRespondToAuthChallenge` /
   * `RespondToAuthChallenge`. **Untrusted:** Cognito passes this
   * through from the client without validation; do NOT use for
   * authorization decisions. Renamed from `clientMetadata` to make
   * the trust boundary visible at the type level.
   */
  readonly untrustedClientMetadata: Readonly<Record<string, string>>;
}

export interface ClaimResolverOutput {
  readonly claimsToAddOrOverride?: Readonly<
    Record<string, string | number | boolean | readonly string[]>
  >;
  readonly claimsToSuppress?: readonly string[];
  /** Replaces `cognito:groups` (and, where applicable, role claims). */
  readonly groupsToOverride?: readonly string[];
  /** Access-token scope additions. V2/V3 events only; silently ignored on V1. */
  readonly scopesToAdd?: readonly string[];
  /** Access-token scope suppressions. V2/V3 events only. */
  readonly scopesToSuppress?: readonly string[];
}

export interface ProvisionerInput {
  readonly userSub: string;
  readonly userAttributes: Readonly<Record<string, string>>;
  readonly clientId: string;
  readonly triggerSource: KnownProvisionerSource | (string & {});
  readonly identity:
    | { kind: "cognito" }
    | { kind: "federated"; providerName: string; providerType: "OIDC" | "SAML" };
}

type KnownClaimTriggerSource =
  | "TokenGeneration_Authentication"
  | "TokenGeneration_HostedAuth"
  | "TokenGeneration_NewPasswordChallenge"
  | "TokenGeneration_AuthenticateDevice"
  | "TokenGeneration_RefreshTokens";

type KnownProvisionerSource =
  | "PostConfirmation_ConfirmSignUp"
  | "PostConfirmation_ConfirmForgotPassword";
```

These are frozen because they are the contract between the
Cognito-trigger Lambda templates (in vestibulum-cdk, bundled at
publish time) and the consumer's callback code (in the consumer's
repo). Changing them silently means deployed Lambdas pass
incompatible inputs to consumer callbacks at runtime — a particularly
painful failure mode because it only manifests at the first
post-deploy login.

**Forward compatibility built in.** `triggerSource` is an open
string union so Cognito adding a new trigger source (or a future
SCIM provisioner path) doesn't force a breaking change. Consumers
match known values and treat unknown sources defensively.

## What is _not_ frozen

By contrast, these shapes can change PATCH-level without consumer
impact (or at most a MINOR bump within one package):

- Any module's internal types (parameter shapes, return shapes that
  are not in the frozen set).
- The AWS SDK input/output shapes — those come from `@aws-sdk/*`
  and follow AWS's own versioning.
- IdP manager method signatures (`upsert`, `delete`, `get`,
  `attachToAppClients`) — these are in vestibulum and change as the
  IdP feature set grows. New required parameters are still a
  breaking change (MINOR pre-1.0); new optional parameters are
  additive.
- Audit-event `metadata` keys — consumer-extensible by design.
- CDK construct prop shapes (vestibulum-cdk) — frequent churn; not
  cross-package.

## RFC process for frozen-set changes

Covered in
[`05-versioning-and-releases.md`](05-versioning-and-releases.md#rfc-process-for-frozen-types).
Recap: open `doc/rfc/NNNN-<slug>.md`, propose, accept, then a
follow-up PR carries the code change with changesets for every
affected package. CI fans-out the changeset requirement for any
diff under `packages/foundation/src/types/frozen/`.

The frozen-type source files live under
`packages/foundation/src/types/frozen/` (for foundation-owned ones)
and `packages/vestibulum/src/types/frozen/` (for vestibulum-owned
ones). The CI gate watches both paths.

## Boundary discipline

Three temptations that the frozen-set discipline blocks:

1. **"Just add one optional field, no one's using it yet."** Even
   optional fields land in TypeScript autocomplete and shape how
   consumers write code. An optional field today becomes "remove
   that, we never used it" pressure tomorrow, which is now breaking.
   Add via RFC.
2. **"Inline the type at the use site, copy-paste rather than
   import."** Defeats the whole point — two definitions diverge.
   ESLint's `no-restricted-syntax` could enforce, but the clearer
   defence is review.
3. **"Augment the persisted shape via metadata."** `AuditEvent.
metadata` is fine for consumer-specific _application_ data. It
   is **not** the place to backdoor a missing top-level field —
   that hides cross-tenant query patterns from the audit indexer
   and makes the type system blind to the field. If a field
   belongs at top level, RFC it in.

## Open questions

- **Should `RequestContext` carry the raw request headers?**
  Argument for: handlers occasionally want to read a custom header
  outside the request scope. Argument against: encourages
  request-context as a magic bag. Leaning: no — handlers that need
  headers should accept them as a parameter.
- **Branded `SessionId` as well?** Currently typed as `string`.
  Branding would catch user-id-vs-session-id swap bugs. Foundation
  agent's view: yes for `SessionId` (consumer-controlled, no
  external dependence); no for `UserSub` (AWS Cognito returns
  plain string and casting at every callsite is more friction than
  the bug class avoids). Pending: add `SessionId` brand alongside
  `TenantId` in `foundation/src/types/frozen/`.
