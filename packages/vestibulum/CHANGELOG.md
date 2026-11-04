# @de-otio/vestibulum

## 0.7.0

### Minor Changes

- b54a152: Second security batch for the mailed-link sign-in (dot-notes
  `doc/topics/passwordless-sign-in-aws/`, invariants `signin_*`, requirements
  U6, U13, U16, U18). **Breaking: admin-only enrolment is the new default, and
  the denylist now fails closed.**

  Breaking changes

  - **Admin-only enrolment (default).** `MagicLinkIdentity` gains
    `enrollment?: "admin-only" | "self-signup"` (default `"admin-only"`). In
    admin-only mode the pool allows only administrator-created users
    (`AllowAdminCreateUserOnly`), `/auth-login` never calls `SignUp`, and a link is
    mailed only to an existing, **enabled** Cognito user whose `email_verified` is
    `true`. Consumers that relied on people signing themselves up must set
    `enrollment: "self-signup"`; that mode keeps today's behaviour and is a
    **documented deviation from invariant I9** (`signin_no_self_signup`).
    - **Create every user with `AdminCreateUser`**, `email` set to the **lower-case**
      address (Cognito's `email` filter is case-sensitive) and
      `email_verified = true`. Disable the Cognito user (`AdminDisableUser`) when
      eligibility ends. An address with two matching users is treated as unknown;
      users who signed themselves up have no `email_verified` and must be marked
      verified before they can sign in.
    - New exported port `SignInAllowList` (`lookup(normalizedEmail)`,
      `get(subject)`), `Eligibility`, `eligible()` and the default
      `createCognitoAllowList({ client, userPoolId })`. The handler factories
      (`createAuthLoginHandler`, `createCreateAuthChallengeHandler`,
      `createVerifyAuthChallengeResponseHandler`) accept an optional `allowList`;
      the bundled entrypoints use the Cognito one. `/auth-login` looks the
      normalised address up and signs in the **subject**; an unknown address, an
      ambiguous one or an unavailable allow-list gets a phantom UUID so Cognito
      runs its user-not-found path and the response stays the same `202 {}`.
      Create asks `get(event.userName)` for every caller (phantom included) and
      mails only an eligible one; Verify asks again before it approves, so a
      person disabled between request and click does not get in (an ineligible
      redemption spends the link).
    - IAM follows the mode: `auth-login` gets `cognito-idp:ListUsers` (admin-only)
      or `cognito-idp:SignUp` (self-signup) plus `InitiateAuth`; the Create and
      Verify triggers get `cognito-idp:AdminGetUser` on the pool, as a standalone
      policy (a policy naming the pool on the trigger's own role would make the
      pool and the triggers depend on each other). They read the pool from the
      trigger event rather than an environment variable for the same reason.
    - `SignUp` is isolated in `auth-login/self-signup.ts`; a test fails if any
      other source imports `SignUpCommand`.
    - `IMagicLinkIdentity` gains required `enrollment` and
      `defaultRefreshTokenValidity`. Hand-rolled implementations must add them.
    - The shared-distribution pool keeps its PreSignUp domain gate: its Create and
      Verify triggers are set to `self-signup`.
  - **Denylist fails closed (`signin_fails_closed`).** An unset
    `VESTIBULUM_DENYLIST_TABLE` or a `ResourceNotFoundException` used to mean "not
    denylisted"; now `isDenylisted` throws `DenylistUnavailableError`. Create turns
    that, and every other dependency error (allow-list, denylist, rate-limit
    counter, Secrets Manager, token store, SES), into an unanswerable challenge: no
    mail, no exception to Cognito, one `SignInSuppressed{reason}` metric. A failed
    SES send used to throw to Cognito; it no longer does.
  - **Strict answers and a typed code (U16, `signin_attempts_bounded`).**
    - Define issues the first challenge for an empty session, tokens only for
      `[CUSTOM_CHALLENGE success]` exactly, and fails every other shape (a failed
      round, a non-`CUSTOM_CHALLENGE` round, a longer session).
    - Create also generates an 8-digit code (`crypto.randomInt`), stores only its
      SHA-256 beside the token's hash (private parameters and token row), and puts
      it in the mail after the link. The silent path generates and hashes a code it
      never sends.
    - Verify accepts exactly the 43-character base64url token or exactly 8 ASCII
      digits; anything else is `false` without throwing. Both forms are compared by
      hash with `timingSafeEqual` and spend the same single-use row.
    - The login page shows an "or enter the 8-digit code from the email" field
      after a request is accepted and POSTs `{ answer }` to `/auth-verify` on an
      explicit submit only. Redeploy the login pages together with the Lambdas: the
      mail and the page now go together.
  - **Address normalisation (U18).** One pure `normalizeEmail` (trim, NFC,
    lower-case; exactly one `@`, non-empty parts, at most 254 octets, no
    whitespace or control characters) runs in `/auth-login` before any Cognito call
    and in the allow-list lookup, and Create mails the normalised address. An
    address that cannot be one is the existing `400`.

  IAM recipient fence (U13, `signin_mail_recipient_fenced_in_iam`)

  - The Create role's send grant is now `ses:SendEmail` only (it also granted
    `ses:SendRawEmail`), on the identity and the configuration set, with
    `StringEquals ses:FromAddress` = `sesIdentitySender`.
  - New `allowedRecipientPatterns?: string[]` adds `ForAllValues:StringLike
ses:Recipients` and a `Null ses:Recipients = false` guard (`ForAllValues` is
    vacuously true for an absent key). New `deniedRecipientPatterns?: string[]`
    adds a separate explicit Deny on `ses:SendEmail` / `ses:SendRawEmail` with
    `ForAnyValue:StringLike ses:Recipients` (for example `*+e2e-*`,
    `*@maildummy.*` in production); there is no Deny without it. Allowed patterns must be non-empty and contain `@`; denied
    patterns must be non-empty (`*+e2e-*` needs no `@`); write them in lower case.
  - The `ses:FromDisplayName`, `ses:TenantName` and `ses:FeedbackAddress`
    conditions of the spec's sketch are not emitted: the sender sets no display
    name, uses the v1 `SendEmail` API (no tenants), and the live behaviour of the
    feedback-address key is unverified.

  Security review follow-ups

  - **Default test-marker Deny.** In `admin-only` mode the Create role is now ALWAYS
    denied `ses:SendEmail` / `ses:SendRawEmail` to recipients matching
    `*+e2e-*@*` and `*@maildummy.*`, in the same single Deny as any
    `deniedRecipientPatterns` (which stay additive). A dev or test stage that mails
    such addresses on purpose sets the new `allowTestRecipients: true`. Admin-only
    with no `allowedRecipientPatterns` now emits a synth warning. The construct's
    TSDoc records why `ses:FromDisplayName`, `ses:FeedbackAddress` and
    `ses:TenantName` are not emitted.
  - **`/login-config.json` is no longer deployed.** It published the client id,
    region and domain and nothing read it. Redeploying removes the object.
  - **`createFloorMs`** (integer 100-5000, default **1000**, was a fixed 400, env
    `VESTIBULUM_CREATE_FLOOR_MS`) sets the CreateAuthChallenge response floor.
    Measured live at 400 ms, the SES sending path exceeded it (p90 439 ms, max
    870 ms) while the silent path did not, a timing tail visible to anyone calling
    `InitiateAuth` directly with the public client id. The Create function's timeout
    is now 5 s (Cognito's own limit for a trigger) so a large floor fits.
  - **`MagicLinkIdentityProps.linkDomain`** (default: the sender's domain) is the
    host the mailed link points at, and `MagicLinkAuthSite` now fails the synth
    when it differs from the site's `domain`. Found live: with a sender on
    `example.com` and a site on `app.example.com` every link pointed at a host that
    does not serve `/login/callback`. Set `linkDomain` to the site domain in that
    topology. A hand-rolled `IMagicLinkIdentity` may declare `linkDomain` to get
    the same check.
  - **`/auth-signout` requires `POST` with `Content-Type: application/json`** (405 /
    415 otherwise), like `/auth-verify`. Send a POST with a JSON body (for example
    `{}`); a GET link or a form post no longer signs a user out. From a browser the
    POST also needs `x-amz-content-sha256` (CloudFront OAC), as the login pages send.
  - **The 15-minute window cap is keyed with the secret-keyed HMAC** (as the daily
    cap is), not a plain SHA-256. Existing window-cap rows are orphaned: they
    simply expire through the table's TTL, and each address starts a fresh window
    after the upgrade.
  - **An empty HMAC key is a dependency error.** When the secret id is unset
    `email-hmac` returns `""`; Create now treats that as unanswerable (no mail, no
    counter row) instead of hashing with an empty key.
  - **Verify settles its own dependencies.** A Secrets Manager or token-store read
    error ends in `answerCorrect: false` and a closed-enum log line
    (`dependency_error`); no SDK error text reaches the logs.
  - The mail now tells the recipient never to share the code with anyone.

  Fixes

  - **Shared-distribution tokens carry an expiry the table and Verify honour.** The
    shared CreateAuthChallenge wrote `ttl` into a table whose TTL attribute is
    `expires_at`. Every table now uses `expires_at`: the reservations table's TTL
    attribute moves from `expiresAt` (CloudFormation changes the TTL attribute of a
    deployed table, which DynamoDB allows only once an hour), the tenant
    reservations and idempotency records write it, and an expired idempotency
    record that DynamoDB has not yet deleted is treated as absent.
  - **Per-address daily cap (I10).** Create counts every challenge against a cap of
    20 per address per UTC day (`MagicLinkIdentityProps.tokenSendsPerDay`, env
    `VESTIBULUM_TOKEN_SENDS_PER_DAY`), next to the existing 15-minute window cap. The
    counter is a conditional write keyed on a secret-keyed hash of the normalised
    address and the UTC date, done for every caller (phantom included); its row
    expires an hour after the end of that day. The 21st challenge of a day is
    unanswerable, mails nothing and reports `SignInSuppressed{reason=daily_cap}`;
    a counter error is also unanswerable. This is what bounds the typed 8-digit
    code (about 7·10⁻⁵ a year per address); raising the cap weakens that bound.
  - **Sign-out after the ID token expired.** `auth-signout` accepts an ID token
    whose signature, issuer, audience and `token_use` are valid but whose `exp` has
    passed, up to the app client's refresh-token validity in the past
    (`VESTIBULUM_REFRESH_TOKEN_VALIDITY_SECONDS`, set by `MagicLinkAuthSite` from
    `refreshTokenValidity` or the pool default; 30 days when unset). An old ID token
    can therefore sign its user out, which is low impact. To make this reachable
    the ID-token cookie's `Max-Age` is now the refresh-token validity (it was 15
    minutes), passed to `auth-verify` through the same variable; a malformed value
    makes `auth-verify` fail closed. A browser therefore keeps sending an expired
    ID token for up to that long; every consumer checks `exp` itself (both
    Lambda@Edge `check-auth` gates, which allow 60 s of skew, and `auth-signout`,
    which relaxes it for revocation only), so it never grants access. A new
    `VESTIBULUM_REFRESH_TOKEN_VALIDITY_SECONDS` default of 30 days applies when
    the variable is unset. Any consumer of the `id-token` cookie outside this
    package must also check `exp`.
  - Log lines and metrics from Create and Verify carry closed enums only (no
    hashed address); their names stay under 20 characters.

  CloudFront and Lambda@Edge (verified live)

  - **Lambda@Edge runs `nodejs24.x`** (was `nodejs22.x`), for both the
    single-tenant `check-auth` gate and the shared-distribution edge function.
    CloudFront accepted the association and the gate redirected an
    unauthenticated request and served a signed-in one. The edge bundles still
    target node22.
  - **The config bake re-runs when the edge runtime changes.** Its inputs now
    include the runtime; before, a runtime change alone left CloudFront on the
    previously baked version.
  - **The construct's own `lambda:InvokeFunction` grants to CloudFront are
    removed.** aws-cdk-lib's `FunctionUrlOrigin` grants (conditioned on
    `InvokedViaFunctionUrl`, scoped to the distribution) are enough: POSTs to
    `/auth-login`, `/auth-verify` and `/auth-signout` succeed through OAC with
    them alone. Callers must still send `x-amz-content-sha256` on POST.

  Live verification (dev account, eu-central-1 + us-east-1, real CloudFront, SES
  and Cognito; torn down afterwards): admin-create-only pool, direct `SignUp`
  refused; `InitiateAuth` by address returns the same shape for allow-listed and
  unknown addresses (Cognito echoes a stable UUID for both); full request → mail →
  redeem → gated content flow; replay 401; a forwarded link refused in another
  browser and not consumed; typed code; POST-only sign-out; IAM recipient fence via
  the policy simulator; in headless Chromium, a link opened from another site and
  one opened directly both load without the cookie, send nothing until the click,
  and the click's POST carries the `SameSite=Strict` binding cookie; Create
  durations flat at the 1000 ms floor (warm); no address, token, code, session or
  JWT in any sign-in handler's logs.

  Deliberate deviations from the spec, NOT built here

  - **Asynchronous issuance (spec §6).** `request` still waits for Create inside
    Cognito's trigger chain; a timing tail remains and the response floor only
    mitigates it.
  - **Confidential app client (U22).** The CUSTOM_AUTH client is still public, so
    the Cognito `InitiateAuth` endpoint remains callable directly; the caps and the
    allow-list are enforced in the triggers (`signin_caps_enforced_in_trigger`).
  - **Cognito risk configuration LogOnly (U17).**
  - **Self-signup mode deviates from I9**, by design, as described above.

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
