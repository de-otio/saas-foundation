# 08 — Rate limiting

DynamoDB-backed token bucket. Generic in shape; domain-specific
limits (per-route, per-tenant, per-endpoint) compose on top in the
consumer.

## What it owns

- `DynamoTokenBucketLimiter` — a token-bucket implementation backed
  directly by `DynamoDBClient` + a table name (no KV abstraction).
  Conditional writes give the optimistic-concurrency guarantees the
  algorithm needs.
- `MemoryTokenBucketLimiter` — an in-memory variant for unit tests.
  Exported from the `./rate-limit` sub-path, marked `@beta-test-only`,
  not production-safe.
- A key-construction _convention_ (consumer-supplied prefix + identity
  dimensions: user-id, tenant-id, IP, custom). This is a documented
  convention, not an exported type — the limiter accepts any string
  key. See § Key composition convention.
- `RateLimitResult` — the standard return shape: `{ allowed: boolean,
remaining: number, resetAt: number, retryAfter?: number }`.

## OSS-reuse note

The OSS rate-limiter landscape (`rate-limiter-flexible`,
`@upstash/ratelimit`) is mature, audited, and supports multiple
backends. Foundation owns its own implementation because:

- The DynamoDB-conditional-write shape is straightforward and ports
  verbatim from the existing trellis code; it's a small surface to
  maintain.
- The two viable OSS choices both pull in a different storage
  abstraction (Redis-shaped for `rate-limiter-flexible`,
  Upstash-shaped for `@upstash/ratelimit`) that doesn't compose with
  foundation's `DynamoDBClient`-everywhere posture.

If a future consumer demands a Redis-backed limiter or sliding-window
semantics, the right answer is to wrap the corresponding OSS library
behind the same `RateLimitResult` shape rather than reinvent — but
that consumer hasn't surfaced yet.

## What it does _not_ own

- **Domain-specific limit configuration.** "Comments are 30/minute,
  password resets are 5/hour" lives in the consumer. Foundation
  provides the bucket; the consumer specifies capacity and refill.
- **HTTP middleware.** Foundation does not ship a Hono / Express
  middleware that wraps the limiter. Consumers compose it at their
  edge.
- **Distributed coordination beyond what DynamoDB provides.**
  Token-bucket consistency across concurrent calls depends on
  DynamoDB's atomic-update semantics — `UpdateItemCommand` with a
  `ConditionExpression`. A pure in-memory limiter does not provide
  this; the production limiter is DynamoDB-backed.
- **Distributed-tracing integration.** The limiter logs through
  `getLogger()` (request-scoped, so `requestId`/`tenantId` ride along)
  but does not emit spans.

## Design

### Why token bucket, not sliding window or leaky bucket

Three viable algorithms; token bucket wins on the operational shape
we want:

| Algorithm        | Pros                                                            | Cons                                           |
| ---------------- | --------------------------------------------------------------- | ---------------------------------------------- |
| **Token bucket** | Bursts allowed up to capacity; simple state (count, lastRefill) | Slightly less smooth than leaky bucket         |
| Sliding window   | Tightest enforcement                                            | Requires storing recent timestamps; more state |
| Leaky bucket     | Smooth rate                                                     | No burst tolerance — surprises consumers       |

Token bucket is what trellis already implements. Foundation keeps
the algorithm; the storage layer is DynamoDB, accessed directly via
`DynamoDBClient`.

### `DynamoTokenBucketLimiter`

```typescript
export interface TokenBucketConfig {
  /** Maximum tokens in the bucket. */
  readonly capacity: number;
  /** Tokens added per second. May be fractional. */
  readonly refillRate: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  /** Tokens remaining after this attempt. */
  readonly remaining: number;
  /** Epoch ms at which the bucket will be full again. */
  readonly resetAt: number;
  /** Seconds until the caller should retry. Set when allowed=false. */
  readonly retryAfter?: number;
}

export interface DynamoTokenBucketLimiterOptions {
  readonly tableName: string;
  readonly namespace: string;
  readonly defaultConfig?: TokenBucketConfig;
  /**
   * Behaviour when the key is, or ends with, `:unknown` (typically:
   * client IP could not be derived and `'unknown'` was passed as the
   * dimension value).
   * - `'shared-bucket'` (default): all unknown-key callers share one
   *   bucket. Throughput across legitimate traffic with broken
   *   geolocation degrades, but the service stays available.
   * - `'reject'`: every unknown-key call returns `{ allowed: false }`
   *   without a DynamoDB round-trip. Use when the consumer prefers
   *   fail-closed (e.g., the rate-limit is the only authorization
   *   gate for an unauthenticated endpoint).
   * - `'allow'`: pass-through with no rate limiting. For dev/debug
   *   environments only — do not use in production.
   */
  readonly unknownKeyStrategy?: "shared-bucket" | "reject" | "allow";
}

export class DynamoTokenBucketLimiter {
  constructor(client: DynamoDBClient, options: DynamoTokenBucketLimiterOptions);

  /**
   * Attempt to consume `cost` tokens for `key`. Returns the result;
   * does not throw on rate-limit-exceeded — the caller decides
   * whether to 429 / queue / fail.
   */
  async consume(key: string, cost: number, config?: TokenBucketConfig): Promise<RateLimitResult>;

  /**
   * Peek at the current bucket state without consuming. The result
   * is informational only — between `peek()` and any subsequent
   * `consume()` call, other callers may consume tokens. Do NOT use
   * `peek` as a precondition for `consume`; call `consume` directly
   * and check `allowed` on the returned result.
   */
  async peek(key: string, config?: TokenBucketConfig): Promise<RateLimitResult>;

  /**
   * Reset a bucket (admin tool / test). Removes the row.
   */
  async reset(key: string): Promise<void>;
}
```

