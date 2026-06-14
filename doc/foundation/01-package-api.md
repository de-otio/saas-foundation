# 01 — Package API

The `@de-otio/saas-foundation` exports surface. Top-level barrel,
sub-path exports, what each module ships, and the `package.json` shape
that wires it all together.

## Export strategy

Two import shapes, both supported on day one:

```typescript
// 1. Top-level barrel (re-exports the curated surface)
import { tenantId, resolveSecret, getLogger } from "@de-otio/saas-foundation";

// 2. Sub-path exports (consumer takes one slice)
import { DynamoKv } from "@de-otio/saas-foundation/kv";
import { SqsQueue } from "@de-otio/saas-foundation/queue";
import { S3Storage } from "@de-otio/saas-foundation/storage";
```

The barrel re-exports the "you'd want this most of the time" subset.
The sub-paths exist so a consumer that only wants `kv` does not pay
the type-check cost of pulling in `audit`, `session`, etc.

The barrel is hand-curated — not `export * from ...` — so an internal
symbol cannot accidentally graduate to public API by being added to a
module's `index.ts`.

## Top-level exports (the barrel)

The block below is the curated top-level barrel as it ships in
`packages/foundation/src/index.ts`. It is hand-curated (no
`export *`) and is the source of truth — this listing is regenerated
from that file.

Two things to note up front:

- **The `session` module is not re-exported from the top-level barrel.**
  Session crypto is available via the `@de-otio/saas-foundation/session`
  sub-path only.
- **Test-only / Prisma-only symbols** (`MemoryTokenBucketLimiter`,
  `MemoryFeatureToggleStore` for the toggle case, `PostgresAuditStore`,
  `PrismaFeatureToggleStore`) are not in the barrel — see the sub-path
  table and § Prisma sub-paths.

```typescript
// packages/foundation/src/index.ts

// Frozen vocabulary — TenantId
export type { TenantId, TenantIdConstraints } from "./types/frozen/tenant.js";
export {
  TENANT_ID_CONSTRAINTS,
  TenantIdValidationError,
  tenantId,
  isTenantId,
} from "./types/frozen/tenant.js";

// Frozen vocabulary — AuditEvent and its sub-shapes
export type {
  AuditEvent,
  AuditActor,
  AuditAction,
  AuditResource,
  AuditSeverity,
  AuditOutcome,
  JsonValue,
  JsonObject,
  JsonArray,
  JsonPrimitive,
} from "./types/frozen/audit.js";

// Frozen vocabulary — RequestContext, SecretRef
export type { RequestContext, Principal } from "./types/frozen/request-context.js";
export type { SecretRef } from "./types/frozen/secrets.js";
export { SecretRefValidationError, secretRef, isSecretRef } from "./types/frozen/secrets.js";

// Zod schemas for the frozen types
export {
  TenantIdSchema,
  SecretRefSchema,
  AuditEventSchema,
  AuditActorSchema,
  AuditActionSchema,
  AuditResourceSchema,
  AuditSeveritySchema,
  AuditOutcomeSchema,
  JsonValueSchema,
  PrincipalSchema,
  RequestContextSchema,
} from "./types/frozen/schemas.js";

// Logger
export type { Logger, LogLevel } from "./logger/index.js";
export {
  LOG_LEVELS,
  LOG_LEVEL_SEVERITY,
  isLogLevel,
  compareLogLevelSeverity,
  configureRootLogger,
  getLogger,
  createLogger,
  DEFAULT_REDACT_PATHS,
  DEFAULT_REDACT_CONFIG,
  LoggerConfigError,
} from "./logger/index.js";

// Request context (lifecycle functions + errors)
export type { CreateRequestContextInput } from "./request-context/index.js";
export {
  createRequestContext,
  runWithRequestContext,
  getRequestContext,
  setRequestContext,
  RequestContextPhaseError,
  RequestContextValidationError,
} from "./request-context/index.js";

// Net (IP derivation + anonymization + RFC6890)
export type {
  TrustedProxyMode,
  TrustedClientIpConfig,
  IpAnonymizationLevel,
  IpAnonymizerOptions,
  ReservedBlock,
} from "./net/index.js";
export {
  trustedClientIp,
  isIpShape,
  isReservedIp,
  IpAnonymizer,
  anonymizeIpPartial,
  RFC6890_IPV4_RESERVED,
  RFC6890_IPV6_RESERVED,
  RFC6890_ALL_RESERVED,
  InvalidIpError,
  TrustedProxyError,
} from "./net/index.js";

// Tenant resolution + ALS carrier + errors
export type {
  TenantResolver,
  TenantResolverInput,
  SubdomainTenantResolverOptions,
  CustomDomainTenantResolverOptions,
  TenantResolverTrustClass,
} from "./tenant/index.js";
export {
  resolveTenant,
  SubdomainTenantResolver,
  CustomDomainTenantResolver,
  CompositeTenantResolver,
  runWithTenantContext,
  getCurrentTenantId,
  TenantResolverError,
  TenantNotFoundError,
  TenantAuthorizationError,
} from "./tenant/index.js";

// Rate-limit (MemoryTokenBucketLimiter is sub-path-only, @beta-test-only)
export type { RateLimitResult, TokenBucketConfig } from "./rate-limit/index.js";
export { DynamoTokenBucketLimiter } from "./rate-limit/index.js";

// Region
export type { Region, RegionResolution } from "./region/index.js";
export { detectRegion, getResidencyRegionForTenant } from "./region/index.js";

// Feature toggles (PrismaFeatureToggleStore is sub-path-only — see § Prisma sub-paths)
export type { FeatureToggle, FeatureToggleStore } from "./feature-toggles/index.js";
export { MemoryFeatureToggleStore } from "./feature-toggles/index.js";

// Audit (PostgresAuditStore is sub-path-only — see § Prisma sub-paths)
export type {
  AuditLogOptions,
  AuditStore,
  DynamoAuditStoreOptions,
  MultiAuditStoreMode,
  MultiAuditStoreOptions,
  PiiFilterOptions,
  PiiFilterStrategy,
  EmitInput,
} from "./audit/index.js";
export {
  AuditLog,
  DynamoAuditStore,
  MultiAuditStore,
  PiiFilter,
  DEFAULT_PII_KEYS,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_METADATA_MAX_BYTES,
  retentionDaysFor,
  retentionSecondsFor,
  ttlFor,
  AuditWriteError,
  AuditEventValidationError,
  AuditStoreError,
} from "./audit/index.js";
```

