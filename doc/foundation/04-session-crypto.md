# 04 — Session crypto

AES-GCM encryption and decryption of an opaque payload sealed in a
cookie (or `Authorization: Bearer` token). Identity-free: the consumer
decides what goes in the payload, foundation only seals/unseals it.

## What it owns

- `SessionCookie` — the round-trip class. Encrypts an opaque blob to
  a base64 string suitable for cookie storage; decrypts it back.
- `deriveKey(secret, salt)` — PBKDF2-based key derivation (SHA-256 /
  256-bit output for AES-GCM-256, 600k iterations per OWASP 2023).
- Cookie parsing and serialisation helpers (`parseCookieHeader`,
  `serializeSetCookie`) — small wrappers around the npm `cookie`
  package (parse + serialise). Foundation re-exports the
  consumer-shaped helpers for ergonomic continuity; the underlying
  parser is the audited OSS implementation rather than hand-rolled
  code.
- A secret-rotation mode that accepts a primary + fallback secret on
  decryption (so a rolling rotation does not invalidate live sessions).

## What it does _not_ own

- **Cognito JWT verification.** The vestibulum runtime owns
  `aws-jwt-verify` and the multi-pool verifier. Trellis's current
  665-LOC `session-manager.ts` mixes both; the foundation port
  extracts only the AES-GCM half.
- **Session payload shape.** Foundation does not know what
  `userId`, `role`, `csrfToken`, `expiresAt`, `dataRegion`,
  `mfaVerified`, etc. mean. The payload is `string` (or `unknown`
  via JSON convenience helpers). Consumers define their own session
  shape and serialise it.
- **Session storage backends.** This is cookie crypto only. A
  consumer that wants server-side session storage (Redis sessions
  with a session-ID cookie) uses foundation's `kv` module
  ([`./02-cloud-primitives.md`](./02-cloud-primitives.md)) and
  manages their own session-record lifecycle. Foundation does not
  ship a session-store abstraction.
- **CSRF tokens.** The session blob may _contain_ a CSRF token (as
  the consumer's shape) but CSRF middleware itself lives outside
  foundation, per [`../01-scope-and-philosophy.md`](../01-scope-and-philosophy.md).
- **Cookie flag policy (HttpOnly / Secure / SameSite).** The cookie
  serialisation helper accepts these as parameters; foundation does
  not pick defaults beyond `HttpOnly: true; Secure: true; SameSite:
Lax` (with overrides). Consumers pick.

## Design

### Cipher choice

- **AES-256-GCM.** Authenticated encryption, no padding oracle,
  small overhead, supported natively by Node 24's WebCrypto. Same
  cipher trellis uses; survives the port unchanged.
- **96-bit IV (12 bytes).** GCM standard. Generated via
  `crypto.getRandomValues(new Uint8Array(12))` per encryption.
- **PBKDF2 / SHA-256 / 600k iterations** for key derivation from a
  shared secret + per-deployment salt. OWASP 2023 minimum for PBKDF2-
  HMAC-SHA-256. Trellis's current 100k is below the modern floor; the
  port raises the default. The cold-start cost rises with the iteration
  count — see the cold-start budget note below.
- **No HMAC-then-encrypt or signature wrapping.** AES-GCM already
  authenticates; an outer HMAC adds no security and doubles the CPU.

### Salt is mandatory

Trellis's current `deriveKey` accepts `envSalt?: string` and
fail-closes if missing. Foundation tightens this further: the salt is
a **required** constructor argument on `SessionCookie`. No "optional,
fallback to a default" mode — a default salt across deployments is a
sharp edge that trellis has now identified.

```typescript
new SessionCookie({
  primarySecret: "<32+ byte secret>",
  fallbackSecret: undefined, // or '<old secret during rotation>'
  salt: "<deployment-unique 16+ byte salt>",
});
```

Both `primarySecret` and `salt` come from a `SecretRef`
([`./03-secrets.md`](./03-secrets.md)) at startup. Foundation does not
fetch them itself — the consumer resolves them and passes the
plaintext into the constructor. That's the only place plaintext
crosses the call-stack boundary, by design.

### Payload is opaque

```typescript
import type { ZodSchema } from "zod";

export class SessionCookie {
  constructor(options: SessionCookieConfig);

  async seal(payload: string): Promise<string>;
  async unseal(token: string): Promise<string | null>;

  // Convenience: JSON.stringify before seal, JSON.parse after unseal.
  async sealJson<T>(payload: T): Promise<string>;
  /**
   * Unseal and JSON.parse. When `schema` is provided, the parsed
   * payload is validated against it; on validation failure returns
   * `null` and logs at `warn` level. Without a schema, the returned
   * value is an unchecked `T` cast — the consumer is responsible for
   * validating shape.
   */
  async unsealJson<T>(token: string, schema?: ZodSchema<T>): Promise<T | null>;
}
```

The optional schema closes a small but real hole: an attacker who
ever obtains the session secret can mint a cookie whose JSON has
fields the consumer didn't anticipate; the `<T>` generic is a
compile-time assertion that doesn't run at decrypt time. With a zod
schema, the consumer gets a runtime check at the seam where
plaintext re-enters the application — the canonical "parse, don't
validate" pattern.

`payload` is a string. Foundation does not validate it, doesn't enforce
a max size beyond what cookie limits naturally cap (~4 KB), and does not
sniff JSON structure. If the consumer wants a structured payload, they
serialise it themselves (or use `sealJson` / `unsealJson` for the
common JSON case).

Why JSON convenience helpers but not a full schema layer: every
consumer's payload schema is different. A foundation-shaped "session
record" type would be either useless (too narrow) or a foot-gun (too
broad). The `sealJson<T>` helper is generic over `T` so the consumer
gets type-narrowing on the payload without foundation knowing its shape.

