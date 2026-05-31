# 11 — IP derivation

Trusted-proxy client-IP resolution. Foundation answers one question:
"given this `Request`, what IP do I trust to identify the client?"
Easy to get wrong; the consequence is poisoned rate-limit keys and
audit-log records pointing at the wrong source. Worth owning once.

## What it owns

- `trustedClientIp(request, config)` — the single entry point.
  Returns a validated IP string or `'unknown'`.
- `isIpShape(s)` — IPv4/IPv6 shape validator. Exported because audit
  / logging / rate-limit consumers sometimes need to sniff
  pre-extracted values.
- `IpAnonymizer` (instance, `.anonymize(ip, level?)`) plus the
  `anonymizeIpPartial(ip)` convenience function — scrubbing helpers
  (truncate-to-/24, truncate-to-/64, hash). Used by the audit module's
  PII filter and exposed for consumers that want region-specific
  scrubbing.

## What it does _not_ own

- **Geolocation.** "This IP is in Germany" lives in the region
  module ([`./09-region-and-residency.md`](./09-region-and-residency.md))
  and uses CDN-provided country headers, not IP lookup.
- **IP-based access control.** Allowlist / denylist enforcement is
  consumer-policy.
- **DDoS protection.** AWS WAF and CloudFront handle the upstream
  case; foundation operates downstream of them.

## Design

### The problem

`X-Forwarded-For` and `CF-Connecting-IP` are caller-supplied unless
you know your edge. The trellis incident G4 (per source comment in
`net/trusted-client-ip.ts`) is the canonical failure mode: parsing
`X-Forwarded-For.split(",")[0]` directly behind an ALB means the
"client IP" is whatever the client claims. The fix is an explicit
config switch.

Three trust modes, matching trellis's existing implementation:

| Mode         | Trust signal       | Returns                               |
| ------------ | ------------------ | ------------------------------------- |
| `none`       | None               | `request.socket.remoteAddress` if any |
| `alb`        | `X-Forwarded-For`  | Rightmost XFF entry (ALB-appended)    |
| `cloudflare` | `CF-Connecting-IP` | Header value                          |

The choice is per-deployment, set once via env var
(`TRUSTED_PROXY=none|alb|cloudflare`), never per-request. Foundation
reads it from `config.trustedProxy` (or the env directly) at
resolution time.

### `trustedClientIp`

```typescript
export type TrustedProxyMode = "none" | "alb" | "cloudflare";

export interface TrustedClientIpConfig {
  readonly mode: TrustedProxyMode;
}

export function trustedClientIp(request: Request, config: TrustedClientIpConfig): string;
```

Returns:

- A validated IPv4 dotted-quad or IPv6 shape, **or**
- The literal string `'unknown'` when nothing trustworthy is available.

Returning `'unknown'` instead of `null`/`undefined` is deliberate:
callers using the value as part of a rate-limit key or audit field
shouldn't have to handle the absence case. By default `'unknown'`
collapses to a "global ceiling" bucket in the rate-limiter — every
unknown-IP request shares one bucket, which is safe-fail (the service
stays available; rate-limiting works against the shared bucket so
attackers cannot trivially evade by stripping proxy headers).
Consumers who want strict fail-closed semantics pass
`unknownKeyStrategy: 'reject'` to `DynamoTokenBucketLimiter`
([`./08-rate-limit.md`](./08-rate-limit.md)); every unknown-key call
then returns `{ allowed: false }`. Pick `'reject'` when rate-limiting
is the only authorization gate on the endpoint.

### Shape validation

```typescript
export function isIpShape(s: string): boolean;
```

Validates against:

- **IPv4 dotted-quad** with octet-range check (no 256-overflow):
  `/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(...)){3}$/`.
- **IPv6 loose-shape**: hex digits, colons, dots, percent sign;
  rejects newlines, commas, spaces, SQL fragments.

Length-capped at 64 chars to prevent header-injection that fills the
buffer with valid-looking IP characters.

A value that fails shape validation returns `'unknown'`. The shape
check is the last line of defence against rate-limit-key poisoning
(an attacker putting a SQL fragment in `X-Forwarded-For`); the
config-mode-switch is the first.

### `IpAnonymizer`

Used by the audit PII filter and any consumer doing per-region
scrubbing.

```typescript
export type IpAnonymizationLevel = "none" | "partial" | "hash";

export interface IpAnonymizerOptions {
  /** Required when defaultLevel === 'hash' (or any hash call is made). */
  readonly hashSalt?: string;
  readonly defaultLevel?: IpAnonymizationLevel;
}

export class IpAnonymizer {
  constructor(options?: IpAnonymizerOptions);
  anonymize(ip: string, level?: IpAnonymizationLevel): string;
}

/** Convenience for callers that don't need hashing — no salt required. */
export function anonymizeIpPartial(ip: string): string;
```

- `'none'`: return as-is.
- `'partial'`: IPv4 → keep first 3 octets, replace last with `0`
  (`192.168.1.42` → `192.168.1.0`). IPv6 → keep first 4 hextets,
  zero the rest (`2001:db8:1:2:abcd::1` → `2001:db8:1:2::`).
