---
"@de-otio/vestibulum": minor
---

Require an explicit `jwksUri` for generic (non-Cognito) OIDC issuers, and carry
the underlying failure as `cause`.

`JwtVerifier`'s default JWKS location is `${issuer}/.well-known/jwks.json` — the
**Cognito** convention. Keycloak (and most other providers) publish at
`/protocol/openid-connect/certs`, so for a generic issuer the derived URL 404s.
A JWKS that cannot be fetched means the signing key is never found, and that maps
to `invalid_signature` — so a plain URL misconfiguration presents as "every token
is cryptographically invalid". The symptom points at crypto; the cause is config.

This was not hypothetical: it took a live dev API down for the entire Keycloak
cutover on 2026-08-02. Every token was rejected, and the error sent debugging to
the wrong layer. The package's own tests never caught it because each generic
test already passed an explicit `jwksUri` — the suite supplied exactly what
production omitted.

**Breaking for generic issuers.** `createIssuerVerifier` now throws at
construction when the resolved issuer kind is `"generic"` and `jwksUri` is
absent, naming the issuer's `.well-known/openid-configuration` so the fix is
one lookup away. Cognito issuers are unaffected — the derived default is correct
there and remains optional. Consumers on a generic issuer must pass `jwksUri`
(read `jwks_uri` from the discovery document); the inferred-kind path is covered
too, since that is the one production actually took.

`VestibulumRuntimeError` and `IssuerVerifierError` also accept an optional
`{ cause }`, and the verifier now attaches the originating error when it maps a
JWKS fetch/kid failure onto `invalid_signature`. The caller-visible `code` and
`message` are deliberately unchanged — narrowing them per cause would hand an
attacker an oracle separating "bad signature" from "JWKS unreachable" — but an
operator reading the error chain now sees the 404 and the URL that produced it.
