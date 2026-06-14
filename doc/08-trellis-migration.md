# 08 — Migrating trellis to consume saas-foundation

## Status

COMPLETE (as of 2026-05-30) — Streams 1–3 landed; see plans/trellis-migration/REMAINING.md for the per-phase ledger. Multi-tenancy follow-on work is tracked in doc/14-multi-tenancy/.

## Overview

The work plan for extracting generic infrastructure out of trellis
and into `@de-otio/saas-foundation`, retiring in-house
reimplementations of OSS-solved problems along the way, and leaving
trellis's domain code unchanged.

## TL;DR

Trellis's `apps/api/src/lib/` (~37 kLOC, 141 files) carries a complete
multi-tenant SaaS starter kit underneath the social-network code. The
[reusable-components review](../../trellis/analysis/generic-core/14-reusable-components-review.md)
sorted the candidate modules into three streams that can land in
parallel:

| Stream | Action                                  | Module count    | Outcome                       |
| ------ | --------------------------------------- | --------------- | ----------------------------- |
| 1      | Extract into `@de-otio/saas-foundation` | ~12 modules     | Foundation packages them      |
| 2      | Replace with OSS, in place              | 5 module groups | Trellis switches dependencies |
| 3      | Domain code consumes new imports        | rest of `lib/`  | Trellis depends on foundation |

Streams 1 and 2 are largely independent. Stream 3 happens
incrementally as 1 and 2 land. Trellis's only direct consumer is
Trellis (per `trellis/CLAUDE.md` and project memory), so each cutover
step has low blast radius and the consumer picks up the new dependency
graph in its own release cycle.

## Stream 1 — extract into foundation

Order chosen so each step's output is usable by the next. The first
several modules have zero or near-zero coupling to trellis types,
which is why they are extracted first.

### Phase 1.A — cloud shims (lowest-coupling, highest-reuse)

| Trellis source                           | Foundation destination             |
| ---------------------------------------- | ---------------------------------- |
| `apps/api/src/lib/kv/dynamodb-kv.ts`     | `packages/foundation/src/kv/`      |
| `apps/api/src/lib/queue/sqs-queue.ts`    | `packages/foundation/src/queue/`   |
| `apps/api/src/lib/storage/s3-storage.ts` | `packages/foundation/src/storage/` |

These are already Cloudflare-compat interfaces over AWS primitives;
no domain coupling. Move verbatim, add tests, ship as foundation v0.1.

### Phase 1.B — primitives the rest of foundation depends on

| Trellis source                        | Foundation destination                     |
| ------------------------------------- | ------------------------------------------ |
| `apps/api/src/lib/secrets/`           | `packages/foundation/src/secrets/`         |
| `apps/api/src/lib/secret-resolver.ts` | merged into above                          |
| `apps/api/src/lib/logger.ts`          | `packages/foundation/src/logger/`          |
| `apps/api/src/lib/request-context.ts` | `packages/foundation/src/request-context/` |
| `apps/api/src/lib/net/`               | `packages/foundation/src/net/`             |

Decoupling work in this phase:

- `logger.ts` currently uses `Logger.getInstance()` singleton. Foundation
  shape is constructor-injected. The trellis-side cutover replaces
  `Logger.getInstance()` calls with a `RequestContext`-bound logger
  resolved at the request scope.
- `request-context.ts` shape converges with the frozen `RequestContext`
  type in [`04-shared-vocabulary.md`](04-shared-vocabulary.md).
  Trellis's current `RequestContext` carries a `region: string` and
  a `config: RegionConfig` field; the frozen shape has `region?:
string` and `residencyRegion?: string` only. The `config` field
  does not graduate — trellis declaration-merges it back in via the
  extension pattern in
  [`04-shared-vocabulary.md`](04-shared-vocabulary.md#requestcontext)
  ("Extensibility via declaration merging").
- `secrets/` decouples from trellis's environment schema by accepting
  `SecretRef` values rather than well-known parameter names.

### Phase 1.C — multi-tenant and audit primitives

| Trellis source                                                | Foundation destination             |
| ------------------------------------------------------------- | ---------------------------------- |
| `apps/api/src/lib/tenant/`, `tenant-context.ts`               | `packages/foundation/src/tenant/`  |
| `apps/api/src/lib/audit/`, `audit-logger.ts`                  | `packages/foundation/src/audit/`   |
| `apps/api/src/lib/session-manager.ts` (encryption layer only) | `packages/foundation/src/session/` |

Decoupling work:

- `session-manager.ts` is currently 665 LOC of AES-GCM cookie crypto
  _and_ Cognito JWT validation. The split:
  - Encryption layer → foundation.
  - Cognito-claim validation → vestibulum.
  - The trellis-side handler composes both.
- `audit-logger.ts` drops the trellis-specific event-type enum;
  trellis declares its own action strings via the open-union
  `AuditAction` type ([`04-shared-vocabulary.md`](04-shared-vocabulary.md)).
- `tenant/` and `tenant-context.ts` converge on the frozen `TenantId`
  type. Trellis's IdP-name normalisation moves to vestibulum (it
  already has `idp-name.ts` in the runtime design).

