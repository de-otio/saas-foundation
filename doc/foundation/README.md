# `@de-otio/saas-foundation` — design

The runtime core. AWS-backed cloud-primitive shims, secrets, session
crypto, tenant context, audit log, structured logger, rate-limit,
region/residency, feature toggles, and trusted-proxy IP derivation.
Zero identity-provider opinions; consumed by `@de-otio/vestibulum` for
its identity layer and by application backends directly.

This sub-directory holds the per-module design notes. Cross-cutting
constraints — scope, layering, dependency rules, frozen types,
versioning — live one level up in the top-level docs. Read those first
([`../01-scope-and-philosophy.md`](../01-scope-and-philosophy.md),
[`../03-package-relationships.md`](../03-package-relationships.md),
[`../04-shared-vocabulary.md`](../04-shared-vocabulary.md)).

## What this package owns

| Concern                        | Module path            | Layer |
| ------------------------------ | ---------------------- | ----- |
| Structured logging             | `src/logger/`          | 1     |
| Request-scoped context (ALS)   | `src/request-context/` | 1     |
| DynamoDB-backed KV shim        | `src/kv/`              | 1     |
| SQS-backed queue shim          | `src/queue/`           | 1     |
| S3-backed object-store shim    | `src/storage/`         | 1     |
| Trusted-proxy IP derivation    | `src/net/`             | 1     |
| Tenant context + `TenantId`    | `src/tenant/`          | 2     |
| Session-cookie crypto          | `src/session/`         | 2     |
| Secrets loader (SSM / SM)      | `src/secrets/`         | 2     |
| Audit log (`AuditEvent`)       | `src/audit/`           | 3     |
| DynamoDB-backed token-bucket limiter | `src/rate-limit/`      | 3     |
| Region detection + residency   | `src/region/`          | 3     |
| Feature-toggle storage         | `src/feature-toggles/` | 3     |

Layers are enforced by ESLint per
[`../03-package-relationships.md` § Cycle prevention](../03-package-relationships.md#cycle-prevention).
Higher-layer modules may import lower-layer ones; the reverse fails CI.

## What this package does _not_ own

Spelled out in [`../01-scope-and-philosophy.md`](../01-scope-and-philosophy.md);
recap to save a click:

- HTTP routing / middleware framework (consumer picks; Hono recommended).
- Circuit-breaker / retry state machines (`cockatiel` used internally; not
  re-exposed).
- CSRF / security headers / CORS (`helmet` + framework middleware).
- OpenAPI generation (`zod-openapi` or `@hono/zod-openapi`).
- ID generation as a public API — foundation vendors a ULID generator
  internally (`src/audit/ulid.ts`) to mint audit-event ids but does not
  expose it or depend on the `ulid` npm package.
- Identity-provider logic (lives in `@de-otio/vestibulum`).

## Index

- [`01-package-api.md`](./01-package-api.md) — top-level exports,
  sub-path exports, `package.json` sketch.
- [`02-cloud-primitives.md`](./02-cloud-primitives.md) — `KVNamespace`
  / `Queue` / `R2Bucket` shims over DynamoDB / SQS / S3.
- [`03-secrets.md`](./03-secrets.md) — SSM and Secrets Manager
  loaders, plaintext lifecycle, caching strategy.
- [`04-session-crypto.md`](./04-session-crypto.md) — AES-GCM cookie
  encryption with opaque payload.
- [`05-tenant-context.md`](./05-tenant-context.md) — `TenantId`
  resolution + ALS carrier.
- [`06-audit-log.md`](./06-audit-log.md) — append-only event
  persistence, retention tiers, emission patterns (writer-only; the
  reader is not yet built).
- [`07-logger-and-request-context.md`](./07-logger-and-request-context.md)
  — pino-based structured logging with request-id correlation.
- [`08-rate-limit.md`](./08-rate-limit.md) — DynamoDB-backed token bucket.
- [`09-region-and-residency.md`](./09-region-and-residency.md) —
  region detection, residency-by-tenant routing.
- [`10-feature-toggles.md`](./10-feature-toggles.md) — DB-backed
  boolean toggle storage.
- [`11-ip-derivation.md`](./11-ip-derivation.md) — trusted-proxy
  client-IP resolution.

## Status

Implemented. The modules described here are built and tested in
`packages/foundation/`. The trellis-side extraction
([`../08-trellis-migration.md`](../08-trellis-migration.md)) remains
future work. These module docs are being reconciled with the landed
code; where they disagree, the code is authoritative.