### Secret-rotation: primary + fallback

Rolling rotation works like this:

1. Day 0: cookies encrypted with `secret_v1`. App config:
   `{ primary: v1, fallback: undefined }`.
2. Day 1: deploy with `{ primary: v2, fallback: v1 }`. New cookies use
   v2; existing v1 cookies still decrypt via fallback.
3. Day 8 (after session-max-lifetime expires older cookies): deploy
   with `{ primary: v2, fallback: undefined }`. v1 cookies are now
   rejected.

Foundation's `unseal` tries `primarySecret` first, then `fallbackSecret`
if set. The trellis pattern survives intact.

```typescript
async unseal(token: string): Promise<string | null> {
  const primaryResult = await this.decrypt(token, this.primarySecret);
  if (primaryResult !== null) return primaryResult;
  if (this.fallbackSecret) {
    return this.decrypt(token, this.fallbackSecret);
  }
  return null;
}
```

`decrypt` returns `null` on any failure (bad MAC, malformed
ciphertext, wrong key) — there is no useful information to leak from
the failure mode, and a typed error here would tempt callers to
distinguish "wrong key" from "tampered ciphertext," which they should
not do.

### Cookie envelope

Foundation serialises the AES-GCM output as:

```
[IV (12 bytes)][ciphertext + GCM tag (variable)]
```

then base64-encodes the whole thing. This is what trellis ships and
the format does not need to change. The base64 string is what goes in
the cookie value.

The cookie _name_ is the consumer's choice (`trellis_session`,
`myapp_session`, etc.). Foundation provides:

```typescript
export interface CookieAttributes {
  readonly httpOnly?: boolean; // default true
  readonly secure?: boolean; // default true
  readonly sameSite?: "strict" | "lax" | "none"; // default 'lax'
  readonly path?: string; // default '/'
  readonly domain?: string;
  readonly maxAge?: number; // seconds
  readonly expires?: Date;
}

export function serializeSetCookie(
  name: string,
  value: string,
  attributes?: CookieAttributes,
): string;

export function parseCookieHeader(header: string | null): Record<string, string>;
```