> The frozen-vocabulary types/values are exported from the top-level
> barrel _and_ from the dedicated `@de-otio/saas-foundation/types/frozen`
> sub-path (see the sub-path table). The barrel also pulls in many of
> the same symbols that the per-module barrels expose; the sub-paths
> mostly mirror the barrel scoped to one module, but they are not always
> a strict subset (e.g. `secrets` and `region` expose client factories
> and additional schemas not surfaced at the top level).

Note that `secretRef` / `isSecretRef` are barrel exports, but
`SecretCache` is **not** — it is reachable only from the
`@de-otio/saas-foundation/secrets` sub-path.

## Sub-path exports

| Sub-path                                          | Module                | Notes                                             |
| ------------------------------------------------- | --------------------- | ------------------------------------------------- |
| `@de-otio/saas-foundation/kv`                     | DynamoDB KV shim      | Cloudflare `KVNamespace` interface                |
| `@de-otio/saas-foundation/queue`                  | SQS queue shim        | Cloudflare `Queue` interface                      |
| `@de-otio/saas-foundation/storage`                | S3 storage shim       | Cloudflare `R2Bucket` interface                   |
| `@de-otio/saas-foundation/secrets`                | SSM / Secrets Manager | `SecretRef` + `resolveSecret`                     |
| `@de-otio/saas-foundation/session`                | AES-GCM cookie crypto | Opaque payload                                    |
| `@de-otio/saas-foundation/tenant`                 | Tenant resolution     | `TenantId` brand + resolver                       |
| `@de-otio/saas-foundation/audit`                  | Audit log writer      | `AuditLog` writer (writer-only; no reader shipped) |
| `@de-otio/saas-foundation/audit/prisma`           | Prisma audit store    | `PostgresAuditStore`. Optional Prisma peer.       |
| `@de-otio/saas-foundation/logger`                 | pino-backed logger    | ALS-bound child loggers                           |
| `@de-otio/saas-foundation/request-context`        | ALS carrier           | `RequestContext` lifecycle                        |
| `@de-otio/saas-foundation/rate-limit`             | Token bucket          | DynamoDB-backed (`DynamoTokenBucketLimiter`)      |
| `@de-otio/saas-foundation/region`                 | Detection + residency | `RegionDetector` / `RegionRegistry` / residency   |
| `@de-otio/saas-foundation/feature-toggles`        | Toggle storage        | `FeatureToggleStore` interface + in-memory store  |
| `@de-otio/saas-foundation/feature-toggles/prisma` | Prisma toggle store   | `PrismaFeatureToggleStore`. Optional Prisma peer. |
| `@de-otio/saas-foundation/net`                    | IP derivation         | `trustedClientIp`                                 |
| `@de-otio/saas-foundation/types/frozen`           | Frozen vocabulary     | Frozen types + factories + schemas (Layer-0)      |

