# 06 — Audit log

Append-only event persistence keyed on `AuditEvent` (defined in
[`../04-shared-vocabulary.md`](../04-shared-vocabulary.md#auditevent)).
Storage backend, retention tiers, emission patterns. (The query/reader
model is designed but not yet built — see § Reader API.)

## What it owns

- `AuditLog` — the writer. Persists `AuditEvent` rows to a storage
  backend. Two emission shapes: `emitAwait` (await-and-throw) and
  `emit` (fire-and-forget). See § Writer.
- A pluggable `AuditStore` interface so the storage backend can be
  swapped (DynamoDB is the default; RDS/Postgres is the alternative
  for consumers already running Postgres). The shipped backends are
  `DynamoAuditStore`, `MultiAuditStore`, and `PostgresAuditStore`
  (sub-path export).
- A PII filter that runs before persistence — strips known-sensitive
  keys (raw IP, email plaintext, password, token, secret, …) from
  `AuditEvent.metadata`. Top-level fields are not stripped because
  the frozen schema already encodes the scrubbing decisions (IP is
  pre-scrubbed by region policy, UA is full-fidelity by design).
- Retention enforcement: per-row DynamoDB TTL (the `ttl` attribute),
  or a `retention_until` column for the Postgres backend.

> **Reader not built.** The query side — `AuditQuery` and the
> `query*`-style `AuditStore` methods — is **not implemented**. The
> shipped `AuditStore` exposes `put` only. The reader API is recorded
> below under [Future: reader API](#future-reader-api-not-in-v0x) so a
> reader does not assume it ships today.

## What it does _not_ own

- **The `AuditEvent` _type_.** That's the frozen vocabulary
  ([`../04-shared-vocabulary.md`](../04-shared-vocabulary.md#auditevent)).
  This doc only covers persistence and query of that shape.
- **CloudWatch Logs export.** Trellis's current `audit/emit.ts` dual-
  writes to CloudWatch Logs _and_ Postgres. Foundation's writer
  composes two stores via `MultiAuditStore` when redundancy is
  needed — see § Dual-store recipe. This is shipped (not a v0.2
  open question) so the consumer-side audit-integrity story is
  coherent on day one.
- **Alerting / dashboarding.** Audit data feeds those downstream
  pipelines; foundation does not ship them.
- **The action enum / vocabulary.** `AuditAction` is open-string-
  union; consumers (including trellis) define their own action
  strings on top of the well-known ones in the frozen set.

## Design

### Storage backend recommendation: **DynamoDB** for v0.1

The top-level docs left this open. Resolving:

| Option          | Pros                                                                                                  | Cons                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **DynamoDB**    | TTL-based retention free; partition-key scaling; matches the `kv` shim's storage; serverless-friendly | Query patterns require GSIs; no SQL                                  |
| Postgres (RDS)  | Familiar query model; consumers already have a DB                                                     | TTL = manual sweeper; scaling at high write rates needs partitioning |
| CloudWatch Logs | Free-ish, no infra; trellis already writes there                                                      | Query-by-time only; no by-tenant index without subscription filters  |

**Recommendation: DynamoDB as the v0.1 default**, with a Postgres
adapter behind the same `AuditStore` interface for consumers who
prefer their existing DB. Rationale:

- The foundation-level audit log is a _security_ artifact: it must
  survive the consumer's primary DB being offline. Coupling audit
  writes to the same RDS instance that holds business data
  introduces a correlated failure mode.
- DynamoDB's TTL feature makes retention enforcement free (per-row
  TTL → automatic deletion by AWS). The Postgres alternative
  requires a sweeper Lambda — more moving parts.
- The `kv` module already settles the DynamoDB single-table pattern;
  audit re-uses the same table (different partition-key prefix) or a
  dedicated audit table — consumer choice.

The Postgres backend is shipped as the secondary backend because
trellis is currently writing audit to `SecurityEvent` (a Postgres
table) and the cutover path benefits from a like-for-like move
during the extraction phase. Post-cutover trellis can switch to
DynamoDB-backed audit when the cost is justified.

### Storage schema (DynamoDB default)

Single table; partition key encodes tenant for partition-aligned
queries; sort key encodes time for range scans.

```
PK: AUDIT#{tenantId ?? '_global'}
SK: {timestamp-iso}#{event-id}
```

The `_global` partition holds cross-tenant events (admin operations,
system-emitted events with no tenant scope). Trellis's audit data
mostly does have a tenant; the `_global` bucket prevents an
unbounded hot partition for system events.

Additional GSIs:

- **`GSI1-actor`**: `PK1: ACTOR#{actorKind}#{actorId}`, `SK1: timestamp` —
  "all events by user X".
- **`GSI2-action`**: `PK2: ACTION#{tenantId ?? '_global'}#{action}`,
  `SK2: timestamp` — "all `auth.login` events for tenant T".

The writer (`DynamoAuditStore`) populates the `PK1`/`SK1`/`PK2`/`SK2`
attributes on every row so these GSIs are queryable, but the reader
that would consume them (`byTenant` / `byActor` / `byAction`) is **not
built** — see § Reader API. The two GSIs are sized for those future
query patterns; more-specific access patterns (per-resource history)
would require an extra GSI or a post-filter, a known limitation of
DynamoDB-backed audit.

Row item shape:

```json
{
  "PK": "AUDIT#tenant-acme",
  "SK": "2026-05-24T08:30:15.000Z#01HW...",
  "PK1": "ACTOR#user#user_abc123",
  "SK1": "2026-05-24T08:30:15.000Z",
  "PK2": "ACTION#tenant-acme#auth.login",
  "SK2": "2026-05-24T08:30:15.000Z",
  "event": {
    /* full AuditEvent as JSON */
  },
  "ttl": 1748234415
}
```

`ttl` is set from `severity → retention-tier` mapping (see below).
DynamoDB deletes the row when `ttl` passes.

### Retention tiers

From the frozen `AuditEvent`
([`../04-shared-vocabulary.md`](../04-shared-vocabulary.md#auditevent)):

| Severity  | Retention | Use                                                           |
| --------- | --------- | ------------------------------------------------------------- |
| `info`    | 30 days   | Routine ops — read access, successful logins, normal CRUD     |
| `warning` | 180 days  | Failed authn/authz, unexpected outcomes worth keeping a while |
| `error`   | 400 days  | Security incidents, just past a typical annual audit cycle    |

The defaults are GDPR-storage-minimisation-friendly. Foundation
targets DACH/EU SaaS workloads; over-long retention is itself a
compliance risk under GDPR Article 5(1)(e). The frozen-set numbers
do **not** chase the industry maximum (SOX 7y, HIPAA 6y) because
those frames are vertical-specific and the foundation default
should not bake them in. Consumers in regulated verticals lengthen
via the `retentionDays` option (below).

Trellis's current retention (7 days / 30 days / 90 days / 365 days
keyed on a 4-level severity) collapses to the foundation 3-level set
on cutover:

- trellis `low` → foundation `info` (30d vs 7d — longer in foundation)
- trellis `medium` → foundation `warning` (deterministic; no
  consumer policy switch). The mapping is fixed because a runtime-
  policy-dependent mapping makes audit retention non-deterministic
  across consumers and complicates query semantics.
- trellis `high` → foundation `warning` (180d vs 90d — longer)
- trellis `critical` → foundation `error` (400d vs 365d — slightly
  longer)

Per-deployment retention overrides:

```typescript
new DynamoAuditStore(client, tableName, {
  // Partial<Record<AuditSeverity, number>>; unset tiers fall back to
  // foundation defaults (info: 30, warning: 180, error: 400).
  retentionDays: {
    info: 14, // tighter than default
    error: 2555, // 7-year retention for a regulated vertical
    // warning: undefined -> falls back to 180
  },
});
```

The retention values are persisted _on the row_ (via the `ttl`
field) at write time. Changing the policy post-write does not
retroactively shorten or lengthen retention — the persisted TTL is
what's enforced. This means policy changes apply only to _new_
events.

### Writer: `AuditLog`

```typescript
export class AuditLog {
  constructor(store: AuditStore, options?: AuditLogOptions);

  /**
   * Await-and-throw emit. Awaits the underlying store write and
   * returns the persisted event (with `id` and `timestamp` filled).
   * Throws `AuditWriteError` if the store rejects the write. This is
   * the RECOMMENDED call because an audit log that swallows write
   * failures defeats its own purpose.
   */
  async emitAwait(input: EmitInput): Promise<AuditEvent>;

  /**
   * Fire-and-forget emit. Logs failures via the configured logger and
   * returns once the store call has been *initiated* (not awaited).
   * For callers on extremely hot paths who consciously accept the
   * risk that a transient store outage drops a small number of
   * events. Use sparingly; pair with `MultiAuditStore` to keep a
   * second copy.
   */
  emit(input: EmitInput): void;
}

export interface AuditLogOptions {
  /** Filter applied to event.metadata before persist; default strips
   *  known-sensitive keys. */
  readonly piiFilter?: PiiFilter;
  /** Logger to receive write failures. Defaults to a detached child. */
  readonly logger?: Logger;
  /**
   * Maximum serialised size (in bytes) of `event.metadata` after JSON
   * encoding. Defaults to 32 768 (32 KB).
   */
  readonly metadataMaxBytes?: number;
  /**
   * Policy on oversize metadata:
   *   - `'reject'` (default): throw `AuditWriteError` so audit-evasion
   *     attempts surface; the caller decides whether to retry with
   *     pruned metadata.
   *   - `'truncate'`: drop the largest metadata keys until the limit
   *     is met; record a `metadata_truncated: true` marker on the
   *     persisted event.
   */
  readonly metadataOversizePolicy?: "reject" | "truncate";
  /**
   * Partial override of per-severity retention in DAYS. Unset tiers
   * fall back to the foundation defaults (info: 30, warning: 180,
   * error: 400).
   */
  readonly retentionDays?: Partial<Readonly<Record<AuditSeverity, number>>>;
  /** Clock source (epoch ms). Defaults to `Date.now`; tests inject a
   *  frozen clock. */
  readonly clock?: () => number;
}
```

`EmitInput` is the consumer-facing input type — `AuditEvent` minus
`id` and `timestamp`, which the writer mints. It is exported from the
audit barrel.

`id` (ulid) and `timestamp` (ISO 8601) are generated by the writer.
The consumer cannot supply them — preventing replay-style collisions
and matching the discipline from
[`../04-shared-vocabulary.md`](../04-shared-vocabulary.md#auditevent).

**Emit semantics.** Two methods, named so the safety trade-off is
visible at the call site:

- **`emitAwait`** (RECOMMENDED) is await-and-throw: it awaits the
  store write, returns the persisted `AuditEvent` on success, and
  throws `AuditWriteError` on store failure. This is the default
  posture because an audit log that swallows write failures defeats
  its own purpose (a silently-dropped event can cover an intrusion).
- **`emit`** is fire-and-forget: it validates and initiates the store
  write, returning once the call is _started_ (not awaited). Failures
  are routed to the injected logger as a structured
  `audit-write-failed` line — not swallowed silently — but they do not
  propagate to the caller. Use only on extremely hot paths where a
  transient store outage _must not_ take down a user request.

The recommended posture: use `emitAwait` everywhere; pair with
`MultiAuditStore` (next section) for durability across a primary-
store outage. This keeps the integrity story coherent — audit
writes either succeed against at least one durable store or surface
the failure to the caller.

### Metadata size cap

`event.metadata` is JSON-encoded by the store. DynamoDB caps items
at 400 KB; CloudWatch Logs caps entries at 256 KB; even within those
limits, a single 200 KB audit event hides what it's logging behind
unsearchable bulk. Foundation enforces a default 32 KB cap on
encoded `metadata`. Two policies:

- **`reject`** (default): the writer throws `AuditWriteError` with a
  descriptive message. This surfaces audit-evasion attempts —
  silently truncating an oversized event is the failure mode that
  lets an attacker stuff diagnostic noise into metadata to hide a
  significant entry.
- **`truncate`**: the writer drops the largest metadata keys until
  the encoded payload fits, then sets a top-level `metadata_truncated:
true` flag. Useful for consumers whose audit consumers (search
  indexers, dashboards) cannot tolerate write failures; the
  truncation marker preserves the forensic signal.

The cap is per-event, not aggregate. Consumers who routinely write
events near the cap should reshape — fewer keys, less prose, ship
the bulk to a separate forensic store and reference it by ID.

### PII filter

A small, default-on filter that removes keys matching a denylist
from `event.metadata`:

```typescript
const DEFAULT_PII_KEYS = [
  "password",
  "pwd",
  "token",
  "access_token",
  "refresh_token",
  "secret",
  "api_key",
  "authorization",
  "cookie",
  "session",
  "email_raw", // 'email' is allowed (audit needs principal identity);
  // 'email_raw' is for handlers that explicitly distinguish.
];
```

Consumers can pass `{ piiFilter: new PiiFilter({ keys: [...], strategy: 'redact' }) }`
to extend or replace the list. `strategy: 'redact'` replaces values
with `[REDACTED]`; `strategy: 'drop'` removes the key entirely.

The filter does NOT touch top-level `AuditEvent` fields. `ipAddress`
is scrubbed by region policy _before_ the event is constructed
([`./11-ip-derivation.md`](./11-ip-derivation.md));
`userAgent` is full-fidelity by design (UA mismatch is a session-
takeover signal).

### Reader API

The reader half — `AuditQuery` and the `query*`-style `AuditStore`
methods — is **not implemented**. The shipped `AuditStore` is
`put`-only (see § `AuditStore` interface). The proposed reader shape is
recorded under [Future: reader API](#future-reader-api-not-in-v0x).

### `AuditSeverity` export

```typescript
export type AuditSeverity = "info" | "warning" | "error";
```

`AuditSeverity` is re-exported from the audit module's barrel and
from the top-level package barrel so consumers can type their
retention overrides without re-declaring the union:

```typescript
import type { AuditSeverity } from "@de-otio/saas-foundation";

const overrides: Partial<Record<AuditSeverity, number>> = {
  info: 14,
  error: 2555,
};
```

### `AuditStore` interface

The storage adapter shape:

The shipped interface is deliberately minimal — only `put` mutates
state, so the store is implementable on top of an append-only IAM grant
(`dynamodb:PutItem` only). The reader half is intentionally not part of
this interface (see § Reader API).

```typescript
export interface AuditStore {
  /** Insert a new event. MUST be implementable on top of an
   *  append-only IAM grant — no update/delete paths. */
  put(event: AuditEvent, retentionSeconds: number): Promise<void>;
}

export class DynamoAuditStore implements AuditStore {
  constructor(
    client: DynamoDBClient,
    tableName: string,
    options?: DynamoAuditStoreOptions, // { retentionDays?, clock? }
  );
}
```

`PostgresAuditStore` ships behind the
`@de-otio/saas-foundation/audit/prisma` sub-path export (see
[`./01-package-api.md`](./01-package-api.md#prisma-sub-paths)) and is
**not** re-exported from the audit module's top-level barrel.
Importing it requires Prisma installed; the sub-path quarantine
keeps the `@prisma/client` optional peer optional in practice.

```typescript
// Imported only by consumers who have installed @prisma/client
import { PostgresAuditStore } from "@de-otio/saas-foundation/audit/prisma";

export class PostgresAuditStore implements AuditStore {
  constructor(
    prisma: PrismaClient,
    options?: {
      readonly retentionDays?: Partial<Record<AuditSeverity, number>>;
    },
  );
}
```

The Postgres adapter writes to an `audit_event` table with columns
matching the `AuditEvent` shape, an index on
`(tenant_id, created_at desc)` plus
`(actor_kind, actor_id, created_at desc)`, and a `retention_until`
timestamp column computed from `severity → retentionDays` at write
time. Prisma schema sketch lives in the package's README.

#### Postgres sweeper job

Postgres has no built-in TTL; the `retention_until` column is the
foundation-side primitive, but enforcement requires a periodic
`DELETE FROM audit_event WHERE retention_until < now()` run.
**Foundation does not ship a sweeper Lambda** — there is no
`dist/audit/prisma/sweeper.js`. Sweeping is consumer-owned: run the
`DELETE` (plus an optional vacuum hint) from whatever scheduler the
consumer already has (an EventBridge-triggered Lambda, a Kubernetes
CronJob, etc.). The required SQL is two lines; the design note in
`src/audit/prisma.ts` records the recommended sweeper shape (a separate
role with `DELETE` scoped via row-level security) but the wiring is the
consumer's.

The DynamoDB backend uses native TTL (the `ttl` row attribute) and
needs no sweeper. The split is documented because the two backends
have asymmetric operational overhead, which matters when consumers
pick one.

### Append-only integrity

The audit log is a security artefact; an attacker who achieves RCE
on the application process must not be able to silently amend or
delete rows that document their intrusion. Foundation's design
treats this as an out-of-band IAM concern, not as application logic.

**Required IAM posture (DynamoDB backend).** The application role's
grant on the audit table is **`dynamodb:PutItem` only**. No
`dynamodb:UpdateItem`. No `dynamodb:DeleteItem`. No
`dynamodb:BatchWriteItem` (since BatchWrite permits deletes). The
`AuditStore` interface is designed to be implementable on top of
this minimal grant — `put` is the only mutation method.

```jsonc
// Application role audit-table policy (snippet)
{
  "Effect": "Allow",
  "Action": "dynamodb:PutItem",
  "Resource": "arn:aws:dynamodb:eu-central-1:123456789012:table/app-audit",
}
// Query permissions on the GSIs are read-only and remain unchanged.
```

For Postgres: the application's DB role has `INSERT` on `audit_event`
only — no `UPDATE` or `DELETE`. The sweeper role (separate;
runs on a schedule) has `DELETE` scoped to rows where
`retention_until < now()` via a `pg_policy` row-level-security rule.

**Immutable secondary (recommended).** For genuine tamper-evidence,
ship audit writes to a secondary store with stronger guarantees:
DynamoDB Streams → Lambda → S3 with **Object Lock** in compliance
mode (write-once, no-delete-even-by-root). The secondary lags by
seconds but is recoverable from a primary-store compromise. The
`MultiAuditStore` dual-store recipe (next section) is one half of
this; the Streams-to-S3 wiring is consumer-side CDK.

**Code-review gate.** A grep rule on any future code that lands
under `src/audit/`: `DynamoAuditStore` and `PostgresAuditStore`
implementations MUST NOT call `UpdateItem`, `DeleteItem`,
`BatchWriteItem`, or `UPDATE`/`DELETE` SQL. Lint and CR catch
regressions; production IAM is the defence in depth.

### Dual-store recipe with `MultiAuditStore`

Audit writes go to two stores, both attempted; if either succeeds,
the event is durably persisted. This is the canonical posture for
consumers who want to survive a primary-store outage.

```typescript
import { AuditLog, DynamoAuditStore, MultiAuditStore } from "@de-otio/saas-foundation";
// PostgresAuditStore is sub-path-only (requires @prisma/client):
import { PostgresAuditStore } from "@de-otio/saas-foundation/audit/prisma";

const primary = new DynamoAuditStore(ddbClient, "app-audit");
const secondary = new PostgresAuditStore(prisma);
const store = new MultiAuditStore([primary, secondary], { mode: "all-or-any" });

const audit = new AuditLog(store);
```

Foundation ships two concrete stores — `DynamoAuditStore` and
`PostgresAuditStore` (sub-path). The canonical tamper-evident secondary
is S3 with Object Lock, but foundation does **not** ship an S3 store
(Object Lock setup is consumer-side CDK); a consumer wiring that path
implements the `AuditStore` interface themselves and passes it to
`MultiAuditStore`.

`MultiAuditStore` modes:

- **`'all-or-any'`** (recommended for security-critical writes):
  initiate writes to all stores in parallel; succeed if _any_ one
  resolves. Failed-store errors are logged via the injected `logger`
  but do not propagate. This is what makes audit-write integrity
  robust against a single-store outage.
- **`'all'`**: all stores must succeed for the write to succeed.
  Stricter; useful when both stores are equally trusted and a
  divergence is itself a problem to surface.

`MultiAuditStore` is exported from the `audit` barrel. Its options take
a `mode` and an optional `logger` (which receives per-store failure
lines — the only forensic signal in `all-or-any` mode that a write went
to fewer than all stores).

## TypeScript surface

```typescript
// Frozen-set types (defined in foundation/src/types/frozen/audit.ts)
export type {
  AuditEvent,
  AuditActor,
  AuditAction,
  AuditResource,
  AuditSeverity,
} from "../types/frozen/audit.js";

// EmitInput is AuditEvent minus { id, timestamp } (the writer mints them).
export type { EmitInput } from "./schemas.js";

export class AuditLog {
  constructor(store: AuditStore, options?: AuditLogOptions);
  emitAwait(input: EmitInput): Promise<AuditEvent>; // RECOMMENDED
  emit(input: EmitInput): void; // fire-and-forget
}

// NOTE: the reader half (AuditQuery + query* AuditStore methods) is NOT
// implemented. See § Reader API and § Future: reader API.

export interface AuditStore {
  put(event: AuditEvent, retentionSeconds: number): Promise<void>;
}
export class DynamoAuditStore implements AuditStore {
  constructor(client: DynamoDBClient, tableName: string, options?: DynamoAuditStoreOptions);
}
export class MultiAuditStore implements AuditStore {
  constructor(stores: ReadonlyArray<AuditStore>, options?: MultiAuditStoreOptions);
}

// NOTE: PostgresAuditStore is NOT exported from this barrel.
// Import it from '@de-otio/saas-foundation/audit/prisma'.

export class PiiFilter {
  constructor(options?: { keys?: ReadonlyArray<string>; strategy?: "redact" | "drop" });
  apply(metadata: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>>;
}

// Errors
export class AuditWriteError extends Error {
  readonly event: AuditEvent;
}
export class AuditEventValidationError extends Error {
  readonly issues: ReadonlyArray<string>;
}
export class AuditStoreError extends Error {}
```

## Caveats

- **Eventual consistency.** DynamoDB GSI reads are eventually
  consistent. A query right after a write may not see the event for
  a few hundred ms. Acceptable for the audit use case; documented.
- **Hot partition risk.** A single tenant generating thousands of
  events per second hits the per-partition write limit (~1000 WCU).
  Mitigation: shard the tenant partition (e.g.,
  `AUDIT#tenant-acme#shard{0..15}` with shard-id derived from
  ulid prefix). Foundation does not implement sharding by default —
  most consumers are well below the threshold. The store adapter
  can be subclassed if sharding is needed.
- **PII filter is not magic.** It catches _known-named_ sensitive
  keys. A consumer who logs `{ pii_blob: '<full ID card>' }` will
  not be helped by the filter. The filter is a backstop, not a
  primary defence — the primary defence is "don't put PII in
  metadata in the first place."
- **No global ordering.** Events from concurrent writers can arrive
  out-of-order within a millisecond. ulids preserve sort order down
  to the millisecond + randomness; this is "good enough" ordering
  for forensic timeline reconstruction, but not a totally-ordered
  log.
- **Cross-region writes.** A multi-region deployment that writes to
  region-local DynamoDB tables sees per-region audit logs. Foundation
  does not ship cross-region aggregation; if a consumer wants a
  global view, they replicate the tables (DynamoDB Global Tables)
  or aggregate to a central log store. The frozen schema's
  `region`/`residencyRegion` fields on `RequestContext` carry the
  per-event region; queries can filter.

## Open questions

- **Streaming subscriptions.** A consumer wants to react to specific
  events (`auth.login` → push notification, `idp.delete` → alert).
  DynamoDB Streams would expose this directly; foundation could
  ship a `subscribe(predicate, handler)` API on top. Not v0.1 — wait
  for the use case.
- **CSV / JSONL export.** Trellis has `audit/csv-export.ts`. Foundation
  could ship `AuditQuery.exportCsv(stream)` / `exportJsonl(stream)`.
  Sugar. Add when the first consumer needs it.

## Future: reader API (not in v0.x)

The query side is **not implemented**. The shipped `AuditStore` is
`put`-only and there is no `AuditQuery` class. The shape below is the
proposed design for when the first consumer wires an audit dashboard;
it is recorded here so the schema decisions (the two GSIs above) stay
documented, but **none of it ships today**.

```typescript
// NOT IMPLEMENTED — proposed reader shape.
export class AuditQuery {
  constructor(store: AuditStore /* a future reader-capable store */);

  /** All events for a tenant, newest-first. */
  byTenant(tenantId: TenantId, options?: AuditQueryOptions): Promise<AuditQueryResult>;

  /** All events by an actor (across tenants for system actors). */
  byActor(
    actor: { kind: "user"; userSub: string } | { kind: "service"; serviceName: string },
    options?: AuditQueryOptions,
  ): Promise<AuditQueryResult>;

  /** All events of a given action, optionally scoped to a tenant. */
  byAction(
    action: AuditAction,
    options?: AuditQueryOptions & { tenantId?: TenantId },
  ): Promise<AuditQueryResult>;
}

export interface AuditQueryOptions {
  readonly from?: Date;
  readonly to?: Date;
  readonly limit?: number; // proposed default 100, max 1000
  readonly cursor?: string;
}

export interface AuditQueryResult {
  readonly events: ReadonlyArray<AuditEvent>;
  readonly cursor?: string; // undefined when complete
}
```

The proposed cursors would be opaque, base64-encoded
`LastEvaluatedKey` blobs from DynamoDB (or `(timestamp, id)` tuples for
the Postgres backend), passed back unchanged. Adding the reader would
also extend the `AuditStore` interface with `query*` methods.
