# 06 — Security and abuse testing

The repo ships security primitives — identity federation, session crypto,
an authenticated CloudFront edge, IAM-shaped infrastructure. For these
paths the happy path is the least interesting case; the test that earns its
keep is the adversarial one. This document is the catalogue of those tests:
the threat, the defending code, and the test that pins the defence.

The governing rule (P5, extended): a security-bearing module is not done
until the *abuse* case is a test, asserted by typed rejection — never by a
string match on an error message, which an attacker-influenced input could
perturb.

## Threat → defence → test

### SSRF via OIDC issuer discovery

- **Threat:** a tenant-supplied OIDC issuer URL pointed at internal
  infrastructure (metadata service, internal admin, loopback) turns the
  discovery probe into a server-side request forgery primitive. Redirects
  to internal addresses are the second-order variant.
- **Defence:** `vestibulum/src/discovery/oidc-probe.ts` +
  `discovery/private-ip.ts`, classifying targets against private /
  loopback / link-local / reserved ranges before fetching, and re-checking
  after each redirect hop.
- **Tests must pin:** refusal of `127.0.0.0/8`, `10/8`, `172.16/12`,
  `192.168/16`, `169.254/16` (incl. the cloud metadata IP), `::1`,
  link-local v6; refusal when a public issuer 302-redirects to a private
  address; acceptance of a legitimate public issuer. The classifier shares
  RFC6890 logic with `foundation/net/rfc6890` — both are tested.

### Cross-pool / forged JWT acceptance

- **Threat:** a token minted by one tenant's Cognito pool accepted for
  another tenant; an expired, wrong-audience, wrong-issuer, or
  `alg:none`-style token admitted.
- **Defence:** `vestibulum/src/verify/multi-pool-verifier.ts` over
  `aws-jwt-verify`, plus the edge verifier
  `lambda/shared-distribution/edge/verify-jwt.ts` and its JWKS cache.
- **Tests must pin:** rejection of a token whose `iss` belongs to a
  different registered pool; rejection of expired / not-yet-valid /
  wrong-`aud` tokens; correct pool resolution from the tenant subdomain;
  JWKS-cache behaviour under rotation (stale key not trusted past TTL).
  This is the headline abuse test for the shared-distribution topology.

### SAML signature wrapping / malformed metadata

- **Threat:** XML signature wrapping, comment-truncation, and malformed
  metadata used to forge an assertion or smuggle a different subject.
- **Defence:** `vestibulum/src/discovery/saml-metadata.ts`,
  `idp/saml-manager.ts`, `saml/sp-metadata.ts` over `xml-crypto` /
  `@xmldom/xmldom`.
- **Tests must pin:** rejection of assertions whose signature doesn't cover
  the asserted subject; rejection of malformed / multi-root XML; correct
  parse of valid metadata. Fixtures are generated deterministically at
  suite start (`test/fixtures/saml/build-fixtures.ts`, wired as
  `globalSetup`) so signed fixtures are reproducible, not committed blobs.

### Edge-auth bypass (private origin exposure)

- **Threat:** a request reaching the protected origin without a valid
  session — via a crafted path, a missing-cookie edge case, or a
  malformed `check-auth` input.
- **Defence:** `lambda/shared-distribution/edge/check-auth.ts` +
  `responses.ts`; the single-tenant `lambda/edge/check-auth/*` with its
  cookie and JWKS-region resolver.
- **Tests must pin:** unauthenticated request → redirect/deny (never
  pass-through); valid session → admit; tampered or expired session cookie
  → deny; correct tenant→pool resolution so tenant A's cookie can't admit
  to tenant B.

### Session-cookie tampering and crypto

- **Threat:** a forged or modified sealed session cookie accepted as
  genuine; key-derivation weakness.
- **Defence:** `foundation/src/session/*` — seal/unseal, key derivation,
  JSON unsealing.
- **Tests must pin:** a single-bit flip in the sealed payload is rejected;
  an expired payload is rejected; round-trip succeeds; key derivation is
  deterministic for a given input and uses an injected key (no real
  entropy in tests, per P2).

### Rate-limit and cost-DoS evasion

- **Threat:** bypassing the magic-link / auth rate limit to enable
  enumeration or to run up SES/Cognito cost (a cost-DoS).
- **Defence:** `foundation/rate-limit/*` (token-bucket core + DynamoDB
  limiter), the create-auth-challenge `rate-limit.ts` and
  `quarantine-check.ts`, and the CDK `cost-dos-guard.ts`.
- **Tests must pin:** the limiter blocks at the window boundary (off-by-one
  both directions), refills correctly over an injected clock, and is not
  evadable by clock manipulation in the request; the cost-DoS guard
  construct synthesises the intended throttle/quarantine wiring.

### Least-privilege IAM shape

- **Threat:** an over-broad IAM policy on a generated construct (a `*`
  resource or action that widens blast radius).
- **Defence + test in one:** `foundation/test/audit/iam-shape.test.ts`
  asserts the audit path's policy is scoped; the `vestibulum-cdk`
  `cdk-nag` rules and enforcement Aspects (`waf-required`,
  `log-retention-required`, `disabled-auth-flows`) trip on a
  non-compliant synthesised tree. `cdk-nag` running in the example synth
  (Layer 9) is the per-PR backstop.
- **Tests must pin:** IAM statements are resource-scoped, not `*`; a tree
  missing a required WAF / log-retention / a re-enabled insecure auth flow
  fails the Aspect.

### PII leakage in logs and audit

- **Threat:** secrets, tokens, or PII written to structured logs or audit
  records.
- **Defence:** `foundation/logger/redact.ts` and `audit/pii-filter.ts`.
- **Tests must pin:** known-sensitive keys are redacted (idempotently —
  redacting twice equals redacting once); the audit PII filter strips the
  documented fields; the redactor doesn't mangle non-sensitive payloads.

### Open-redirect / subdomain confusion

- **Threat:** a crafted `Host` / subdomain resolving to the wrong tenant,
  or an auth-flow redirect to an attacker URL.
- **Defence:** `lambda/shared-distribution/shared/extract-tenant-subdomain.ts`
  and the auth-verify path builders.
- **Tests must pin:** ambiguous / spoofed subdomains don't resolve to a
  victim tenant; redirect targets are constrained to the configured
  domain set.

## Conventions for security tests

- **Assert by typed error, not message.** Every security module exposes an
  `errors.ts`; abuse tests assert the error *type* so a message tweak can't
  silently pass an attack.
- **Generate the adversarial space where feasible.** Use fast-check
  (Layer 2) to fuzz the SSRF classifier, the cookie unsealer, and the
  subdomain extractor — hand-picked malicious inputs miss the boundary the
  generator finds.
- **Fixtures are reproducible, not committed opaque blobs.** Signed SAML
  fixtures are generated at suite start so the signing inputs are visible
  and the determinism rules (P2) hold.
- **The integration backstop for these is scenario 1–3 and 7** in
  [`05-integration-and-e2e.md`](05-integration-and-e2e.md) — the unit
  layer proves the logic, the deferred tier proves the real edge / real
  redirector behaves the same. Until that tier exists, a change to an
  edge-auth or SSRF path warrants extra review scrutiny precisely because
  synth-only is the only automated evidence.