## `package.json` sketch

```jsonc
{
  "name": "@de-otio/saas-foundation",
  "version": "0.2.0",
  "type": "module",
  "description": "Runtime core for de-otio multi-tenant SaaS backends",
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/de-otio/saas-foundation",
    "directory": "packages/foundation",
  },
  "engines": { "node": ">=24.0.0" },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./kv": { "import": "./dist/kv/index.js", "types": "./dist/kv/index.d.ts" },
    "./queue": { "import": "./dist/queue/index.js", "types": "./dist/queue/index.d.ts" },
    "./storage": { "import": "./dist/storage/index.js", "types": "./dist/storage/index.d.ts" },
    "./secrets": { "import": "./dist/secrets/index.js", "types": "./dist/secrets/index.d.ts" },
    "./session": { "import": "./dist/session/index.js", "types": "./dist/session/index.d.ts" },
    "./tenant": { "import": "./dist/tenant/index.js", "types": "./dist/tenant/index.d.ts" },
    "./audit": { "import": "./dist/audit/index.js", "types": "./dist/audit/index.d.ts" },
    "./audit/prisma": { "import": "./dist/audit/prisma.js", "types": "./dist/audit/prisma.d.ts" },
    "./logger": { "import": "./dist/logger/index.js", "types": "./dist/logger/index.d.ts" },
    "./request-context": {
      "import": "./dist/request-context/index.js",
      "types": "./dist/request-context/index.d.ts",
    },
    "./rate-limit": {
      "import": "./dist/rate-limit/index.js",
      "types": "./dist/rate-limit/index.d.ts",
    },
    "./region": { "import": "./dist/region/index.js", "types": "./dist/region/index.d.ts" },
    "./feature-toggles": {
      "import": "./dist/feature-toggles/index.js",
      "types": "./dist/feature-toggles/index.d.ts",
    },
    "./feature-toggles/prisma": {
      "import": "./dist/feature-toggles/prisma.js",
      "types": "./dist/feature-toggles/prisma.d.ts",
    },
    "./net": { "import": "./dist/net/index.js", "types": "./dist/net/index.d.ts" },
    "./types/frozen": {
      "import": "./dist/types/frozen/index.js",
      "types": "./dist/types/frozen/index.d.ts",
    },
  },
  "files": ["dist", "README.md", "CHANGELOG.md"],
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "lint": "eslint src test",
  },
  "dependencies": {
    "@aws-sdk/client-dynamodb": "^3.700.0",
    "@aws-sdk/util-dynamodb": "^3.700.0",
    "@aws-sdk/client-s3": "^3.700.0",
    "@aws-sdk/s3-request-presigner": "^3.700.0",
    "@aws-sdk/client-sqs": "^3.700.0",
    "@aws-sdk/client-ssm": "^3.700.0",
    "@aws-sdk/client-secrets-manager": "^3.700.0",
    "cockatiel": "^3.2.0",
    "cookie": "^1.0.0",
    "pino": "^9.14.0",
    "zod": "^3.23.0",
  },
  "peerDependencies": {
    "@prisma/client": ">=5.0.0",
  },
  "peerDependenciesMeta": {
    "@prisma/client": { "optional": true },
  },
  "publishConfig": { "access": "public" },
}
```

