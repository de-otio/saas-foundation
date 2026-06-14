# 03 — Secrets

SSM Parameter Store and Secrets Manager loaders, the consumption side
of `SecretRef` (defined in
[`../04-shared-vocabulary.md`](../04-shared-vocabulary.md#secretref)),
and the plaintext-lifecycle discipline that keeps a leaked secret a
fire-once event.

## What it owns

- `resolveSecret(ref, context?, options?): Promise<Buffer>` — `SecretRef`
  → plaintext bytes, via Secrets Manager `GetSecretValue`. The result is
  a `Buffer` (not a string) so the cache layer can zeroize the bytes on
  eviction.
- `resolveParameter(name, context?, options?): Promise<Buffer>` — SSM
  parameter path → value bytes, for non-secret config
  (`/myapp/dev/cognito-user-pool-id`).
- `SecretCache` — in-process LRU+TTL cache for resolved values, so a
  per-request call site does not hit the SDK every time.

> The `/secrets` barrel ships **resolvers, cache, client factories, and
> the error hierarchy only** — there is no write surface
> (`SecretsManagerWriteClient` / `SecretsWriteClient`) and no
> `SecretRotationHook`. Those were sketched in earlier design drafts but
> are **not built**; see [Not built](#not-built).

## What it does _not_ own

- Encryption / decryption of arbitrary blobs — that's
  [`./04-session-crypto.md`](./04-session-crypto.md).
- The `SecretRef` type and its validators — those are in the frozen
  vocabulary ([`../04-shared-vocabulary.md`](../04-shared-vocabulary.md)).
- The consumer-side env schema. trellis has `env.ts` with a list of
  well-known SSM parameter paths; this stays in the consumer. Foundation
  resolves any `SecretRef`, regardless of where the consumer got it from.
- Secret rotation orchestration (Lambda rotation functions in Secrets
  Manager). That is an infrastructure concern; the vestibulum-cdk
  package handles the relevant rotation Lambdas for IdP client
  secrets.

## Design

### Two stores, two access shapes

Secrets Manager and SSM Parameter Store both store key/value pairs.
The practical distinction:

- **Secrets Manager** for actual secrets (session-encryption keys, IdP
  client secrets, DB credentials). Supports rotation, versioned
  reads, IAM-level fine-grained access, KMS encryption.
- **SSM Parameter Store** for non-secret config (Cognito pool ID,
  feature endpoint URLs, region IDs). Cheaper, simpler ACLs.
  `SecureString` parameters are supported for the gradient between
  the two.

Foundation exposes both. The consumer chooses; the choice is encoded
in _which API they call_ (`resolveSecret` for Secrets Manager,
`resolveParameter` for SSM), not by sniffing the input.

### `resolveSecret`

```typescript
export interface SecretRef {
  readonly arn: string;
  readonly versionId?: string;
}

export interface ResolveSecretOptions {
  /** Bypass the cache and force a fresh fetch. */
  readonly fresh?: boolean;
}

export interface ResolveContext {
  readonly secretsClient?: SecretsManagerClient;
  readonly ssmClient?: SSMClient;
  readonly cache?: SecretCache;
}

export async function resolveSecret(
  ref: SecretRef,
  context?: ResolveContext,
  options?: ResolveSecretOptions,
): Promise<Buffer>;
```

Resolution path:

1. Look up `(ref.arn, ref.versionId ?? 'AWSCURRENT')` in the cache.
2. On hit, return cached plaintext bytes.
3. On miss, call `GetSecretValueCommand` with the ARN and (if set)
   `VersionId`. `SecretString` is read as UTF-8 bytes; `SecretBinary`
   is read directly. Cache the result. Return.
4. Errors from the SDK propagate as a `SecretsResolveError`
   (instance-of-able for `if (err instanceof SecretsResolveError)`).
   Missing secrets surface as `SecretsNotFoundError` (a subclass) so
   "the consumer typo'd the ARN" can be distinguished from "the SDK
   is throttling us."

`fresh: true` is the consumer's hook for "I just got a 401 from the
service that uses this credential — refetch in case it rotated." It
invalidates the entry and re-fetches. There is no automatic refresh
on stale credentials — the consumer is in control of when to refetch
because foundation has no signal about whether a downstream call
succeeded.

### `resolveParameter`

```typescript
export interface ResolveParameterOptions {
  readonly fresh?: boolean;
  /** If the parameter is `SecureString`, set true to request decryption. */
  readonly withDecryption?: boolean;
}

export async function resolveParameter(
  name: string,
  context?: ResolveContext,
  options?: ResolveParameterOptions,
): Promise<Buffer>;
```

Same shape as `resolveSecret`. Errors split similarly:
`ParameterNotFoundError`, `ParameterAccessDeniedError`, and
`SecretsTransientError` (for throttling / transient SSM failures), all
extending the base `SecretsResolveError` (everything else falls back to
the base).

### `SecretCache`

A small LRU + per-entry TTL cache. Defaults: 100 entries, 5-minute
TTL. The cache is process-global by default (singleton-free; the
default cache lives in a module-scoped `let defaultCache` and the
consumer can override at instantiation):

```typescript
export interface SecretCacheOptions {
  readonly maxEntries?: number; // default 100
  readonly ttlSeconds?: number; // default 300
}

export class SecretCache {
  constructor(options?: SecretCacheOptions);

  get(key: string): Buffer | null;
  set(key: string, value: Buffer): void;
  invalidate(key: string): boolean;
  clear(): void;
}
```

`SecretCacheOptions` also accepts an injectable `clock?: () => number`
(defaults to `Date.now`) so tests can pin a fixed "now" and assert TTL
invariants deterministically.

`resolveSecret` and `resolveParameter` accept an optional `cache` via
the `ResolveContext` (shown above). The consumer who wants a per-request
cache (rare) constructs one and passes it; the consumer who wants the
default behaviour passes nothing. Tests pass `cache: new SecretCache()`
to get a fresh cache each test.

The cache stores _plaintext_ values keyed by ARN+VersionId. This is
the only place in foundation where plaintext lives across request
scopes. The cache is in-memory only — never serialised, never written
to disk. The 5-minute default TTL bounds how long a rotated secret
remains stale; consumers needing tighter coupling pass
`{ fresh: true }` on the call that just failed.

**Plaintext-in-memory limitations.** The cache stores each value in
a `Buffer` (not a JS string) and overwrites the buffer's bytes
(`buf.fill(0)`) on eviction. This is a best-effort defence-in-depth
measure: it limits the window in which a leaked heap dump exposes a
secret. It is **not** a hard guarantee. JS GC timing is non-
deterministic — until the buffer is GC'd, an old reference may still
point at the original bytes; and an attacker with arbitrary read on
the process can scrape the live cache directly. The only secure-erase
property foundation offers is "eviction zeroes the buffer the cache
owns." Consumers must not treat the cache as a substitute for
limiting RCE blast radius.

### Not built

The following were sketched in earlier drafts but are **not implemented**
in `src/secrets/`. They are recorded here so a reader does not go looking
for them.

- **Secrets Manager write surface** (`SecretsWriteClient` /
  `SecretsManagerWriteClient` with `create` / `rotate` / `delete` /
  `describe`). The module is read-only: it resolves existing secrets and
  parameters but does not create, rotate, or delete them. If a write
  surface is needed later, it would graduate from trellis's
  `secrets/idp-secrets.ts` with the trellis-specific naming convention
  (`tenant/{tenantId}/idp-client-secret`) stripped out — that convention
  would live in the calling layer, not in foundation.
- **`SecretRotationHook`** — there is no rotation-notification
  abstraction. Rotation-aware refetch is consumer-side glue: a consumer
  that subscribes to Secrets Manager's EventBridge rotation events can
  call `cache.invalidate(...)` itself. See [Open questions](#open-questions).

### Plaintext lifecycle

Three rules, all enforced by reviewer attention rather than tooling:

1. **`SecretRef` carries no plaintext.** The frozen type
   ([`../04-shared-vocabulary.md`](../04-shared-vocabulary.md))
   has no `value` field. Anyone tempted to add one — don't.
2. **Plaintext lives only on the call stack of `resolveSecret`'s
   awaiter.** Once `await resolveSecret(...)` resolves, the consumer
   uses the value (passes it to an SDK call, derives a key from it,
   etc.) and lets it go. No storing in a class field, no logging,
   no putting it in a `Map` outside of `SecretCache`.
3. **`SecretCache` is the only place plaintext crosses request
   scopes**, and it never serialises. The cache is in-memory only.
   If a consumer hits a `console.log(cache)` for debugging, that's
   an incident — opening the cache's contents is logging secrets.

Foundation does not implement a "secrets-aware logger" — the right
posture is "plaintext never reaches the logger in the first place."
The logger is unchanged ([`./07-logger-and-request-context.md`](./07-logger-and-request-context.md));
the burden is on the caller to not pass plaintext to it.

### Removing trellis's `SecretResolver` legacy surface

Trellis's `secret-resolver.ts` is shaped around Cloudflare-Workers
env-var names (`trellis_dev_session_secret`) with a fallback for the
flat `SESSION_SECRET` env var. This shape does not survive the
extraction. Foundation's resolver works on `SecretRef` (Secrets
Manager ARN) and SSM parameter paths only. The Cloudflare-shaped
fallback is a trellis-era artefact and stays in trellis until the
cutover replaces it.

The trellis cutover replaces `Secrets.getSessionSecret(env)` with:

```typescript
// trellis-side, post-cutover
const sessionSecret = await resolveSecret(secretRef(env.SESSION_SECRET_ARN));
```

`env.SESSION_SECRET_ARN` becomes the consumer's well-known env var,
not a flat plaintext anymore. The plaintext is fetched from Secrets
Manager via foundation.

## TypeScript surface (full)

```typescript
// Re-exports of the frozen SecretRef type + factory/predicate
// (canonical definition in foundation/src/types/frozen/secrets.ts).
export type { SecretRef } from "../types/frozen/secrets.js";
export { SecretRefValidationError, secretRef, isSecretRef } from "../types/frozen/secrets.js";

// Resolution
export interface ResolveContext {
  readonly secretsClient?: SecretsManagerClient;
  readonly ssmClient?: SSMClient;
  readonly cache?: SecretCache;
}
export interface ResolveSecretOptions {
  readonly fresh?: boolean;
}
export interface ResolveParameterOptions extends ResolveSecretOptions {
  readonly withDecryption?: boolean; // default true
}

export async function resolveSecret(
  ref: SecretRef,
  context?: ResolveContext,
  options?: ResolveSecretOptions,
): Promise<Buffer>;

export async function resolveParameter(
  name: string,
  context?: ResolveContext,
  options?: ResolveParameterOptions,
): Promise<Buffer>;

// Cache
export class SecretCache {
  constructor(options?: { maxEntries?: number; ttlSeconds?: number; clock?: () => number });
  get(key: string): Buffer | null;
  set(key: string, value: Buffer): void;
  invalidate(key: string): boolean;
  clear(): void;
}

// Client factories
export function createDefaultSecretsManagerClient(options?: DefaultClientOptions): SecretsManagerClient;
export function createDefaultSsmClient(options?: DefaultClientOptions): SSMClient;

// Errors — all subclasses extend the single base SecretsResolveError.
export class SecretsResolveError extends Error {
  readonly cause?: unknown;
}
export class SecretsNotFoundError extends SecretsResolveError {}
export class SecretsAccessDeniedError extends SecretsResolveError {}
export class SecretsTransientError extends SecretsResolveError {}
export class ParameterNotFoundError extends SecretsResolveError {}
export class ParameterAccessDeniedError extends SecretsResolveError {}
```

There is no separate `ParameterResolveError` base — SSM and Secrets
Manager errors share the single `SecretsResolveError` hierarchy.

## Caveats

- **Eventually-consistent reads.** Secrets Manager reads can lag
  recent writes by a small amount. If the consumer rotates and
  immediately calls `resolveSecret({ fresh: true })`, they may still
  see the old value for a few seconds. Documented; not surfaced as
  an error.
- **Throttling.** Secrets Manager has per-account read limits
  (default 1500 reads/second; raisable). The cache is the protection;
  consumers that bypass it (`{ fresh: true }` on every request)
  will hit limits. Foundation's internal `cockatiel` retry catches
  bursts but cannot keep up with sustained over-rate use.
- **No multi-region replication awareness.** If a secret is
  replicated to a second region via Secrets Manager's
  cross-region replication, foundation does not coordinate
  reads — the SDK client's region wins. Consumers that need
  region-locality of secret reads supply a per-region
  `SecretsManagerClient` via the resolve context.
- **Cache scope is process-wide by default.** Multiple
  `resolveSecret(ref)` calls within a Lambda invocation share the
  cache; calls in a _new_ Lambda invocation hit the SDK again
  (cold-start cost). Persistent (warm) Lambda environments
  retain the cache between invocations as long as the container
  lives — which is the right behaviour for credentials, but a gotcha
  for consumers expecting per-invocation fresh reads.

## Open questions

- **Should we ship a `SecretCacheRedis` or similar?** No for v0.1 —
  the in-process cache is sufficient for the deployment shapes we
  know about (Lambda, ECS task). Move to a shared cache only when
  a consumer has a measured throttling problem.
- **Binary secrets are already covered.** The resolvers return
  `Buffer`, and `resolveSecret` reads `SecretBinary` directly when no
  `SecretString` is present, so a stored private-key DER round-trips
  without a separate API. A caller wanting text decodes the buffer
  (`buf.toString('utf-8')`).
- **Per-request cache scoping via `RequestContext`?** Pattern would
  be: `resolveSecret(ref, { cacheKey: requestContext.requestId })`,
  scoping cache lifetime to a request. Counter: makes warm-Lambda
  amortisation worse for no real safety gain. Leaning: no — the
  consumer can pass an explicit cache if they want this.
- **A `SecretRotationHook` for "background refetch on rotation
  notification"?** Secrets Manager can emit EventBridge events on
  rotation. A consumer could subscribe and call
  `cache.invalidate(ref.arn)` on the event. Foundation does not
  ship this — it's consumer-side glue, not a primitive. Documented
  as a usage pattern rather than a foundation feature.
