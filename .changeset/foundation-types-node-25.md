---
"@de-otio/saas-foundation": patch
---

Adapt session crypto to `@types/node` 25's WebCrypto types. Its namespaced
`webcrypto.CryptoKey` is no longer the global `CryptoKey`, and the SubtleCrypto
data parameters are typed as `BufferSource` (to which a
`Uint8Array<ArrayBufferLike>` / `Buffer` is not assignable). The session key
types are now `webcrypto.CryptoKey` and the seal/unseal paths pass fresh
ArrayBuffer-backed `Uint8Array` copies into `encrypt`/`decrypt`. Internal
type/encoding adjustment only — no API or runtime-behaviour change.