Notes:

- `pino` is a hard dep, not a peer — see
  [`./07-logger-and-request-context.md`](./07-logger-and-request-context.md).
- `cockatiel` is a hard dep but **not** re-exported. Consumers wanting
  retry/circuit-breaker policy depend on cockatiel themselves; foundation
  uses it internally for DynamoDB transient-failure handling and the like.
- `cookie` is a hard dep, used by the session-cookie serializer.
- **ULID generation is vendored**, not an npm dependency. Foundation
  ships its own implementation at `src/audit/ulid.ts` and does not
  depend on the `ulid` package.
- `@prisma/client` is an **optional** peer because the Postgres audit
  store and the Prisma-backed feature-toggle store use Prisma. The
  optional-peer pattern only works if no top-level `import` of
  `@prisma/client` runs at module load — see § Prisma sub-paths below.
- AWS SDKs are hard deps. Marking them as peers (à la trellis 0.7's
  promote-AWS-SDKs-to-runtime-deps decision) loses dedup wins on a
  CDK consumer's `node_modules` tree but is the only way to guarantee
  consumer-controlled version pinning. The trellis 0.7.1 release notes
  pinned this as the wrong call; we ship hard deps.
- No `aws-cdk-lib` or `constructs` here — enforced by ESLint
  per [`../02-monorepo-layout.md`](../02-monorepo-layout.md).
- No identity-provider SDKs (`@aws-sdk/client-cognito-identity-provider`,
  `aws-jwt-verify`) — those belong in the vestibulum runtime.

## Module index → doc map

Each `src/<module>/` folder has its design note in this directory:

| Module                 | Design doc                                                                 |
| ---------------------- | -------------------------------------------------------------------------- |
| `src/kv/`              | [`./02-cloud-primitives.md`](./02-cloud-primitives.md)                     |
| `src/queue/`           | [`./02-cloud-primitives.md`](./02-cloud-primitives.md)                     |
| `src/storage/`         | [`./02-cloud-primitives.md`](./02-cloud-primitives.md)                     |
| `src/secrets/`         | [`./03-secrets.md`](./03-secrets.md)                                       |
| `src/session/`         | [`./04-session-crypto.md`](./04-session-crypto.md)                         |
| `src/tenant/`          | [`./05-tenant-context.md`](./05-tenant-context.md)                         |
| `src/audit/`           | [`./06-audit-log.md`](./06-audit-log.md)                                   |
| `src/logger/`          | [`./07-logger-and-request-context.md`](./07-logger-and-request-context.md) |
| `src/request-context/` | [`./07-logger-and-request-context.md`](./07-logger-and-request-context.md) |
| `src/rate-limit/`      | [`./08-rate-limit.md`](./08-rate-limit.md)                                 |
| `src/region/`          | [`./09-region-and-residency.md`](./09-region-and-residency.md)             |
| `src/feature-toggles/` | [`./10-feature-toggles.md`](./10-feature-toggles.md)                       |
| `src/net/`             | [`./11-ip-derivation.md`](./11-ip-derivation.md)                           |

## Prisma sub-paths

`PostgresAuditStore` and `PrismaFeatureToggleStore` ship behind
dedicated sub-path exports (`@de-otio/saas-foundation/audit/prisma`,
`@de-otio/saas-foundation/feature-toggles/prisma`) and are **not**
re-exported from the top-level barrel or from the
`./audit` / `./feature-toggles` module barrels. The reason is the
optional-peer-dep mechanics: any module on the import graph reachable
from a barrel that contains `import { PrismaClient } from '@prisma/client'`
at the top level causes `MODULE_NOT_FOUND` at process boot for
consumers who did not install Prisma. The sub-path quarantine keeps
the optional peer optional in practice, not just in `package.json`.

```typescript
// Consumer who uses Prisma:
import { PrismaFeatureToggleStore } from "@de-otio/saas-foundation/feature-toggles/prisma";
import { PostgresAuditStore } from "@de-otio/saas-foundation/audit/prisma";

// Consumer who does NOT use Prisma:
// Imports nothing from /audit/prisma or /feature-toggles/prisma.
// The barrel, /audit, and /feature-toggles all resolve without Prisma installed.
```

