# 10 — Feature toggles

DB-backed boolean toggle storage. Foundation owns the _storage_
layer; consumers own the _toggle vocabulary_ (the enum of "what
toggles exist and what they mean").

## What it owns

- `FeatureToggleStore` — the read/write interface. Default
  implementation is Prisma-backed, shipped behind the
  `@de-otio/saas-foundation/feature-toggles/prisma` sub-path
  (see [`./01-package-api.md`](./01-package-api.md#prisma-sub-paths)).
- `MemoryFeatureToggleStore` — an in-memory variant for tests,
  exported from the `feature-toggles` barrel and marked
  `@beta-test-only`.
- A small in-memory cache with TTL (toggles change rarely; reading on
  every request without a cache hammers the DB).
- A migration-friendly read path: an unknown toggle key returns
  `false` rather than throwing. New toggles can be referenced in
  code before the row exists.

## What it does _not_ own

- **The toggle _enum_.** Trellis's `feature-flags.ts` carries an
  `enum FeatureFlag { ... }` of trellis-specific toggles. This does
  **not** graduate. The trellis cutover keeps the enum in trellis;
  the _storage_ moves to foundation.
- **Targeted rollouts** (% of users, by tenant, by region). Out of
  scope. A boolean stored per-key is the entire shape. Consumers
  wanting LaunchDarkly-style targeting layer it on top.
- **HTTP admin surface.** Trellis has an admin handler for setting
  toggles via API; foundation does not. The consumer ships their own
  admin surface that calls `setToggle`.
- **Audit of toggle changes.** Trellis's existing flow logs toggle
  changes; foundation does not auto-emit. Recommended pattern:
  consumers emit an `AuditEvent` via the audit module at the call
  site of `setToggle`. The `setToggle` API returns the previous
  state to make this easy.

## Design

### Storage shape

A single table; consumer's DB:

```prisma
model FeatureToggle {
  key         String   @id
  enabled     Boolean  @default(false)
  changedAt   DateTime @updatedAt
  changedBy   String?
  description String?

  @@map("feature_toggles")
}
```

This Prisma schema mirrors trellis's existing one. Foundation does
not own the migration; the consumer adds the table to their
schema. Foundation's `FeatureToggleStore` queries it by key.

### `FeatureToggleStore`

```typescript
export interface FeatureToggle {
  readonly key: string;
  readonly enabled: boolean;
  readonly changedAt?: Date;
  readonly changedBy?: string;
  readonly description?: string;
}

export interface SetToggleInput {
  readonly key: string;
  readonly enabled: boolean;
  readonly changedBy: string;
  readonly description?: string;
}

export interface FeatureToggleStore {
  /** Returns false if the toggle doesn't exist (safe default). */
  isEnabled(key: string): Promise<boolean>;
  get(key: string): Promise<FeatureToggle | null>;
  list(): Promise<ReadonlyArray<FeatureToggle>>;
  set(input: SetToggleInput): Promise<{ previous: FeatureToggle | null; current: FeatureToggle }>;
  delete(key: string): Promise<void>;
}

// In the @de-otio/saas-foundation/feature-toggles/prisma sub-path only.
// NOT re-exported from the feature-toggles barrel or the top-level barrel.
export class PrismaFeatureToggleStore implements FeatureToggleStore {
  constructor(prisma: PrismaClient, options?: FeatureToggleStoreOptions);
}

export interface FeatureToggleStoreOptions {
  /** Cache TTL in ms. Default 60_000 (1 minute). */
  readonly cacheTtlMs?: number;
  /** Cache disable (debugging). Default false. */
  readonly cacheDisabled?: boolean;
}
```

#### `isEnabled` — safe defaults

`isEnabled` returns `false` for unknown keys (no row, table-missing
errors, transient DB errors). This is the trellis behaviour and the
correct safe-default for boolean feature flags: a flag that hasn't
been deployed yet should not light up. The `get` API returns `null`
for unknown keys so callers that _need_ to distinguish "off" from
"unknown" can.

`isEnabled` does _not_ throw on DB error — it logs the failure (via
`getLogger()`) and returns `false`. The reasoning: a request that
fails because the feature-toggle DB is briefly unavailable is worse
than a request that proceeds with the default-off behaviour. This is
load-bearing for trellis's behaviour and survives.

#### `set` returns previous state

```typescript
const { previous, current } = await toggles.set({
  key: "public-posting",
  enabled: true,
  changedBy: "admin@example.com",
});

await auditLog.emit({
  actor: { kind: "user", userSub: adminSub },
  action: "feature_toggle.update",
  resource: { kind: "feature_toggle", id: "public-posting" },
  outcome: "success",
  severity: "info",
  metadata: {
    previousEnabled: previous?.enabled ?? null,
    currentEnabled: current.enabled,
  },
});
```

The `previous` field lets the consumer emit a meaningful audit
event without a separate `get` call.

`set` performs an upsert (matching trellis's behaviour) — creates
the row if absent, updates if present. `description` is preserved
across updates that omit it.

#### Cache

A simple `Map<string, { value: boolean; expires: number }>`.
`isEnabled` checks the cache first; on miss it queries the DB and
populates. `set` and `delete` invalidate the entry. The cache is
per-store-instance, not process-global — a test can instantiate a
fresh store with a fresh cache.

The cache is intentionally not LRU-bounded: the working set of
feature toggles is small (dozens, not thousands) and bounded by the
toggle enum's size. If the consumer creates 10000 toggle keys, the
cache grows accordingly — but that's a design smell rather than a
foundation problem.

### Consumer-side toggle enum

Foundation does not provide an enum or a type-safe key API. Why:

- The toggle vocabulary is consumer-defined; foundation cannot
  enumerate it.
- A type-safe API (`isEnabled<K extends ToggleKey>(key: K)`) would
  require a generic that the consumer fills in, complicating the
  API surface for thin benefit.

Consumers can wrap the store to get type safety:

```typescript
// consumer code
type MyToggles = "public-posting" | "experimental-feed" | "new-comment-ui";

class MyFeatureToggles {
  constructor(private readonly store: FeatureToggleStore) {}
  isEnabled(key: MyToggles): Promise<boolean> {
    return this.store.isEnabled(key);
  }
}
```

The trellis cutover keeps `feature-flags.ts` as the enum and wraps
foundation's store in a small `TrellisFeatureToggles` class.

### Table-missing tolerance

Trellis's current code handles the "FeatureToggle table doesn't
exist yet" case (during initial deployment / migration) by returning
empty / false. Foundation does the same:

```typescript
async isEnabled(key: string): Promise<boolean> {
  try {
    /* cache + DB lookup */
  } catch (err) {
    if (isTableMissingError(err)) {
      this.logger.warn({ err, key }, 'feature_toggles table missing; defaulting to false');
      return false;
    }
    this.logger.error({ err, key }, 'feature toggle read failed');
    return false;
  }
}
```

`isTableMissingError` checks Prisma's `P2021` error code. This is
specific to Prisma; a future non-Prisma store implementation
re-implements the equivalent check.

## TypeScript surface

```typescript
export interface FeatureToggle {
  readonly key: string;
  readonly enabled: boolean;
  readonly changedAt?: Date;
  readonly changedBy?: string;
  readonly description?: string;
}

export interface FeatureToggleStore {
  isEnabled(key: string): Promise<boolean>;
  get(key: string): Promise<FeatureToggle | null>;
  list(): Promise<ReadonlyArray<FeatureToggle>>;
  set(input: SetToggleInput): Promise<{ previous: FeatureToggle | null; current: FeatureToggle }>;
  delete(key: string): Promise<void>;
}

// From @de-otio/saas-foundation/feature-toggles/prisma (sub-path only).
export class PrismaFeatureToggleStore implements FeatureToggleStore {
  constructor(prisma: PrismaClient, options?: FeatureToggleStoreOptions);
}

/** @beta-test-only — in-memory store for tests; not cross-process safe. */
export class MemoryFeatureToggleStore implements FeatureToggleStore {
  constructor(initial?: Record<string, boolean>);
}
```

## Caveats

- **Cache staleness window.** A toggle change reaches all instances
  within `cacheTtlMs` (default 60s). Consumers needing
  instant-propagation use a shorter TTL or invalidate via a
  pub/sub mechanism (not v0.1).
- **No targeting.** A toggle is on for everyone or off for everyone.
  Per-tenant or per-user gating is the consumer's job — typically
  by composing the toggle with a separate check
  (`if (await toggles.isEnabled('feature-x') && tenant.plan === 'beta')`).
- **`changedBy` is consumer-supplied and uninvalidated.** Foundation
  doesn't know what a valid `changedBy` looks like; the consumer
  passes the admin user's ID / email. Audit emits should also
  capture this for cross-reference.
- **No history.** The row records the _last_ change only. Consumers
  wanting a full history compose with the audit log (see § Audit
  pattern above) — the audit log retains every change with
  before/after state.

## Open questions

- **A `cache.invalidate(key)` public method?** Useful for an admin
  endpoint that just `set` on instance A and wants instance B to
  refresh. Today: B refreshes within `cacheTtlMs`. A cross-instance
  invalidation channel (Redis pub/sub, DynamoDB streams) is not v0.1.
- **`isEnabledMany([keys])` for batch reads?** A handler that
  checks 5 flags per request makes 5 DB round-trips on cache miss.
  Could batch into one query. Sugar; add when measured to matter.
- **Strong-typed `FeatureToggleStore<TKey extends string>`?**
  Would push type safety into foundation. Counter: consumers can
  achieve it with a thin wrapper. Leaning: stay loose, document
  the wrapper pattern.
- **A non-Prisma backend?** DynamoDB-backed feature toggles would
  let consumers skip Prisma. Achievable; the store interface is
  small. Ship if a consumer asks; v0.1 is Prisma-only.
