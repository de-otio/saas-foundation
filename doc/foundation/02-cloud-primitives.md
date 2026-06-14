# 02 — Cloud primitives

`kv`, `queue`, and `storage` — three shims that implement Cloudflare's
runtime interfaces (`KVNamespace`, `Queue`, `R2Bucket`) over AWS
primitives (DynamoDB, SQS, S3). The pattern trellis already follows;
foundation packages it.

## What it owns

Three classes, one per primitive, plus the TypeScript interface
declarations they implement:

- `DynamoKv implements KVNamespace` — DynamoDB single-table KV.
- `SqsQueue<T> implements Queue<T>` — SQS message producer.
- `S3Storage implements R2Bucket` — S3 object store with presigned
  URLs.

The Cloudflare-compat interfaces themselves (`KVNamespace`, `Queue`,
`R2Bucket`, `R2Object`, etc.) live in `src/kv/cloudflare-types.ts`,
`src/queue/cloudflare-types.ts`, etc. They are local declarations of
the Cloudflare runtime types, not a dep on `@cloudflare/workers-types`
— foundation does not want a Cloudflare types dep just to share a
shape.

## Why Cloudflare-compat

Two reasons:

- **Backend swap is mechanical.** If a consumer later moves a slice
  to Cloudflare Workers, the call sites do not change — only the
  factory that instantiates the binding does. Trellis was originally
  Workers-shaped and migrated to AWS; the interface survived intact.
- **The interface is small and well-documented.** Cloudflare's
  `KVNamespace` has nine methods. Inventing our own equivalent of the
  same shape costs design time for no benefit.

This is **not** a multi-cloud promise. We do not test against the
actual Cloudflare runtime, and we will not ship a Workers binding for
foundation. The interface is a refactor affordance only — repeated in
[`../01-scope-and-philosophy.md`](../01-scope-and-philosophy.md) so the
constraint is visible to every reader.

## Design

### Construction: SDK client injected, table/bucket/queue url injected

No module-level `new DynamoDBClient(...)`. The consumer creates the
SDK client at process start (one DynamoDB client per region, typically)
and passes it in:

```typescript
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoKv } from "@de-otio/saas-foundation/kv";

const ddb = new DynamoDBClient({ region: "eu-central-1" });
const rateLimitKv = new DynamoKv(ddb, {
  tableName: "app-dev",
  namespace: "ratelimit",
});
```

Trellis's current code uses a module-scoped client (`const
dynamoClient = new DynamoDBClient(...)` at module top); the foundation
port replaces this with the constructor argument. The decoupling step
is mechanical but it is the single biggest decoupling difference
between the trellis source and the foundation destination.

### `DynamoKv` — KV over a single table

Single-table pattern: one DynamoDB table, partition key `pk`, sort
key `sk`. Each `DynamoKv` instance is a _namespace_ — a prefix
applied to `pk`:

```
pk: "ratelimit:user-123-login-attempts"
sk: "v"
value: "5"
ttl: 1735689600  (epoch seconds)
```

`sk` is constant (`"v"`) because the KV interface has no notion of
composite keys. Future shim modules that need them (e.g., a
KV-with-secondary-index variant) get their own class.

#### TypeScript surface

```typescript
export interface KvNamespaceOptions {
  readonly tableName: string;
  readonly namespace: string;
  /**
   * Optional shared-secret cursor signing for pagination. When set,
   * `list()` returns HMAC-signed cursors so a client cannot forge an
   * `ExclusiveStartKey`. Trellis uses this for feed pagination; for
   * pure-KV uses it is optional.
   */
  readonly cursorSecret?: string;
}

export class DynamoKv implements KVNamespace {
  constructor(
    private readonly client: DynamoDBClient,
    private readonly options: KvNamespaceOptions,
  ) {}

  async get(key: string, type?: "text" | "json"): Promise<string | null>;
  async getWithMetadata<T>(key: string): Promise<{ value: string | null; metadata: T | null }>;
  async put(key: string, value: string | ArrayBuffer, options?: KvPutOptions): Promise<void>;
  async delete(key: string): Promise<void>;
  async list(options?: KvListOptions): Promise<KvListResult>;
}

export interface KvPutOptions {
  readonly expiration?: number; // absolute epoch seconds
  readonly expirationTtl?: number; // relative seconds from now
  readonly metadata?: Record<string, unknown>;
}

export interface KvListOptions {
  readonly prefix?: string;
  readonly limit?: number; // default 1000
  readonly cursor?: string; // opaque, HMAC-signed if cursorSecret set
}