The internal shape: the `src/audit/prisma.ts` file is the _only_ file
in `src/audit/` allowed to do `import { PrismaClient } from '@prisma/client'`
at the top level. Same for `src/feature-toggles/prisma.ts`. A
consumer-driven dynamic-import path (`const { PrismaClient } = await
import('@prisma/client')`) is acceptable anywhere because it defers
the resolution to first call.

**CI rule.** ESLint forbids top-level `from '@prisma/client'` in any
file under `src/audit/` or `src/feature-toggles/` _except_ the
`prisma.ts` files at the root of those directories. A separate rule
forbids re-exporting `PostgresAuditStore` or `PrismaFeatureToggleStore`
from `src/audit/index.ts` or `src/feature-toggles/index.ts` or the
top-level `src/index.ts`. Both are mechanical lint rules with no
exceptions.

## Conventions

A few discipline rules that apply to every module:

- **Each module ships an `index.ts` barrel.** Cross-module imports go
  through the barrel, not deep paths. Deep paths are an internal
  implementation detail.
- **No singletons.** Every class is constructor-injected. The package
  has no `getInstance()` style; if you find one in extracted code,
  it's a decoupling step, not a port.
- **Constructors take their AWS SDK client as a parameter.** No
  module-scoped `new DynamoDBClient(...)` at the top of a file — that
  pattern survives the migration only as a `createDefaultXClient()`
  factory that the _consumer_ calls and passes in. Reason: tests need
  to inject `aws-sdk-client-mock`, and the consumer needs to choose
  the region / credentials chain / endpoint override at startup, not
  at module load.
- **Zod schemas live next to the types they validate**, in a
  `schemas.ts` file inside the module. Re-exported from the module's
  barrel only when the schema is part of the public API (e.g.,
  `AuditEventSchema`).
- **Error types are named, not bare strings.** Each module exports
  its own subclass of `Error` (`SecretsNotFoundError`,
  `AuditWriteError`, etc.) with a discriminant `name` field so call
  sites can `if (err instanceof SecretsNotFoundError)`.
- **`readonly` is the default.** Every public interface field carries
  `readonly`; every public `Record<>` is `Readonly<Record<>>`; every
  public array is `ReadonlyArray<>`. Internal types (not exported
  from the module barrel) may omit `readonly` where mutation is the
  module's natural shape. Frozen-set discipline lives in
  [`../04-shared-vocabulary.md § Immutability convention`](../04-shared-vocabulary.md#immutability-convention);
  the same convention extends to every module-public type.
- **Pure functions outside the explicit impure boundaries.** Module
  logic is pure unless it does one of: AWS SDK call, ALS read/write,
  crypto random read, network I/O, filesystem I/O, time-source read.
  Impure functions are isolated and named accordingly (e.g.,
  `resolveSecret` clearly does I/O); pure helpers stay pure. A
  reviewer should not have to ask "does this function mutate
  anything?" — the answer is encoded in the module's structure. See
  [`../10-ai-maintained-conventions.md § Pure functions where the domain allows it`](../10-ai-maintained-conventions.md#2-pure-functions-where-the-domain-allows-it).

## Open questions

- **Sub-path types via `typesVersions` vs `exports`-only?** Modern
  TypeScript respects the `exports` map's `types` condition. Older
  consumers on `moduleResolution: 'node'` (CJS-era) won't resolve
  sub-path types correctly. Decision: `exports`-only. Consumers stuck
  on `node` resolution use the barrel, which is in the standard
  resolution path.
- **Expose the vendored ULID generator?** Foundation vendors its own
  ULID implementation (`src/audit/ulid.ts`) rather than depending on
  the `ulid` package; it is used internally to mint audit-event ids and
  is not part of the public surface. Re-exporting it would promote
  "foundation owns ID generation" when it just _uses_ ULIDs internally.
  Consumers that want ULIDs depend on a generator themselves. Same
  posture for `zod` and `cockatiel`.
- **A `@de-otio/saas-foundation/test-utils` sub-path?** For shared
  test factories (`fakeAuditEvent()`, `freezeClock(ms)`,
  `inMemoryKv()`). Not v0.1 — let the use case surface from a real
  consumer test suite first.