The constructor takes a `DynamoDBClient` directly rather than a
`KVNamespace` because the algorithm requires DynamoDB's
`ConditionExpression` for optimistic concurrency — the
Cloudflare-shaped `KVNamespace` interface has no equivalent and the
previous draft's discriminated-union constructor was a leaky
abstraction over that mismatch. Foundation owns this concrete shape;
a future Redis-backed variant would be a separate class
(`RedisTokenBucketLimiter`) implementing the same return type.

### Bucket state in DynamoDB

A single item per key — primary key `<namespace>#<key>`, with the
bucket state and a TTL attribute:

```json
{
  "tokens": 17.5,
  "lastRefillMs": 1748234415000
}
```

`tokens` is a float because the refill rate can be fractional and we
don't want quantisation errors over time. On each `consume`:

1. Read the item (`GetItemCommand`).
2. Compute `elapsed = nowMs - state.lastRefillMs`.
3. Compute `newTokens = min(capacity, tokens + elapsed * refillRate / 1000)`.
4. If `newTokens >= cost`: subtract `cost`, write back, return `{ allowed: true, ... }`.
5. Else: write back the refilled (but unconsumed) state, return
   `{ allowed: false, retryAfter: ... }`.

The bucket state is persisted with a DynamoDB `ttl` attribute (derived
from `capacity / refillRate + safety-margin` seconds) — once the bucket
is fully refilled and idle, DynamoDB expires the row. Re-creating it on
the next request costs one extra write but bounds storage growth.

### Concurrency

Token bucket is the algorithm; making it correct under concurrent
calls is the implementation challenge. `DynamoTokenBucketLimiter`
uses **optimistic concurrency** via `UpdateItemCommand` with a
`ConditionExpression` matching the previous `lastRefillMs`. On
conflict, the limiter retries up to 3 times with exponential backoff
(10 / 20 / 40 ms). Tunables are not exposed in the public API —
under-tuning leads to false-negative rate-limits (returning
`allowed: false` when the bucket had tokens), and the defaults are
conservative enough that no realistic consumer load surfaces the
limit.

The `MemoryTokenBucketLimiter` test variant uses a single in-process
`Map` and a mutex; it is **not** safe across processes or threads.
It exists for unit tests that want a limiter without LocalStack and
is marked `@beta-test-only` for the same reason as the in-memory KV
store ([`./02-cloud-primitives.md`](./02-cloud-primitives.md)).

### Key composition convention

Rate-limit keys encode identity dimensions. The conventional shape:

```
ratelimit:<scope>:<dim1>:<v1>:<dim2>:<v2>
```

Foundation does not enforce this; it's a convention documented for
consumer consistency. The limiter is happy with any string key.

Example consumer code:

```typescript
import { DynamoTokenBucketLimiter, getRequestContext } from "@de-otio/saas-foundation";

const limiter = new DynamoTokenBucketLimiter(ddb, {
  tableName: "app-dev",
  namespace: "ratelimit",
  defaultConfig: { capacity: 30, refillRate: 0.5 }, // 30 burst, refills 30/min
  unknownKeyStrategy: "shared-bucket",
});

async function rateLimitForComment(req: Request): Promise<RateLimitResult> {
  const ctx = getRequestContext();
  const userId = ctx?.principal?.kind === "user" ? ctx.principal.userSub : null;
  const ip = ctx?.clientIp;

  // Prefer user-keyed; fall back to IP-keyed
  const key = userId
    ? `ratelimit:comment:user:${userId}`
    : `ratelimit:comment:ip:${ip ?? "unknown"}`;

  return limiter.consume(key, 1);
}
```

The trellis pattern of "prefer userId > sessionId > email > IP" is
consumer-side composition; foundation does not encode the priority.