export interface KvListResult {
  readonly keys: ReadonlyArray<{ name: string; expiration?: number }>;
  readonly list_complete: boolean;
  readonly cursor?: string;
}
```

#### TTL semantics

Two ways to express TTL — relative (`expirationTtl`) and absolute
(`expiration`). Both translate to a DynamoDB `ttl` numeric attribute
in epoch seconds. The shim filters expired items on read because
DynamoDB's TTL expiry is best-effort (up to ~48h late under load).
Items that have passed their TTL but DynamoDB has not deleted yet
return `null` from `get()` — this is the behaviour trellis depends on
for rate-limit correctness.

#### Cursor signing

Pagination cursors are HMAC-SHA256-signed when `cursorSecret` is
provided. Trellis's `dynamodb-kv.ts` already implements this; the
shim ports verbatim:

- Cursor format: `<base64-encoded-LastEvaluatedKey>.<hex-hmac>`.
- Unsigned cursors (no signature suffix) fail structure validation
  and the shim treats them as "no cursor" (restart from the
  beginning). This is the safe-fail mode for tampered cursors — the
  client sees inconsistent paging rather than an error, but cannot
  inject arbitrary `ExclusiveStartKey` values.
- Allowed keys in a decoded cursor: `{ pk, sk }` only. Anything else
  fails parse.

Cursor signing is opt-in. A consumer using `DynamoKv` as a pure
feature-toggle cache does not need it; a consumer paginating
user-controlled queries does.

### `SqsQueue<T>` — message producer

A thin producer-only wrapper around `SendMessageCommand` /
`SendMessageBatchCommand`. Consumers (workers) sit on the receiving
end via their own framework (SQS Lambda triggers, the Bun SQS poller,
etc.) — foundation does not own the consumer side.

#### TypeScript surface

```typescript
export interface Queue<T = unknown> {
  send(message: T, options?: { delaySeconds?: number }): Promise<void>;
  sendBatch(messages: Array<{ body: T; delaySeconds?: number }>): Promise<void>;
}

export class SqsQueue<T = unknown> implements Queue<T> {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async send(message: T, options?: { delaySeconds?: number }): Promise<void>;
  async sendBatch(messages: Array<{ body: T; delaySeconds?: number }>): Promise<void>;
}
```

Serialisation is JSON. Binary messages or alternative encodings are
out of scope — the consumer wraps if they need it.

Trellis's existing code records SQS sends via a `CostAccumulator`
singleton; the foundation port drops this. Consumers that want cost
accounting wrap the queue at their level.

### `S3Storage` — object store with R2 compatibility

The widest interface: `put`, `get`, `delete`, `list`, `head`, plus
the `getPresignedUploadUrl` extension for direct client uploads.

#### TypeScript surface

```typescript
export interface R2Bucket {
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<R2Object>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(key: string | string[]): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<R2ListResult>;
  head(key: string): Promise<R2Object | null>;
}

export class S3Storage implements R2Bucket {
  constructor(
    private readonly client: S3Client,
    private readonly bucketName: string,
  ) {}

  async getPresignedUploadUrl(
    key: string,
    contentType: string,
    expiresInSeconds?: number,
  ): Promise<string>;
}
```

`R2Object` and `R2ObjectBody` shapes are reproduced from Cloudflare's
runtime types (key, size, etag, uploaded, optional httpMetadata /
customMetadata, plus `arrayBuffer()` / `text()` reader methods on the
body type).

#### Streaming

`get()` returns an `R2ObjectBody`. There is exactly one streaming
contract: the `body` field is a `ReadableStream` and is the canonical
way to consume the payload. The `arrayBuffer()` and `text()` helpers
exist for convenience but they are **buffer-once-internally** — they
read `body` to completion and return a `Promise`, which invalidates
the stream for subsequent reads.

```typescript
async get(key: string): Promise<R2ObjectBody | null> {
  const result = await this.client.send(
    new GetObjectCommand({ Bucket: this.bucketName, Key: key }),
  );
  if (!result.Body) return null;

  // The web-stream is the single source. arrayBuffer() / text() are
  // implemented by reading this stream once.
  const body = result.Body.transformToWebStream();   // SDK v3 web-stream
  let consumed = false;

  return {
    key,
    size: result.ContentLength ?? 0,
    etag: result.ETag ?? '',
    uploaded: result.LastModified ?? new Date(),
    httpMetadata: { contentType: result.ContentType },
    customMetadata: result.Metadata,
    body,
    arrayBuffer: async () => {
      if (consumed) throw new Error('R2ObjectBody.body already consumed');
      consumed = true;
      return new Response(body).arrayBuffer();
    },
    text: async () => {
      if (consumed) throw new Error('R2ObjectBody.body already consumed');
      consumed = true;
      return new Response(body).text();
    },
  };
}
```

The picked contract: **`body` is the streaming path**; `arrayBuffer()`
and `text()` buffer-once. Calling either invalidates `body` and a
second call (to either helper or to `body`'s reader) throws. The
alternative considered was dropping the helpers entirely and forcing
`new Response(stream).arrayBuffer()` at every callsite; rejected
because every existing trellis call uses `text()` or `arrayBuffer()`
and the helpers cost two lines of glue.

This requires `@aws-sdk/client-s3@^3.700.0` (the SDK version that
ships `transformToWebStream`).

#### Presigned upload URLs

Used by trellis's media-upload flow. Same shape, ported verbatim:

```typescript
async getPresignedUploadUrl(
  key: string,
  contentType: string,
  expiresInSeconds = 60,
): Promise<string> {
  return getSignedUrl(
    this.client,
    new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn: expiresInSeconds },
  );
}
```

The presigner is `@aws-sdk/s3-request-presigner`. The `contentType`
parameter is enforced at signing time — the client must upload with a
matching `Content-Type` header or S3 rejects the request. This is the
canonical content-type-pinning pattern.

## Retry and circuit-breaking

DynamoDB, SQS, and S3 all surface transient failures (throttling,
intermittent 5xx). Foundation uses `cockatiel` _internally_ to wrap
each SDK call, but the configuration is not part of the public API:

```typescript
// internal to packages/foundation/src/_internal/retry.ts
import { circuitBreaker, retry, handleAll, ConsecutiveBreaker } from "cockatiel";