`parseCookieHeader` and `serializeSetCookie` are thin wrappers around
the npm `cookie` package (`cookie.parse` / `cookie.serialize`). The
wrapper exists to keep foundation's consumer-facing shape stable even
if the underlying lib changes; the parsing/serialising logic is the
audited OSS implementation, not hand-rolled. Foundation does **not**
ship a hand-rolled cookie parser per the OSS-reuse principle in
[`../01-scope-and-philosophy.md`](../01-scope-and-philosophy.md#design-principles).
The previous trellis-side hand-rolled parser is replaced by the
`cookie` package on cutover.

## TypeScript surface

```typescript
export interface SessionCookieConfig {
  /** Primary secret. Must be ≥32 chars (UTF-8 length, not bytes). */
  readonly primarySecret: string;
  /** Optional fallback secret for rolling rotation. */
  readonly fallbackSecret?: string;
  /** Per-deployment salt. ≥16 chars. */
  readonly salt: string;
  /** PBKDF2 iterations. Defaults to 600_000 (OWASP 2023). */
  readonly iterations?: number;
}

export class SessionCookie {
  constructor(config: SessionCookieConfig);

  async seal(payload: string): Promise<string>;
  async unseal(token: string): Promise<string | null>;
  async sealJson<T>(payload: T): Promise<string>;
  async unsealJson<T>(token: string, schema?: ZodSchema<T>): Promise<T | null>;
}

export function serializeSetCookie(
  name: string,
  value: string,
  attributes?: CookieAttributes,
): string;

export function parseCookieHeader(header: string | null): Record<string, string>;
```

## Compose pattern (informational)

A consumer wiring this with vestibulum looks like:

```typescript
// consumer setup
const session = new SessionCookie({
  primarySecret: await resolveSecret(secretRef(env.SESSION_SECRET_ARN)),
  fallbackSecret: env.SESSION_FALLBACK_SECRET_ARN
    ? await resolveSecret(secretRef(env.SESSION_FALLBACK_SECRET_ARN))
    : undefined,
  salt: await resolveParameter(env.SESSION_SALT_PARAM),
});

const verifier = new MultiPoolJwtVerifier(/* vestibulum */);

// in a handler
const cookies = parseCookieHeader(request.headers.get("cookie"));
const sealed = cookies["myapp_session"];
if (!sealed) return /* 401 */;

const blob = await session.unsealJson<MyAppSession>(sealed);
if (!blob) return /* 401 */;

// If the consumer also wants Cognito-JWT login, that's a separate
// verification path through the vestibulum runtime, not foundation.
```

Foundation has no opinion on this composition — the consumer assembles
their own auth shape. The split between "decrypt my cookie" (foundation)
and "validate this JWT and turn its claims into a principal"
(vestibulum) is the boundary that the current trellis `session-manager.ts`
violates and which the extraction pulls apart.

## Caveats

- **PBKDF2 is intentionally slow; the cold-start budget grew.** At
  600k iterations on Node 24 the first call on a cold Lambda measures
  ~60–180ms (was ~10–30ms at the previous 100k setting). The 6×
  increase tracks the OWASP 2023 recommendation; the absolute cost is
  bounded by Lambda cold-start frequency, which for warm-pool
  workloads is rare. Foundation does not cache the derived key across
  calls in v0.1 — a future `SessionCookie.fromDerivedKey(key)` would
  shave this once a real consumer measures the impact and asks.
- **No nonce reuse detection.** GCM is unsafe if the same
  `(key, IV)` pair encrypts two different messages. Foundation
  generates the IV randomly per encryption, which is the standard
  defence. We do not maintain a nonce log.
- **Payload is opaque to foundation; size limits are the cookie's.**
  Most browsers cap a single cookie at 4 KB. The base64 expansion is
  ~33% on top of the encrypted bytes. Practical limit on the
  consumer's payload: ~2.8 KB plaintext. Larger payloads should use
  a server-side session store with a small ID cookie.
- **Foundation does not validate cookie names** against RFC 6265's
  token charset. The consumer is expected to use sensible names
  (`[A-Za-z0-9_-]`).
- **Web Crypto vs Node `crypto`.** Foundation uses `crypto.subtle`
  (Web Crypto) for portability with Workers-shaped runtimes the
  Cloudflare-compat principle hedges for. Performance parity with
  Node's native `crypto` module is fine in Node 24.

## Open questions

- **Should `SessionCookie` expose a single-secret convenience
  constructor that builds the fallback chain from a `string[]`?**
  E.g., `new SessionCookie({ secrets: [primary, ...fallbacks], salt })`.
  Multi-fallback is rare in practice (one-secret rotation is the
  norm), so the explicit two-slot shape is clearer. Leaning: keep
  two slots.
- **`sealJson` payload validation via a Zod schema?** _Decided
  (unseal side only):_ `unsealJson<T>(token, schema?: ZodSchema<T>)`
  validates the parsed payload at the decrypt seam. `sealJson` does
  not take a schema — the consumer chose `T` and the type system
  catches mis-construction. The asymmetry is intentional: the unseal
  side is where untrusted bytes re-enter, so that's where the
  runtime check belongs.
- **A `CryptoKey` cache keyed by `(primarySecret, salt)`?** Would
  shave the PBKDF2 cost on warm calls. Adds a tiny cache to the
  class. Probably yes once we have a perf trace from a real
  consumer; not v0.1.
- \*\*Should foundation own session-ID cookies (small opaque cookie
  - KV-stored session record)?\*\* Would be a separate class,
    `SessionStore`, layered on `KVNamespace`. Compelling for consumers
    with >4 KB session payloads. Probably yes, but not v0.1 — wait for
    the first real ask.
