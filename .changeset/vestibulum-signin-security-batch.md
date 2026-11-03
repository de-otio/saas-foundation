---
"@de-otio/vestibulum": minor
"@de-otio/vestibulum-cdk": minor
---

Second security batch for the mailed-link sign-in (dot-notes
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
