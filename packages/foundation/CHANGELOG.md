# @de-otio/saas-foundation

## 0.4.0

### Minor Changes

- 7d22707: Add the `KvStore` typed atomic-primitive port + adapters (WS-1 KV port)

  A sibling to the Cloudflare-compat `KVNamespace`, `KvStore` adds the atomic
  primitives the raw-DynamoDB call sites need: `get` (TTL-aware, optionally
  strongly-consistent or `includeExpired`), `put`, `putIfAbsent`
  (expired-as-absent), `putIfFresher` (TTL-monotonic freshness), `compareAndSet`,
  `increment` (server-side add, field-identifier validated), version-guarded
  `delete`, and `queryByIndex`. All additive/non-breaking.

  Adapters: `MemoryKvStore` (tests), `DynamoKvStore` (AWS reference, byte-compat
  layout-parameterized, `allowSeparatorInKey` for composite keys), and — behind
  the new `@de-otio/saas-foundation/kv/postgres` sub-path so no `pg`/SQL surface
  leaks into the core `kv` barrel — `PostgresKvStore` + `SqlExecutor` +
  `sweepExpiredKvEntries`. Also adds `PostgresTokenBucketLimiter` to the
  `rate-limit` module (raw-SQL sibling of the Dynamo limiter, bounded-retry
  fail-open, F5). A shared adapter-contract suite proves all three adapters
  behaviourally identical, incl. real-concurrency lanes on DynamoDB/Postgres.

  Coordinated with the `@de-otio/vestibulum` minor bump in the same release
  window (single-owner publish, EXECUTION-COORDINATION X3).

- f71df2b: Add the `IdentityProviderPort` + Keycloak adapter (WS-3.3 identity module)

  New `@de-otio/saas-foundation/identity` sub-path: a deliberately minimal,
  provider-neutral identity port — `initiateMagicLink(email, opts)` (per-email
  rate limiting stays with the API caller) and `deleteUser({ email })`
  (absorbing the WS-2 provisional `IdentityAdminPort`, X6) — plus
  `KeycloakIdentityProvider`, implementing the phasetwo magic-link REST contract
  the G2 spike proved live (service-account client_credentials token,
  `send_email=false` — the app owns the sign-in email, `reusable=false`) and
  admin ops (get/delete user; sub-preserving `createUser` via `partialImport`
  with a fail-not-overwrite collision pre-flight — G2 E-1: `POST /users`
  regenerates caller ids). Fail-closed on missing config; injectable
  fetch/clock. Additive/non-breaking.

  Part of the same coordinated release window as the WS-1/WS-3.1 minors
  (single-owner publish, EXECUTION-COORDINATION X3).

## 0.3.2

### Patch Changes

- 248d057: Adapt session crypto to `@types/node` 25's WebCrypto types. Its namespaced
  `webcrypto.CryptoKey` is no longer the global `CryptoKey`, and the SubtleCrypto
  data parameters are typed as `BufferSource` (to which a
  `Uint8Array<ArrayBufferLike>` / `Buffer` is not assignable). The session key
  types are now `webcrypto.CryptoKey` and the seal/unseal paths pass fresh
  ArrayBuffer-backed `Uint8Array` copies into `encrypt`/`decrypt`. Internal
  type/encoding adjustment only — no API or runtime-behaviour change.

## 0.3.1

### Patch Changes

- f759445: Correct the Prisma sub-path header comments: the `audit/prisma.ts` and
  `feature-toggles/prisma.ts` stores reference `@prisma/client` only through their
  structural client interfaces, not a top-level value-import (Prisma 7's bare
  package exports nothing without a generated client). Comment-only change.

## 0.3.0

### Minor Changes

- 9a4e9fd: Upgrade major dependency versions.
  - **zod 3 → 4** (`@de-otio/saas-foundation`, `@de-otio/vestibulum`). Foundation
    re-exports zod schemas as public API, so this is a breaking change to the
    published type surface: consumers must also be on zod 4. The `z.ZodType<T, Def, In>`
    three-argument form is replaced by `z.ZodType<T, In>` (the `ZodTypeDef` type
    parameter was removed in zod 4). Runtime schema behaviour is unchanged.
  - **cockatiel 3 → 4** (`@de-otio/saas-foundation`, internal). The `handleWhen`
    predicate now receives `unknown` rather than `Error`; the internal retry
    predicate was widened accordingly. No public API change.
  - **TypeScript 5 → 6** (build toolchain). Node built-in module specifiers and
    `@types/node` are now declared explicitly for the CDK packages.
  - **@prisma/client dev pin 5 → 7** (`@de-otio/saas-foundation` build only). The
    `@prisma/client` peer-dependency range stays `>=5.0.0`; the Prisma-backed
    adapters operate on a consumer-supplied client via structural interfaces, so
    consumers on Prisma 5, 6, or 7 are all supported.

## 0.2.5

### Patch Changes

- 86c1864: Export the pure token-bucket algorithm from the `/rate-limit` barrel:
  `computeConsumeResult`, `computePeekResult`, `computeBucketTtlSeconds`,
  and the `BucketState` / `ConsumeComputeResult` types. These were already
  implemented as a pure, I/O-free core but were only reachable internally.
  Exporting them lets a consumer that must run the rate-limit decision
  synchronously (the `DynamoTokenBucketLimiter` / `MemoryTokenBucketLimiter`
  are async-only by storage contract) reuse the exact same math instead of
  copying it. No behavior change to existing exports.

## 0.2.4

### Patch Changes

- Add `MemorySecretStore` to `@de-otio/saas-foundation/secrets` —
  in-memory `SecretsManagerClient` / `SSMClient` doubles that let tests
  seed secret and parameter values and exercise the real `resolveSecret`
  / `resolveParameter` code path without hitting AWS or hand-rolling
  `vi.mock` blocks.

## 0.2.3

### Patch Changes

- Add `createTestLogCapture()` to `@de-otio/saas-foundation/logger` so test
  suites can assert on log records without ad-hoc `vi.mock` blocks. Harden
  `configureRootLogger({ level: "silent" })` so bound child loggers are
  silenced too.

## 0.2.2

### Patch Changes

- 743808b: `KVNamespace.get<T>(key, "json")` is now properly typed as `Promise<T | null>` (with `T = unknown` default), matching Cloudflare's KV `get` shape. The runtime already parsed the JSON; only the type signature claimed `string | null`, forcing callers to write `as unknown as Shape` casts. Existing `get(key, "json")` callers without a generic continue to typecheck unchanged (default is `unknown`); the call site can now add `<T>` to skip the cast. `DynamoKv` and `MemoryKv` both gain matching overloads.

## 0.2.1

### Patch Changes

- 2eb1665: `R2HttpMetadata` now mirrors the full [Cloudflare R2 binding API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2httpmetadata) — `contentLanguage`, `contentDisposition`, `contentEncoding`, `cacheControl`, and `cacheExpiry` are now accepted on `put()` (mapped to S3's `ContentLanguage`/`ContentDisposition`/`ContentEncoding`/`CacheControl`/`Expires`) and surfaced on the response of `get()`/`head()`. Existing `contentType`-only callers are unaffected; this is a purely additive change.

## 0.2.0

### Minor Changes

- Initial public release. Runtime core: KV/queue/storage shims over AWS primitives, secrets loader, session crypto (AES-GCM), tenant context, append-only audit log, structured logger with request-id correlation, KV-backed rate limiter, region/residency routing, feature toggles, trusted-proxy IP derivation, and frozen-set brand types (`TenantId`, `AuditEvent`, `RequestContext`, `SecretRef`, `TenantSubdomain`, `ClientConfigRow`).