- `'hash'`: HMAC-SHA-256 with the configured salt; returns
  `hashed:v1:<first-16-hex-chars>`. The `v1` is an explicit
  algorithm-version prefix so a future change to the hash construction
  (different HMAC, different output truncation) can ship as `v2`
  without ambiguity in historical audit rows. Consumers querying
  historical data can tell which generation of hash they are
  comparing against.

Default level when called from inside the audit module: `'partial'`.
This matches trellis's `audit/pii-filter.ts:anonymizeIp` behaviour
of `/24` truncation for IPv4 / `/64` for IPv6.

The hash mode is for jurisdictions where partial IP retention is
itself a PII issue (EU GDPR posture for some industries). Consumers
opt in.

**Why an instance, not a `configureIpAnonymization` function.**
Threading the salt through a process-global function survives
single-tenant deployments but breaks for tests (parallel tests with
different salts clobber each other) and for the rare consumer
running multiple anonymisation policies in one process. The
instance-based shape mirrors the `RegionRegistry` decision in
[`./09-region-and-residency.md`](./09-region-and-residency.md): pass
config in, don't hide it in module-level state.

### Why not extract trellis's `ip-scrubber.ts` shape directly

Trellis ships two utilities — `net/trusted-client-ip.ts` (the
trust-mode helper) and `ip-scrubber.ts` (the per-level scrubber).
Both graduate, merged into one module. The trellis `ip-scrubber.ts`
includes `getIPAddress(request, config)` that does the trusted-proxy
work _and_ scrubs in one call. Foundation splits the two:

- `trustedClientIp` returns a full IP (or `'unknown'`).
- `IpAnonymizer.anonymize` / `anonymizeIpPartial` separately scrub.

The split is because the audit log wants the _full_ IP at the
boundary (for forensic reconstruction, gated by region policy),
while general logging and rate-limit keys want the _scrubbed_ IP.
Combining the two into one call obscured this distinction in
trellis; foundation surfaces it.

## TypeScript surface

```typescript
export type TrustedProxyMode = "none" | "alb" | "cloudflare";

export interface TrustedClientIpConfig {
  readonly mode: TrustedProxyMode;
}

export function trustedClientIp(request: Request, config: TrustedClientIpConfig): string;

export function isIpShape(s: string): boolean;

export type IpAnonymizationLevel = "none" | "partial" | "hash";

export interface IpAnonymizerOptions {
  readonly hashSalt?: string;
  readonly defaultLevel?: IpAnonymizationLevel;
}

export class IpAnonymizer {
  constructor(options?: IpAnonymizerOptions);
  anonymize(ip: string, level?: IpAnonymizationLevel): string;
}

export function anonymizeIpPartial(ip: string): string;
```

## Caveats

- **`request.socket?.remoteAddress` is runtime-dependent.** Node's
  HTTP server attaches it via Express-style augmentation; web-
  standards `Request` (Workers, Hono in some configurations) does
  not. When absent in `mode: 'none'`, the function returns
  `'unknown'`. This is correct safe-fail.
- **ALB's XFF semantics.** ALB appends the _immediate-client_ IP to
  the right end of `X-Forwarded-For`. Trellis's helper reads the
  right-most entry (the ALB's view of the client). If the consumer
  is _not_ behind exactly one ALB hop (e.g., CloudFront → ALB →
  app), this gets the wrong answer. The fix is `mode: 'cloudflare'`
  (trust `CF-Connecting-IP`) since CloudFront sets that. Document
  the topology vs mode matrix in the package README.
- **IPv6 zone-identifier (`%eth0`).** Valid in IPv6 spec; accepted by
  the loose shape regex; passes through. Rate-limit keys built on
  this string will differ between hosts using different interface
  names — generally fine because zone IDs only show up on
  link-local addresses which shouldn't reach the application
  anyway.
- **`IpAnonymizer.anonymize(ip, 'hash')` is not encryption.** It's a
  one-way fingerprint. Consumers using it for compliance must document
  the HMAC salt's lifetime — a salt rotation re-buckets all historical
  rate-limit / audit records.
- **No automatic config-from-env.** `trustedClientIp` takes an
  explicit `config` arg; foundation does not silently read
  `process.env.TRUSTED_PROXY`. The consumer wires the env-to-config
  at startup. Reason: foundation modules should not depend on
  process env at call time; it makes tests fragile.

## Open questions

- **Should foundation ship a thin Hono / Express middleware that
  pre-extracts `clientIp` onto the request?** Today consumers call
  `trustedClientIp` inside their middleware that constructs
  `RequestContext`. A canned middleware is sugar; not v0.1.
- **A `mode: 'multi-hop'` for stacked proxies?** Would take a
  `trustedProxyCount` and skip N hops from the right of XFF.
  Real-world need is rare (CloudFront → ALB is the common stack and
  CF-Connecting-IP handles it). Add when asked.
- **IPv6 normalisation?** `2001:DB8::1` and `2001:db8::1` are the
  same address but distinct strings. Rate-limit and audit keys would
  benefit from canonicalising. Out of scope today; consumer-side
  normalisation if needed.
- **PROXY protocol parsing?** Some setups (HAProxy, NLB+target-
  group with proxy-protocol-v2) inject the original client at L4.
  Node's HTTP server doesn't natively parse this; consumers using
  it run a parser at the socket layer. Foundation does not ship
  PROXY protocol support — too platform-specific.
