---
"@de-otio/vestibulum": minor
---

Add `createIssuerVerifier` — a generic single-issuer OIDC JWT verifier

A provider-neutral counterpart to `createMultiPoolVerifier`, built on
`aws-jwt-verify`'s generic `JwtVerifier` (no new crypto). It pins one exact
`iss` + `aud`, fetches that issuer's JWKS, and enforces three fail-closed gates
in a `customJwtCheck`: reject a token with no finite `exp` (the library would
otherwise accept it forever), an explicit RS/ES algorithm allowlist that rejects
EdDSA/PS256 the library would accept, and an issuer-aware token-shape check
(Cognito `token_use` vs generic `typ`/`azp`). A JWKS reset+retry is narrowed to
signature/key-not-found failures only, so a flood of permanent-failure tokens
cannot thrash the JWKS cache. The RS/ES allowlist is extracted to a shared
`PERMITTED_ALGS` constant reused by the OIDC discovery probe so probe-time and
verify-time allowlists cannot drift. New export: `IssuerVerifierError`.