### Phase 1.D — operational primitives

| Trellis source                                               | Foundation destination                     |
| ------------------------------------------------------------ | ------------------------------------------ |
| `apps/api/src/lib/rate-limit.ts`, `database-rate-limiter.ts` | `packages/foundation/src/rate-limit/`      |
| `apps/api/src/lib/region-detection.ts`, `region-config.ts`   | `packages/foundation/src/region/`          |
| `apps/api/src/lib/feature-toggle-service.ts`                 | `packages/foundation/src/feature-toggles/` |

Decoupling work:

- `rate-limit.ts` is generic in shape but currently composes
  domain-specific limits (per-route, per-user). Move the KV-backed
  token bucket; leave the domain configuration in trellis.
- `region-config.ts` strips the trellis feature-flag enum; consumers
  declare their own feature set.
- `feature-toggle-service.ts` extracts; `feature-flags.ts` (the
  trellis-specific feature _enum_) stays in trellis.

## Stream 2 — replace with OSS, in place

Five module groups identified in the
[review](../../trellis/analysis/generic-core/14-reusable-components-review.md)
as "Replace with OSS, don't extract." None of these graduate to
foundation. They are retired inside trellis with a direct dependency
swap. The "Don't reinvent OSS" principle
([`01-scope-and-philosophy.md`](01-scope-and-philosophy.md#design-principles))
formalises this.

### 2.1 — HTTP router → Hono

**Scope.** `router.ts`, `route-matcher.ts`, `route-helpers.ts`, the
regex-array `Route[]` pattern in every `apps/api/src/lib/routes/`
file. Roughly two dozen route files; the largest swap.

**Approach.** Both routers coexist during migration. A new top-level
`app.ts` instantiates a Hono app and a legacy-router fallback; routes
move from the legacy `Route[]` to Hono handlers one file at a time.
The legacy router is deleted only when every route has been ported.

**Why Hono and not Fastify / Express.** Hono is ESM-first (matches
foundation), has first-class Zod integration via `@hono/zod-openapi`
(folds in 2.4), and its middleware shape composes cleanly with
foundation's `RequestContext` AsyncLocalStorage.

**Estimate.** Weeks of work; schedule as a dedicated cycle, not woven
into other features.

### 2.2 — Circuit breakers → cockatiel

**Scope.** `circuit-breaker.ts` (~85 LOC), `database-circuit-breaker.ts`
(~220 LOC), ~3 call sites in trellis.

**Approach.** Direct call-site replacement. cockatiel's `Policy.wrap`
composition matches the existing usage pattern; mechanical port.

**Estimate.** A single afternoon.

### 2.3 — CSRF, security headers, CORS → helmet + framework CSRF

**Scope.** `csrf.ts` (~220 LOC), `security-headers.ts` (~100 LOC),
`cors-handler.ts` (~280 LOC).

**Approach.** Coupled to 2.1 (the Hono swap). Hono has middleware
for all three; the existing custom code retires when the Hono app
takes over the relevant route surface.

**Estimate.** Lands alongside the route-by-route Hono migration; no
separate cycle.

### 2.4 — OpenAPI generator → @hono/zod-openapi

**Scope.** `openapi/` directory.

**Approach.** Coupled to 2.1. `@hono/zod-openapi` generates the spec
from Zod schemas attached to Hono route definitions. The trellis Zod
schemas survive intact; the custom generator retires.

**Estimate.** Folds into the final route batch of 2.1.

### 2.5 — id-generator → ulid

**Scope.** `id-generator.ts` (~50 LOC).

**Approach.** One-line dependency swap. Trellis imports `ulid` from
the npm package; the local file is deleted.

**Estimate.** Single PR.

## Stream 3 — trellis-internal cleanup

Modules that **stay** in trellis but reorganise as Streams 1 and 2
land. For completeness, the residual list ("stays in trellis and
does _not_ reorganise") is enumerated in [§ Stream 4](#stream-4--residual-stays-in-trellis)
below — both lists together close out every file under
`apps/api/src/lib/`.

- **Domain handlers** (`post-handler.ts`, `comment-handler.ts`,
  etc.) — no change to logic; imports switch from local infrastructure
  modules to `@de-otio/saas-foundation`.
- **Auth handlers** (`auth-handler.ts`, `sso-auth-handler.ts`,
  `cognito/`, `mfa/`, `oauth/`) — JWT-verify imports switch from
  the local `cognito/` wrapper to `@de-otio/vestibulum`'s
  multi-pool verifier. The `cognito/` wrapper retires.
- **`database-connection-manager.ts`** (~660 LOC) — does not graduate
  to foundation. Per the review, "most of it would disappear if
  Prisma's built-in pool + a small region selector were adopted."
  Simplify in place; do not extract.
- **`validate-request.ts`** — folds into the Hono migration (Hono +
  Zod replace the custom wrapper).
- **`hook-dispatcher.ts`** — too small to extract (~80 LOC). Stays.
- **`feature-flags.ts`** — the trellis-specific enum. Uses
  `@de-otio/saas-foundation/feature-toggles` for storage; the enum
  itself stays.
- **`middleware/`** — domain-specific rate limits (e.g.,
  `comment-rate-limit.ts`) stay; they compose foundation's
  `rate-limit` primitive.
- **`exif-stripper.ts`, `ip-scrubber.ts`, `email-privacy.ts`** —
  trellis-specific privacy utilities; stay.
- **All domain-bound directories** — `activitypub/`, `compliance/`,
  `scheduled/`, `services/`, `queue-consumers/` — stay.

## Stream 4 — residual stays-in-trellis

Files under `apps/api/src/lib/` that Streams 1–3 leave unaddressed.
The disposition is "stays in trellis." Enumerated explicitly so
reviewers know they were considered, not forgotten.

### 4.1 — Generic-looking but trellis-coupled

| File                                               | Why it stays                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email-provider.ts`                                | Generic email-send abstraction (SES + Cloudflare-compat). **Stays for now.** Foundation does not ship an email primitive in v0.x — vestibulum-cdk uses SES directly for magic-link delivery; other transactional mail is the consumer's concern via `@aws-sdk/client-ses`. Revisit if a third backend re-types this. |
| `recaptcha.ts`                                     | reCAPTCHA token verification. Bot-defence integration. Trellis-shaped (assumes specific token providers, score thresholds, abuse signals). Not generic enough to graduate.                                                                                                                                           |
| `input-sanitizer.ts`                               | Generic-feeling but coupled to trellis's content-type rules. The OSS posture would be "use DOMPurify or sanitize-html"; the in-house file stays until that swap happens. Not a graduation candidate.                                                                                                                 |
| `threat-intel-service.ts`                          | Cloudflare-compat shape suggests reuse, but the feed sources and rules are trellis-specific. Stays.                                                                                                                                                                                                                  |
| `domain-reputation-service.ts`                     | Same — Cloudflare-compat shape, trellis-specific reputation rules. Stays.                                                                                                                                                                                                                                            |
| `redirect-resolver.ts`, `link-security-handler.ts` | URL-safety primitives. Cloudflare-compat-shaped but coupled to trellis's abuse model and bypass rules. Stays.                                                                                                                                                                                                        |
| `performance-metrics.ts`, `scaling-health.ts`      | Observability/health primitives. **Possible v0.x foundation graduates** (`foundation/health/`, `foundation/metrics/`) — every SaaS needs `/healthz` and CloudWatch publish helpers. Deferred to a follow-up review; for now, stay.                                                                                   |
| `security-monitor.ts`, `security-event-cleaner.ts` | Compose audit log + trellis security event taxonomies. Stay.                                                                                                                                                                                                                                                         |
| `metadata/` (image metadata)                       | Coupled to trellis's media subsystem. Stays.                                                                                                                                                                                                                                                                         |
| `crypto/voting/`                                   | Trellis-specific (voting-system primitives). Stays.                                                                                                                                                                                                                                                                  |

### 4.2 — Database adjuncts

All composed by `database-connection-manager.ts`; same disposition
(stays in trellis; simplify in place per the migration's [§ Stream 3](#stream-3--trellis-internal-cleanup)):

`database-config.ts`, `database-monitor.ts`, `database-wrapper.ts`,
`database-wrapper-helper.ts`, `db-query-helper.ts`, `data-router.ts`.

The "split into a tiny Prisma-region-selector that _does_ graduate"
question stays open ([§ Open questions](#open-questions)).

### 4.3 — Extension system

The trellis extension API:

`extension-context.ts`, `extension-route-wrapper.ts`,
`extension-validator.ts`.

The extension system is a trellis product, separate from
foundation's scope. Trellis already publishes
[`packages/extension-api/`](../../trellis/packages/extension-api/) as
a sibling package; the `lib/extension-*.ts` files compose that
package into the trellis API runtime. Stays.

### 4.4 — Session adjuncts beyond the AES-GCM split

| File                      | Why it stays                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `auth-context-manager.ts` | Trellis-specific auth-context shape; composes the foundation session primitive in v0.1. |
| `session-awareness.ts`    | Trellis-specific.                                                                       |
| `session-config.ts`       | Trellis-specific feature flags around session behaviour.                                |

### 4.5 — Trellis brand and internal docs

`terminology.ts`, `theme.ts`, `version.ts`,
`internal-docs-handler.ts`, `internal-docs-dashboard.json`,
`internal-docs-navigation.ts`, `internal-docs-navigation.json`.

Trellis-specific by definition. Stays.

### 4.6 — trellis-platform CDK constructs

The trellis-platform infra directory contained three generic constructs
(`NodejsLambda`, `QueueWithDlq`, `SingleTable`) and three dashboard
JSONs (`api-health`, `database`, `workers`). These **do graduate** —
but to `@de-otio/saas-foundation-cdk`, not to the trellis runtime
packages. The migration is out of scope for this plan (the constructs
live in the trellis-platform infra directory, not in trellis at all).

See [`09-foundation-cdk-package.md`](09-foundation-cdk-package.md)
for the foundation-cdk package position and
[`foundation-cdk/`](foundation-cdk/) for the per-construct designs.

The trellis-platform cutover (one PR per construct) happens after
foundation-cdk ships its first construct, on the consumer's own release
cycle.

## Per-stream ordering and parallelism

```
Stream 1:  1.A ──► 1.B ──► 1.C ──► 1.D
            ▲      ▲      ▲      ▲
            │      │      │      │
            └──── trellis cutover after each phase ────┘

Stream 2:  2.5 (ulid) ─── independent ─── ship anytime
           2.2 (cockatiel) ─── independent ─── ship anytime
           2.1 (Hono) ─── 2.3 (helmet/CSRF) ─── 2.4 (openapi)
                       ^                     ^
                       │   coupled — same migration cycle   │

Stream 3:  rolls with whichever foundation phase lands

Stream 4:  no migration work — these files stay where they are.
           4.6 (trellis-platform CDK constructs) graduates to foundation-cdk
           on the consumer's release cycle, post-foundation-cdk@0.1.0.
```

Stream 1.A unblocks Stream 1.B (logger depends on nothing; secrets
depend on logger for diagnostics; the rest depend on both). Streams
1.B and 1.C are sequential; 1.D can interleave with 1.C.

Stream 2 has two coupling sets: 2.1+2.3+2.4 ship together; 2.2 and
2.5 are independent and can ship anytime, even before foundation has
a single module.

## Cutover safety

Each migration step is one trellis PR with a tight scope:

1. Bump `@de-otio/saas-foundation` (and / or `@de-otio/vestibulum`)
   version in `apps/api/package.json`.
2. Replace one module's imports.
3. Delete the local copy of that module.
4. Run the full trellis test suite (`npm test`).
5. Open PR; review focuses on the import surface and any frozen-set
   type alignments.
6. Merge to main.
7. The downstream consumer picks up the bump in its next dep refresh
   (per the trellis release checklist).

The trellis CLAUDE.md release-checklist convention covers downstream
coordination: `package-lock.json` updated, version constraints aligned,
no breaking-change surface introduced without prior heads-up.

## Risks

- **Foundation API churn during extraction.** Foundation is pre-1.0
  ([`05-versioning-and-releases.md`](05-versioning-and-releases.md));
  module shapes will change as we discover the right interfaces.
  Each foundation bump may force trellis edits. The blast radius is
  contained — trellis is the only direct consumer — so this is a
  reviewer-time cost, not a coordination crisis.
- **Hono migration is invasive.** Stream 2.1 touches every route
  handler. Will produce a large, mostly-mechanical diff. Schedule
  a dedicated cycle; resist mixing with feature work.
- **Some "extract" modules may turn out to be more trellis-coupled
  than the review thought.** If a module's decoupling pass reveals
  hidden trellis assumptions, leave it in trellis and revise the
  plan. The review is a starting point, not a contract.
- **Frozen-type fanout discipline kicks in immediately.** The first
  trellis cutover that depends on a foundation frozen type
  (`TenantId`, `AuditEvent`, etc.) commits trellis to the RFC
  process for any future change to that type
  ([`05-versioning-and-releases.md`](05-versioning-and-releases.md#rfc-process-for-frozen-types)).
  Accept this knowingly.
- **Hono adoption locks in the Hono ecosystem.** If we later want
  Fastify or a custom router again, the route handlers all need to
  port. Worth the cost given Hono's ergonomics and ESM-first
  posture, but flagged.

## Deferred / explicitly not in this plan

- **Consumer-side equivalent migration.** The downstream consumer
  of trellis does not depend on foundation directly. Once trellis-side
  cutover is complete, the consumer inherits the foundation dependency
  transitively. No separate migration plan today.
- **Foundation 1.0.** Path to 1.0 is gated on this migration
  completing and at least one consumer release cycle exercising the
  full dependency graph.
- **vestibulum-cdk adoption in trellis.** Trellis is deployed by its
  consumer; the consumer owns the AWS environment. CDK adoption
  is the consumer's call, not trellis's. Out of scope for this plan.
- **Performance regression hunt.** Foundation's primitives will
  have different perf characteristics from trellis's hand-rolled
  versions in places. Validate per-module during cutover (e.g.,
  session-cookie crypto cold-start, audit-log write latency).

## Deploy prerequisites introduced by the cutover

These are infrastructure changes the deploying environment must make
before the corresponding cutover goes live. None are provisioned by the
migration itself (AWS write operations are out of scope for the code
changes); each is wired in code + env and left as a documented
prerequisite.

- **1.B.4 — secret ARNs (Secrets Manager / SSM).** For ARN-mode
  environments, provision `SESSION_SECRET`, `SESSION_SECRET_FALLBACK`,
  and `OPENAI_API_KEY` in Secrets Manager (or SSM SecureString) and set
  the corresponding `*_ARN` env vars, plus per-ARN task-role IAM
  (`secretsmanager:GetSecretValue` / `ssm:GetParameter` + KMS decrypt).
  Boot-time resolution fails closed if the session secret is absent.
- **1.D — rate-limit DynamoDB table.** For environments that set
  `RATE_LIMIT_TABLE`, provision a DynamoDB table with a string `PK`
  partition key and a numeric `ttl` attribute registered for TTL
  expiry, plus task-role IAM for `dynamodb:GetItem` / `UpdateItem` /
  `DeleteItem` on that table. Optionally set `RATE_LIMIT_NAMESPACE`
  (defaults to `ratelimit`). When `RATE_LIMIT_TABLE` is unset the
  limiter falls back to an in-memory bucket (dev/test only — not
  cross-process safe). Semantics are token-bucket (burst up to
  capacity, smooth refill), not fixed-window.

## Open questions (resolved)

- **First trellis cutover bump version.** Resolved: cutover happened
  at 0.2.x. The shim validation at 0.1.0 occurred, and the bulk of
  the migration landed with 0.2.0 (secrets + logger + tenant + audit).
- **Test-suite parallelism.** Resolved: foundation tests are lighter
  than trellis tests; no special constraint was needed.
- **Should `database-connection-manager.ts` be split into a tiny
  Prisma-region-selector module that _does_ graduate?** Resolved:
  `database-connection-manager.ts` was investigated and intentionally
  left intact in trellis. The coupling to Prisma's internal pool
  management made a clean split impractical at this time.
