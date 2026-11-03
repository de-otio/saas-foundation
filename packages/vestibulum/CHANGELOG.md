# @de-otio/vestibulum

## 0.6.0

### Minor Changes

- b71f0c7: Bring the mailed-link sign-in in line with the passwordless sign-in spec
  (dot-notes `doc/topics/passwordless-sign-in-aws/`, invariants `signin_*`).
  **Breaking for consumers of the browser flow, the constructs and the lock.**

  Security fixes

  - **Browser binding.** `/auth-login` no longer returns the Cognito `Session`.
    It keeps it server-side under `SHA-256(b)` and sets `b` as an HttpOnly
    `__Host-signin` cookie; it answers `202 {}`. `/auth-verify` completes only a
    request that carries that cookie, so a forwarded or intercepted link signs
    nobody in and consumes nothing. The body is now `{ "answer": "<token>" }`
    only (no `session`, no `email`). New `MagicLinkIdentity.bindingTable`.
  - **Redemption needs a click.** The callback page renders a button and POSTs
    only when it is pressed; it sends nothing on load or while prerendering.
    `/auth-verify` accepts only `POST` with `Content-Type: application/json`.
  - **Unknown-user timing.** `CreateAuthChallenge` does the same reads and
    counter write for every caller and waits for a floor (`CREATE_FLOOR_MS`,
    400 ms); `/auth-login` answers the same `202 {}` on every path after
    `SIGNIN_FLOOR_MS` (default 2500 ms, new `MagicLinkAuthSite.signInFloorMs`,
    500-6000). The per-IP limit no longer answers `429`. Measured live, the
    eligible path (SES send inside Cognito's trigger chain) exceeded a 1500 ms
    floor in a third of requests, so the default is 2500 ms; a tail remains
    (about 5% over the floor), so treat the floor as a mitigation, size it per
    stage, and prefer asynchronous issuance where parity must be exact.
  - **No enumeration oracle on direct Cognito calls.** The challenge's public
    parameters used to carry the address for real users and Cognito's generated
    username for unknown ones. They are now a constant for every caller.
  - **Link expiry is enforced.** `AuthSessionValidity` is set on every app client
    to `tokenTtlMinutes`, which now defaults to **10** (was 15) and must be an
    integer from 3 to 15. Handlers write `expires_at` (the attribute the tables'
    TTL names; they wrote `ttl`), and Verify refuses a row at or past it. A row
    with no `expires_at` fails closed, so links issued before the upgrade stop
    working and must be re-requested.
  - **Verify compares before it consumes.** A valid link presented against
    another session no longer burns the token.
  - **Sign-out.** The grant is now `cognito-idp:AdminUserGlobalSignOut` (it was
    `GlobalSignOut`, so every revocation was denied and the error was swallowed).
    The user comes from a verified ID token, not an unverified cookie, and works
    with the ID-token cookie alone (the refresh cookie never reaches
    `/auth-signout`). A failed revocation emits a `SignOutRevocation` metric.

  Bounces

  - A configuration set whose event destination publishes bounces and complaints
    to `bounceTopic` is created and applied to every send; SES is allowed to
    publish to the topic; `ses:SendEmail` is granted on the set as well as the
    identity. The bounce handler reads the `eventType` shape SES uses for
    configuration-set events (it read only `notificationType`), and logs only an
    error name and a hash prefix. Create now honours
    `custom:email_quarantined`. The denylist table gets the TTL attribute its
    365-day expiry always assumed.

  Upgrade

  - All regional Lambdas and bundles move to `NODEJS_24_X` / node24 (the
    Lambda@Edge functions use `NODEJS_22_X`; the shared-distribution edge
    function was `NODEJS_20_X`).
  - `aws-cdk-lib` peer and dev floor is `^2.275.0`; AWS SDK clients `^3.1161.0`.
    `lambda-bundles.lock.json` is regenerated and `vestibulumVersion` now equals
    the package version (a test enforces it).
  - `IMagicLinkIdentity` gains required `bindingTable` and `tokenTtlMinutes`.
    Hand-rolled implementations must add them.
  - Redeploy the login pages together with the Lambdas: the old pages and the new
    endpoints do not interoperate.
  - `auth-verify` no longer holds the token table or denylist (it only deletes
    from the binding table).

### Patch Changes

- Updated dependencies [661bba1]
  - @de-otio/saas-foundation@0.4.4

## 0.5.0

### Minor Changes

- 4a8cdff: Require an explicit `jwksUri` for generic (non-Cognito) OIDC issuers, and carry
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

- 12f7bae: Add an optional JWKS stale-key fallback to `IssuerVerifier`.

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

## 0.4.0

### Minor Changes

- 8b48734: Add `createIssuerVerifier` — a generic single-issuer OIDC JWT verifier

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

### Patch Changes

- Updated dependencies [7d22707]
- Updated dependencies [f71df2b]
  - @de-otio/saas-foundation@0.4.0

## 0.3.6

### Patch Changes

- 4bb875d: check-auth: bake Cognito config into the Lambda@Edge gate at deploy time

  The `check-auth` viewer-request gate shipped with `PLACEHOLDER_*` pool/client/region
  config (Lambda@Edge can't read env vars, and consumers supply these as deploy-time
  CloudFormation tokens), and its ID-token cookie name had drifted from what
  `auth-verify` sets. As a result the gate rejected **every** valid token —
  `302 → /login` — and browser login could never complete.

  - **vestibulum:** single source of truth for the auth cookie names
    (`ID_TOKEN_COOKIE_NAME` / `REFRESH_TOKEN_COOKIE_NAME`), wired into
    `auth-verify`, `auth-signout`, and the edge `check-auth` gate.
  - **vestibulum-cdk:** a `CheckAuthConfigBaker` custom resource injects the
    concrete Cognito config into a pristine copy of the edge bundle at deploy
    time, republishes the function version, and the CloudFront viewer-request
    association points at that baked version. Fails closed if any placeholder
    survives; narrowly-scoped IAM on the single function.

## 0.3.5

### Patch Changes

- Add a server-side **`auth-login`** Function-URL handler that performs the
  magic-link sign-in initiation (SignUp + InitiateAuth) on the backend instead
  of the browser calling Cognito directly, gated by a **per-client-IP rate
  limit** (default 10 / 15 min, keyed on the CloudFront-attested viewer IP).
  This closes the per-IP/volumetric gap on login initiation independently of the
  WAF. New `RuntimeEnv.LOGIN_IP_PER_WINDOW`.
- Harden `create-auth-challenge`: when the app client has
  `PreventUserExistenceErrors` enabled, an unknown address (no `email`
  attribute) now returns a fail-closed challenge instead of throwing — removing
  a user-existence oracle (400 vs 200) on the public InitiateAuth endpoint.

## 0.3.4

### Patch Changes

- Apply the Function-URL cookie fix to the **multi-tenant `shared-distribution`**
  `auth-verify` and `auth-signout` handlers (0.3.3 fixed only the single-tenant
  `handlers/` variants). They returned cookies via
  `multiValueHeaders["Set-Cookie"]`, which Lambda Function URLs (payload format
  2.0) silently drop — so a successful tenant sign-in set no `id-token` cookie.
  Both now return the `cookies` array, which Function URLs emit as `set-cookie`
  headers (per AWS docs, "Invoking Lambda function URLs" § Cookies).

## 0.3.3

### Patch Changes

- Fix the `auth-verify` and `auth-signout` handlers' Set-Cookie response for
  Lambda Function URLs. They returned cookies via `multiValueHeaders["Set-Cookie"]`
  (API Gateway / ALB shape), which Lambda Function URLs (payload format 2.0)
  silently drop — so a successful sign-in set no `id-token` cookie. Both handlers
  now return the `cookies` array, which Function URLs emit as `set-cookie`
  headers (per AWS docs, "Invoking Lambda function URLs" § Cookies). The
  multi-tenant `shared-distribution` variants are unaffected by this change.

## 0.3.2

### Patch Changes

- Fix three related defects in magic-link email hashing that made the bounce/
  complaint denylist non-functional and the `email_hmac` pepper effectively
  public.

  - **HMAC keyed on the secret id, not its value.** `VESTIBULUM_BOUNCE_HMAC_SECRET`
    holds the Secrets Manager **id** (ARN), and the handlers used that string
    directly as the HMAC key — so the pepper was low-entropy and effectively
    public (the ARN appears in IAM policies, the console, CloudFormation), letting
    anyone who knows it brute-force the low-entropy email space from a table
    snapshot. The key is now resolved from Secrets Manager at runtime via
    `GetSecretValue` (cached per warm container), and `MagicLinkIdentity` grants
    `secretsmanager:GetSecretValue` to CreateAuthChallenge and
    VerifyAuthChallengeResponse (the bounce handler already had it).
  - **Denylist read/write hashed differently.** The bounce handler wrote denylist
    entries with a keyed HMAC, but the CreateAuthChallenge quarantine check read
    with a plain **unkeyed** `sha256` — so a bounced/complained address was never
    actually blocked from requesting new magic links.
  - **Inconsistent canonicalisation.** The bounce-handler write did not lowercase
    the address while the reads did, so a mixed-case address would have escaped the
    denylist even once the keys matched.

  All email hashing now funnels through one canonical `hmacEmail(email, key)` that
  always lowercases and always keys, so the issue/verify and write/read sides
  cannot drift. Adds regression tests covering lowercasing, keying, the per-warm-
  container cache, and read==write equality across mixed case.

## 0.3.1

### Patch Changes

- Upgrade the `undici` runtime dependency from 7 to 8. No API or behaviour
  change in vestibulum itself; consumers receive the updated transitive
  dependency.

## 0.3.0

### Minor Changes

- 9a4e9fd: Upgrade major dependency versions.
  - **zod 3 → 4** (`@de-otio/saas-foundation`, `@de-otio/vestibulum`). Foundation
    re-exports zod schemas as public API, so this is a breaking change to the
    published type surface: consumers must also be on zod 4. The `z.ZodType<T, Def, In>`
    three-argument form is replaced by `z.ZodType<T, In>` (the `ZodTypeDef` type
    parameter was removed in zod 4). Runtime schema behaviour is unchanged.
  - **cockatiel 3 → 4** (`@de-otio/saas-foundation`, internal). The `handleWhen`
    predicate now receives `unknown` rather than `Error`; the internal retry
    predicate was widened accordingly. No public API change.
  - **TypeScript 5 → 6** (build toolchain). Node built-in module specifiers and
    `@types/node` are now declared explicitly for the CDK packages.
  - **@prisma/client dev pin 5 → 7** (`@de-otio/saas-foundation` build only). The
    `@prisma/client` peer-dependency range stays `>=5.0.0`; the Prisma-backed
    adapters operate on a consumer-supplied client via structural interfaces, so
    consumers on Prisma 5, 6, or 7 are all supported.

### Patch Changes

- Updated dependencies [9a4e9fd]
  - @de-otio/saas-foundation@0.3.0

## 0.2.0

### Minor Changes

- Add shared-distribution mode: shared Cognito pool + multi-aud Lambda@Edge handler factories, `wrapPreTokenHandler`, `loadClientConfig`. Pure-data tenant onboarding via the admin Lambda.

## 0.1.0

### Minor Changes

- Initial release: magic-link auth, multi-pool JWT verifier, Cognito trigger factories, Lambda@Edge check-auth, admin Lambda bundles, and CDK constructs (MagicLinkIdentity, MagicLinkAuthSite, EdgeResources).