**The `'unknown'` IP shared-bucket failure mode.** When
`trustedClientIp` returns `'unknown'`
([`./11-ip-derivation.md`](./11-ip-derivation.md)) — typically because
the trusted-proxy header is missing or malformed — every such
caller's key collapses to `ratelimit:comment:ip:unknown`. With
`unknownKeyStrategy: 'shared-bucket'` (default), all unknown-key
callers share one bucket; legitimate traffic with broken
geolocation may be throttled, but the service stays available and
an attacker cannot trivially evade rate-limiting by stripping
proxy headers (the shared bucket is itself limited). With
`unknownKeyStrategy: 'reject'`, every unknown-key call returns
`{ allowed: false }` — pick this when rate-limiting is the only
authorization gate on an unauthenticated endpoint (e.g., a
public-facing magic-link request endpoint) and the consumer would
rather fail-closed. The third value, `unknownKeyStrategy: 'allow'`,
passes unknown-key calls through with no rate limiting; it is for
dev/debug environments only and must not be used in production.

### Domain-specific composition

Trellis composes multiple limiter checks per request (global limit +
per-user limit + per-operation limit; see
`database-rate-limiter.ts`). Foundation does not ship this
composition — consumers chain `consume` calls themselves:

```typescript
const globalResult = await limiter.consume("ratelimit:global:writes", 1, {
  capacity: 10_000,
  refillRate: 100,
});
if (!globalResult.allowed) return rateLimited(globalResult);

const userResult = await limiter.consume(`ratelimit:writes:user:${userId}`, 1, {
  capacity: 100,
  refillRate: 1,
});
if (!userResult.allowed) return rateLimited(userResult);
```

A `chained` helper would be sugar; we ship it if a consumer asks.

### Logging and observability

Every `consume` call emits a debug-level log line (via `getLogger()`)
with the key, cost, and result. `allowed: false` results upgrade to
warn-level. Consumers wanting metrics (rate-limit-hit counts) wrap
the limiter with their own metric-emitting adapter — foundation
does not own metrics.

## TypeScript surface

```typescript
export interface TokenBucketConfig {
  readonly capacity: number;
  readonly refillRate: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: number;
  readonly retryAfter?: number;
}

export interface DynamoTokenBucketLimiterOptions {
  readonly tableName: string;
  readonly namespace: string;
  readonly defaultConfig?: TokenBucketConfig;
  readonly unknownKeyStrategy?: "shared-bucket" | "reject" | "allow";
}

export class DynamoTokenBucketLimiter {
  constructor(client: DynamoDBClient, options: DynamoTokenBucketLimiterOptions);
  consume(key: string, cost: number, config?: TokenBucketConfig): Promise<RateLimitResult>;
  peek(key: string, config?: TokenBucketConfig): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
}

/** @beta-test-only — exported from the ./rate-limit sub-path. */
export class MemoryTokenBucketLimiter {
  constructor(options?: {
    defaultConfig?: TokenBucketConfig;
    unknownKeyStrategy?: "shared-bucket" | "reject" | "allow";
  });
  consume(key: string, cost: number, config?: TokenBucketConfig): Promise<RateLimitResult>;
  peek(key: string, config?: TokenBucketConfig): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
}
```

## Caveats

- **Optimistic-concurrency retry budget.** Under sustained
  high-conflict load (1000s of concurrent consumers on the same
  key), the 3-retry limit can return false negatives ("rate-limited"
  when the bucket actually had tokens). Real life: most rate-limit
  keys partition fine. If a consumer hits this, dedicated keys per
  region/shard help.
- **Clock skew.** The bucket's `lastRefillMs` is server-side; clock
  drift between instances can produce a slight under- or over-
  refill across boundary moments. The refill formula is monotonic
  in absolute time, so total bucket capacity is preserved over
  long windows.
- **`reset(key)` is a footgun.** Useful for admin tools and tests;
  dangerous in production. Foundation does not gate it (the consumer
  should). Documented.
- **`MemoryTokenBucketLimiter` is not production-safe.** It uses a
  per-process `Map`; cross-process callers see independent buckets.
  Marked `@beta-test-only` in the export; consumers who put it in a
  prod path are on their own.

## Open questions

- **Built-in middleware adapters for Hono / Express?** Consumer
  preference suggests Hono (per the trellis migration plan). A
  `honoRateLimit({ limiter, keyFn })` middleware is one screen of
  code. Probably ship it once trellis lands on Hono; not v0.1.
- **Sliding-window option for tighter limits?** Some endpoints
  (password reset, account recovery) want strict no-burst limits.
  A `SlidingWindowLimiter` class shares the same `RateLimitResult`
  return shape; the consumer picks. Add when first asked.
- **Lockout-vs-throttle semantics.** Repeated failed logins might
  want a lockout (return error for N minutes after 5 failures) rather
  than a continuous throttle. That's a different abstraction
  (`LockoutTracker`); not a rate-limit primitive. Consumer-side.