export const transientRetry = retry(handleAll, {
  maxAttempts: 3,
  backoff: new ExponentialBackoff({ initialDelay: 100, maxDelay: 2000 }),
});
```

Per the "Don't reinvent OSS" principle
([`../01-scope-and-philosophy.md`](../01-scope-and-philosophy.md#design-principles)),
consumers who want to customise retry policy depend on cockatiel
directly and wrap the shim. The shim's internal policy is opinionated
and intentionally hidden.

## Caveats

- **DynamoDB throughput.** Single-table-with-prefix pattern means
  every namespace shares the table's WCU/RCU. Consumers with hot
  namespaces (rate-limit on a single endpoint) should provision
  on-demand capacity or use a dedicated table per namespace. The
  shim does not abstract over this — the consumer chooses the table.
- **No write-batching.** `put()` is one-write-per-call. Bulk import
  paths should batch at the consumer level via the SDK directly.
- **`R2Object.etag` for `put()` returns empty string.** The S3 SDK's
  `PutObjectCommand` does return an ETag, but only via the response
  headers (`result.ETag`). Trellis's current port drops it; the
  foundation port retains it.
- **`R2ListResult.cursor` is opaque between implementations.** A
  cursor returned by `DynamoKv.list()` is not portable to a
  Cloudflare KV namespace. The interface contract is "feed it back
  to _this_ implementation," not "portable across implementations."
- **No batched delete in `S3Storage.delete([])`.** Current port uses
  `Promise.all(map(DeleteObjectCommand))`. For large key arrays
  (>100 keys), batch via `DeleteObjectsCommand`. Tracked as a
  follow-up.

## Testing

`aws-sdk-client-mock` (the vitest variant) for unit tests. Integration
tests run against LocalStack via Docker Compose. The trellis test
suite uses the same pattern; the test setup ports directly.

A `MemoryKv` (in `src/kv/memory.ts`) provides an in-memory
`KVNamespace` for downstream module tests (audit, rate-limit) and for
consumer tests that need a KV without LocalStack. It is exported from
the `./kv` sub-path and marked `@beta-test-only` in its JSDoc — i.e.,
the test-utility surface is public for consumer reuse, but the
contract is "don't ship this in prod and don't open issues asking for
production-shaped features (concurrency primitives, multi-process
visibility, etc.)." This matches the posture for
`MemoryFeatureToggleStore`
([`./10-feature-toggles.md`](./10-feature-toggles.md)) — both
in-memory stores are exported under the same beta-test-only
discipline.

## Open questions

- **Should `DynamoKv` support composite keys via a second
  constructor option?** Trellis's current shim does not; foundation
  could expose `{ pk, sk }` directly. Leaning: no for v0.1 — the
  prefix-pattern works for every existing use case, and a composite-
  key variant is a different class (`DynamoTable` or similar) rather
  than an extension of `DynamoKv`.
- **Should `SqsQueue` expose a receiver shim?** The Cloudflare `Queue`
  interface is producer-only; the consumer side is via Workers'
  `queue` handler. SQS consumers in our world run as Lambda triggers
  or worker processes. The shim is producer-only on purpose; if a
  receiver shim ever makes sense (a `QueueConsumer` abstraction over
  Lambda/long-polling), it ships as a separate module. Not v0.1.
- **`S3Storage` and KMS-encrypted buckets.** AWS supports SSE-KMS
  per-object; the shim does not currently propagate `SSEKMSKeyId`.
  Consumers that need it should pass it via a new option on
  `KvPutOptions`-equivalent for storage. Tracked as additive.
