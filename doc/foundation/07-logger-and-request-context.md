# 07 — Logger and request context

Structured logging via pino, plus the AsyncLocalStorage carrier for
`RequestContext` (defined in
[`../04-shared-vocabulary.md`](../04-shared-vocabulary.md#requestcontext)).
Two modules in one doc because they are tightly coupled: every log
line should pick up the ambient `requestId`, `tenantId`, and
`traceId` from the context without the caller passing them
explicitly.

## What it owns

- `Logger` — a pino-backed shape with six levels (`fatal`, `error`,
  `warn`, `info`, `debug`, `trace`) plus a `child(bindings)` method.
  Trellis's current shape uses five (no `fatal`); the foundation port
  adds it at no cost.
- `getLogger()` — pulls a per-request logger out of the current
  `RequestContext`, falling back to a root logger when none is set
  (e.g., during process startup).
- `createRequestContext`, `runWithRequestContext`, `getRequestContext`
  — the ALS lifecycle.
- A small set of standard log shapes (`{ level, time, msg, requestId,
tenantId, traceId, ... }`) — pino's JSON output by default,
  prettified in development via `pino-pretty`.
- Sanitisation via pino's `redact.paths`, with a default glob list
  for known-sensitive keys (see § Sanitisation).

## What it does _not_ own

- **Log shipping.** Foundation writes to `stdout`. The container /
  Lambda runtime ships to CloudWatch Logs / Datadog / Loki / whatever
  — that's deployment-side. Foundation never instantiates a network
  transport.
- **Observability platform integrations** (OpenTelemetry tracing
  spans, APM agents, etc.). pino has community transports; consumers
  wire those at the process entry point.
- **A `Logger.getInstance()` singleton.** Trellis ships one; the
  foundation port retires it. Consumers thread the logger through
  constructor injection or pull it from `RequestContext`.

## Why pino

Resolved from the top-level docs' open question (logger choice).
pino because:

- **JSON-by-default, fast.** Sub-microsecond per log line on modern
  Node. The competing choices (winston, bunyan) are 5–20× slower —
  measurable on a hot HTTP path.
- **Child loggers are first-class.** `logger.child({ requestId, tenantId })`
  is the canonical pattern; we re-use it for the per-request logger.
- **Ecosystem is alive.** pino-pretty, pino-http, pino-elasticsearch
  exist; if a consumer wants to use them, foundation does not block.
- **Single hard dep.** `pino` itself; no transports bundled (those
  are consumer-side).

The "Don't reinvent OSS" principle
([`../01-scope-and-philosophy.md`](../01-scope-and-philosophy.md#design-principles))
makes this call straightforward — pino is the mature OSS solution to
"fast structured logging in Node," and a hand-rolled wrapper around
`console.log` (which trellis currently has) does not graduate.

## Design

### Logger shape

```typescript
export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

export interface Logger {
  fatal(obj: object, msg?: string): void;
  fatal(msg: string): void;
  error(obj: object, msg?: string): void;
  error(msg: string): void;
  warn(obj: object, msg?: string): void;
  warn(msg: string): void;
  info(obj: object, msg?: string): void;
  info(msg: string): void;
  debug(obj: object, msg?: string): void;
  debug(msg: string): void;
  trace(obj: object, msg?: string): void;
  trace(msg: string): void;

  child(bindings: Record<string, unknown>): Logger;
  level: LogLevel;
}
```

This is intentionally pino's existing surface, re-exported as our
`Logger` type. We are not wrapping pino in an abstraction — consumers
of the type know they are dealing with a pino-shaped logger.

`Logger.fatal` is new vs trellis's current shape. Worth having because
`fatal` (level 60) is the conventional level for "process is dying;
this is the last thing it will say." trellis's current
`error`/`warn`/`info`/`debug`/`trace` ladder collapses fatal into
error; pino's adds the distinction at no cost.

### Root logger and child loggers

The root logger lives at the package's `_internal/root-logger.ts`:

```typescript
import pino, { type Logger as PinoLogger } from "pino";

let rootLogger: PinoLogger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: process.env.SERVICE_NAME ?? "unknown" },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(process.env.NODE_ENV !== "production" && {
    transport: { target: "pino-pretty" },
  }),
});
```

The consumer can replace it at startup:

```typescript
import { configureRootLogger } from "@de-otio/saas-foundation";

configureRootLogger({
  level: "info",
  base: { service: "myapp", version: "1.2.3" },
  redact: ["req.headers.authorization", "*.password"],
});
```

This is the one place where foundation has process-global state by
design. The alternative — threading the logger through every
constructor — is technically purer but ergonomically a non-starter,
and the ALS carrier handles the per-request case cleanly anyway.

### Per-request loggers via `RequestContext`

The request-context middleware constructs a child logger with the
request's bindings and stores it on the context. The logger lives on
a symbol-keyed field, attached _before_ `Object.freeze` so the freeze
covers it:

```typescript
// foundation-side (inside createRequestContext)
const requestLogger = rootLogger.child({
  requestId: input.requestId,
  ...(input.tenantId && { tenantId: input.tenantId }),
  ...(input.traceId && { traceId: input.traceId }),
});

// Step 1: build the public-shape object (typed as RequestContext).
const draft: RequestContext = { ...input };

// Step 2: attach the per-request logger on a private symbol-keyed
// field. defineProperty is required (rather than `draft[LOGGER_KEY] = ...`)
// because the property is non-enumerable and not part of the public
// RequestContext interface — we don't want it serialising or showing
// up in `Object.keys(ctx)`.
Object.defineProperty(draft, LOGGER_KEY, {
  value: requestLogger,
  enumerable: false,
  writable: false,
  configurable: false,
});

// Step 3: freeze. This must run AFTER defineProperty — Object.freeze
// rejects subsequent property additions, so the order matters.
const context = Object.freeze(draft);

contextStorage.run(context, ...);
```

The `defineProperty`-before-`Object.freeze` order is load-bearing.
If `freeze` runs first, the subsequent `defineProperty` call throws
in strict mode (and silently no-ops in sloppy mode) — neither is
acceptable. `getLogger()` reads `context[LOGGER_KEY]`; consumers
cannot reach it because they don't have the symbol.

Callers retrieve it via `getLogger()`:

```typescript
import { getLogger } from "@de-otio/saas-foundation";

async function handlePostCreate(req: Request) {
  const log = getLogger();
  log.info({ event: "post.create.start" }, "creating post");
  // ...
}
```

`getLogger()` returns the request-scoped logger if one exists, the
root logger otherwise. Code that runs outside any request (startup,
scheduled jobs) gets the root logger — no errors thrown.

### `RequestContext` lifecycle

```typescript
import { AsyncLocalStorage } from "node:async_hooks";

const contextStorage = new AsyncLocalStorage<RequestContext>();

export interface CreateRequestContextInput {
  readonly requestId: string;
  readonly startedAt?: number; // default: Date.now()
  readonly tenantId?: TenantId;
  readonly principal?: Principal;
  readonly traceId?: string;
  readonly region?: string;
  readonly residencyRegion?: string;
  readonly clientIp?: string;
}

export function createRequestContext(input: CreateRequestContextInput): RequestContext;

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T;

export function runWithRequestContext<T>(context: RequestContext, fn: () => Promise<T>): Promise<T>;

export function getRequestContext(): RequestContext | null;
```

The middleware pattern at the consumer's edge:

```typescript
import { ulid } from 'ulid';

app.use(async (c, next) => {
  const context = createRequestContext({
    requestId: c.req.header('x-request-id') ?? ulid(),
    tenantId: await resolveTenant(...),
    clientIp: trustedClientIp(c.req.raw, env),
    traceId: c.req.header('traceparent'),
  });
  return runWithRequestContext(context, () => next());
});
```

Why explicit `createRequestContext` + `runWithRequestContext` rather
than a single function: separating creation from lifecycle lets a
caller construct a context, log it, and _then_ enter the scope —
useful for testing and for re-entering a context after an
explicit cross-async-boundary handoff (queue consumer running on a
worker thread, etc.).

### `setRequestContext` — early-request replacement only

The frozen `RequestContext` is `Object.freeze`d at construction;
mutation mid-request is forbidden
([`../04-shared-vocabulary.md`](../04-shared-vocabulary.md#requestcontext)).
But late-bound fields (`principal` populated after auth verification,
`traceId` populated by a tracing middleware) need to land on the
context somewhere. The mechanism is **replacement, not mutation**:
`setRequestContext(next)` swaps the ALS entry to a fresh frozen
object.

```typescript
// In an auth middleware that runs after tenant resolution but
// before the route handler dispatches.
const ctx = getRequestContext();
if (!ctx) throw new Error("auth middleware ran outside request scope");

const verified = await verifyJwt(token);
setRequestContext({
  ...ctx,
  principal: { kind: "user", userSub: verified.sub, sessionId: ctx.sessionId! },
});
```

The runtime guard: `setRequestContext` throws
`RequestContextPhaseError` if called once handler dispatch has
begun. Foundation marks the phase transition by setting an internal
flag on the ALS entry when `runWithRequestContext`'s wrapped function
starts; the flag is set after the auth-and-tenant chain has had its
chance to replace, but before the route handler runs. Consumer
middleware uses `setRequestContext` freely during the early-request
phase and treats the guard as the contract for "stop trying to
amend context now."

The semantic split — _replacement_ permitted during a defined window,
_mutation_ never permitted — keeps the "frozen object" property
honest while letting the request-entry chain do useful work.

### Declaration merging extensibility

The frozen `RequestContext` is extensible via TS declaration merging
([`../04-shared-vocabulary.md`](../04-shared-vocabulary.md#requestcontext)):

```typescript
// consumer code
declare module "@de-otio/saas-foundation" {
  interface RequestContext {
    readonly featureFlags?: ReadonlySet<string>;
    readonly preferredLocale?: string;
  }
}

// The consumer's middleware then populates these on the context input.
```

Foundation's internal code reads only the frozen fields; consumer
fields ride through.

### Sanitisation

pino's `redact` option handles structured redaction at config time.
Foundation's default `paths` list, applied unless the consumer
overrides at `configureRootLogger`:

```typescript
const DEFAULT_REDACT_PATHS = [
  "*.password",
  "*.token",
  "*.secret",
  "*.access_token",
  "*.refresh_token",
  "*.authorization",
  "*.cookie",
  "*.session",
  "*.api_key",
];

configureRootLogger({
  redact: {
    paths: DEFAULT_REDACT_PATHS,
    censor: "[REDACTED]",
  },
});
```

The path globs are pino's wildcard syntax: `*.password` matches any
nested `password` key at any depth. Consumers extend by passing a
wider `paths` array at `configureRootLogger` time — provide the full
list, including the defaults, since the call replaces rather than
merges.

The default list intentionally diverges from the audit module's PII
filter denylist
([`./06-audit-log.md`](./06-audit-log.md#pii-filter)) because the two
have different shapes: the audit filter sees a flat
`metadata: Record<string, unknown>` and matches top-level keys; the
logger sees deeply-nested objects and matches by glob path. Keeping
the two lists conceptually aligned (same sensitive-key concepts) but
mechanically separate (different match shapes) is intentional — the
previous draft's "same denylist as audit PII filter" handwave hid
the shape difference.

The trellis `Logger.sanitize(data)` method (which recursively walks
an object replacing known-sensitive keys) does **not** graduate.
pino's `redact` is the right shape — declarative, configured once,
applied to every log line without the call-site needing to remember.

### Compatibility with the foundation `Logger` from other modules

Other foundation modules (audit, secrets, etc.) accept an optional
`logger?: Logger` constructor argument so tests can inject a captured
logger. When absent, they call `getLogger()` to pick up the ambient
one. This is the constructor-injection pattern, applied to logging:

```typescript
// inside packages/foundation/src/audit/index.ts
export class AuditLog {
  private readonly logger: Logger;

  constructor(store: AuditStore, options?: AuditLogOptions) {
    this.logger = options?.logger ?? getLogger();
  }
}
```

This composes cleanly: in a request scope, `getLogger()` returns the
request-scoped child (with `requestId` baked in); outside a request,
the root logger.

## TypeScript surface

```typescript
// Logger and LogLevel are NOT in the frozen set (see
// ../../04-shared-vocabulary.md). They live in this module
// (foundation/src/logger/), and downstream modules import them
// directly — audit (layer 3) importing Logger (layer 1) is
// allowed by the layering rule. The frozen set is reserved for
// cross-package persisted-shape types where churn ripples; logger
// is foundation-internal and can evolve.
export type { Logger, LogLevel } from "./types.js";
export function configureRootLogger(options: pino.LoggerOptions): void;
export function getLogger(): Logger;
export function createLogger(bindings: Record<string, unknown>): Logger;

// Request context (RequestContext / Principal types live in
// foundation/src/types/frozen/request-context.ts — see
// `../04-shared-vocabulary.md`)
export type { RequestContext, Principal } from "../types/frozen/request-context.js";
export function createRequestContext(input: CreateRequestContextInput): RequestContext;
export function runWithRequestContext<T>(
  context: RequestContext,
  fn: () => T | Promise<T>,
): T | Promise<T>;
export function getRequestContext(): RequestContext | null;
/**
 * Permitted only during the early-request phase (after tenant
 * resolution / auth verification, before handler dispatch). Throws
 * if called once the handler has begun. See
 * `../04-shared-vocabulary.md#requestcontext`.
 */
export function setRequestContext(context: RequestContext): void;

// Test utilities (exported from `./request-context` only, not from
// the package barrel)
export function createTestRequestContext(input: {
  readonly requestId?: string;
  readonly tenantId?: TenantId;
  readonly principal?: Principal;
  readonly logger?: Logger; // override the per-request logger
}): RequestContext;
```

`createTestRequestContext` is the test-only ergonomic helper for
constructing a frozen `RequestContext` with a captured logger
attached on the symbol-keyed field. Without it, tests would need to
reach into the internal `LOGGER_KEY` symbol — which is intentionally
not exported — to inject a logger they can assert against. The
helper is exported from `@de-otio/saas-foundation/request-context`
only and is `@beta-test-only` in its JSDoc, matching the posture for
the in-memory KV store
([`./02-cloud-primitives.md`](./02-cloud-primitives.md)) and
`MemoryFeatureToggleStore`
([`./10-feature-toggles.md`](./10-feature-toggles.md)).

## Caveats

- **ALS overhead.** AsyncLocalStorage adds ~1–2µs per async-context
  switch in Node 24. For HTTP request scopes this is negligible
  against any I/O work. For very hot inner loops, callers can
  capture the context once and pass the logger as an argument.
- **`getLogger()` returns the root logger outside a request scope.**
  A common bug shape: code that _thought_ it was inside a request
  but wasn't (e.g., a scheduled job) emits logs without
  `requestId`/`tenantId`. The mitigation is the standard pino-side
  `base` field (`service`, `env`) which always shows up — so logs
  are at least identifiable as coming from the right service. The
  alternative — throwing in `getLogger()` outside a request — is too
  brittle.
- **`runWithRequestContext` does not handle thrown errors specially.**
  If the wrapped function throws, the error propagates and the
  context unwinds normally. No automatic logging of the error;
  consumer middleware does that.
- **Context propagation across `setImmediate` / `setTimeout` works.**
  ALS uses async-hooks, which tracks these. Across worker-thread
  boundaries it does _not_ work — the consumer reconstructs the
  context on the receiving side via `runWithRequestContext`.
- **`configureRootLogger` is process-global.** Calling it twice is
  a no-op after the first call (the second call's options are
  ignored, with a warn-level message). This prevents accidental
  reconfiguration mid-process while still allowing the consumer to
  set things up once at startup.

## Open questions

- **OpenTelemetry integration?** Not v0.1. Pattern would be: foundation
  reads `traceparent`/`tracestate` headers into `RequestContext` and
  honours them; consumers wanting full OTel install
  `@opentelemetry/api` and the SDK themselves. Foundation does not
  ship OTel as a dep.
- **Log-level toggle per tenant / per request?** Tempting for
  debugging — bump a single user's session to `debug` without
  redeploying. Achievable via a runtime check in
  `createRequestContext` that constructs the child with a different
  level. Not v0.1; document the pattern.
- **`pino.transport()` as a foundation-default for production?**
  Tempting (one less thing the consumer has to wire). Counter: the
  transport choice depends on the deployment substrate
  (CloudWatch / Datadog / etc.); shipping a default would be wrong
  half the time. Stick with stdout; consumer wires transport in
  their `configureRootLogger` call.
- **Should `RequestContext` carry a `Logger` field publicly?**
  Currently it's on a private symbol so consumers retrieve it via
  `getLogger()`. Putting it on the public type would let consumers
  destructure (`const { logger } = getRequestContext()`). Counter:
  the _symbol_ is a deterrent against passing the logger across
  the wire (serialising RequestContext). Leaning: keep it private.
