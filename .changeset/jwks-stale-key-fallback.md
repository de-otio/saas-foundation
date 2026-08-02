---
"@de-otio/vestibulum": minor
---

Add an optional JWKS stale-key fallback to `IssuerVerifier`.

A pod that cold-starts while the IdP is unreachable cannot fetch JWKS, so every
authenticated request fails until the IdP returns. This matters most when the
app and the IdP share a failure domain — co-located on one cluster, for
instance, where a cluster event restarts both at once.

`IssuerVerifierConfig` gains an optional `jwksFallback` field taking a small
injectable store port (`get`/`set`). On a successful fetch the last-good JWKS is
persisted; when a fetch fails, verification falls back to that copy within a
bounded staleness window (7 days by default, tunable via
`maxStalenessSeconds`). Every fallback use emits an alertable warning.

The cached value is treated as untrusted input: it is re-parsed with the
prototype-pollution-safe parser and re-validated for envelope version, issuer,
JWKS URI, timestamp sanity, staleness, JWKS shape, and the presence of at least
one usable signing key. Any failure is a cache miss and the original fetch error
is rethrown. A successful fetch always wins over cache, and the fetched bytes
are returned unmodified so the library's own parser stays authoritative.

**Backward compatible.** With no `jwksFallback` configured, `build()` calls
`JwtVerifier.create(props)` with the identical single argument as before — no
store is constructed and no I/O happens. Consumers that pass nothing are
unaffected.

Note that serving stale keys widens the revocation window: if the IdP rotates
keys because a signing key leaked, an unreachable-IdP pod keeps honouring the
old `kid` until the staleness bound expires. That is the inherent trade; it is
bounded, per-issuer, logged on every use, and tunable per environment.
