# @de-otio/vestibulum-cdk

## 0.3.26

### Patch Changes

- Wire the new **`/auth-login`** backend endpoint into `MagicLinkAuthSite`: an
  `AuthLoginFn` Lambda Function URL behind CloudFront OAC (mirrors `auth-verify`),
  with `cognito-idp:SignUp`+`InitiateAuth` IAM, the rate-limit table grant, and a
  `/auth-login*` behaviour. The login page now POSTs to this same-origin endpoint
  instead of calling Cognito directly — closing the per-IP login gap without the
  WAF.
- Make the CloudFront WAFv2 Web ACL **optional** via `EdgeResources.enableWebAcl`
  (default `true`). When `false`, no Web ACL is created and the distribution omits
  `webAclId` — lets cost-sensitive (e.g. dev) deployments opt out. The
  `waf-required` aspect tolerates the explicit opt-out while still catching
  accidental omissions.

## 0.3.25

### Patch Changes

- Make the **shared (multi-tenant) distribution** actually deploy its
  multi-tenant auth handlers. Two fixes:

  1. **Bundle wiring.** `SharedDistributionTriggers` loaded the
     `auth-verify`/`auth-signout` bundles, which are built from the
     **single-tenant** `@de-otio/vestibulum` barrel export (fixed
     `COGNITO_CLIENT_ID`, no Host/DDB lookup) — so the multi-tenant
     `shared-distribution/triggers/*` handlers were never deployed. Added
     dedicated `shared-auth-verify` / `shared-auth-signout` bundles (which wrap
     the trigger source) and pointed the construct at them. The two auth
     Lambdas also get 256 MB (Cognito-cascade headroom), matching the
     single-tenant `MagicLinkAuthSite`.

  2. **`Host` header forwarding.** The `/login/callback*` and `/logout*`
     behaviours used the managed `AllViewerExceptHostHeader` origin request
     policy, which strips the viewer `Host` and substitutes the origin's
     `.on.aws` host. But these handlers discriminate tenants **by the viewer
     `Host`**, so every request resolved to `400 invalid host`. Switched to
     `AllViewer` (forwards Host + cookies + query). Unlike the OAC/SigV4
     single-tenant site, these Function URLs are `AuthType: NONE`, so there is
     no signing reason to strip Host. (Requires `@de-otio/vestibulum@^0.3.4`
     for the Function-URL cookie-array fix in those handlers.)

## 0.3.24

### Patch Changes

- Forward the auth cookies via an **origin request policy** instead of a cache
  policy. 0.3.23 tried to forward cookies on a caching-disabled cache policy,
  which CloudFront rejects at deploy ("CookieBehavior is invalid for policy with
  caching disabled"). The `/auth-verify*` and `/auth-signout` behaviours keep
  the `CachingDisabled` cache policy and now attach the managed
  `AllViewerExceptHostHeader` origin request policy, which forwards all viewer
  cookies/headers/query EXCEPT Host (Host is excluded so OAC keeps signing
  against the Lambda URL host). This restores `Set-Cookie` to the viewer on
  sign-in and request cookies to the origin on sign-out, without caching.

## 0.3.23

### Patch Changes

- Stop CloudFront stripping cookies on the auth endpoints — the last hop of
  browser sign-in. The `/auth-verify*` and `/auth-signout` behaviours used the
  managed `CachingDisabled` policy, whose cookie behaviour is `none`; CloudFront
  therefore removes `Set-Cookie` from origin responses before the viewer (so a
  successful sign-in returned 200 but set no `id-token` cookie) and strips
  request cookies before the origin (so sign-out can't read the tokens to
  revoke). Both behaviours now use a dedicated no-cache cache policy
  (min/max/default TTL 0) that forwards the `id-token`/`refresh-token` cookies.
  See AWS docs: "Cache content based on cookies". Adds a synth assertion.

## 0.3.22

### Patch Changes

- Finish making browser sign-in completion work — two further fixes that the
  0.3.21 OAC change exposed once `/auth-verify` could actually be invoked:

  - **Bump the auth Lambda timeout/memory off the CDK defaults.** The
    `auth-verify` success path calls Cognito `RespondToAuthChallenge`, which
    cascades synchronously through the VerifyAuthChallengeResponse +
    PreTokenGeneration triggers; with the 3s default (and a cold start) it
    overran and the Function URL returned `502`. Both auth Lambdas now use a
    10s timeout and 256 MB (the handler used ~115 MB of the 128 MB default —
    near OOM). Adds synth assertions.
  - **Rebundles the `auth-verify`/`auth-signout` handlers** carrying the
    `@de-otio/vestibulum` 0.3.3 fix that returns Set-Cookie via the Function
    URL `cookies` array instead of `multiValueHeaders` (which Function URLs
    drop), so a successful sign-in actually sets the `id-token` cookie.

## 0.3.21

### Patch Changes

- Make browser magic-link **sign-in completion** work. `/auth-verify` (and
  `/auth-signout`) are Lambda Function URLs behind CloudFront OAC, and a browser
  POST to them failed at the edge — so the login page loaded but sign-in could
  never finish. Two fixes, both per AWS's OAC-for-Lambda-Function-URL docs:

  - **Grant `lambda:InvokeFunction` in addition to `lambda:InvokeFunctionUrl`.**
    CDK's `FunctionUrlOrigin.withOriginAccessControl` only adds
    `InvokeFunctionUrl`; AWS requires **both** for OAC, so a correctly-signed
    POST was rejected at the Function URL auth layer with `403 Forbidden` and the
    handler never ran. The construct now adds an `InvokeFunction` permission for
    the CloudFront service principal (scoped to the distribution via
    `AWS:SourceArn`) on both auth Function URLs.
  - **Client sends `x-amz-content-sha256`.** OAC-signed `POST`/`PUT` to a Lambda
    Function URL requires the client to send the SHA-256 of the body in the
    `x-amz-content-sha256` header (Lambda doesn't accept unsigned payloads);
    CloudFront then SigV4-signs the origin request. `login-callback.js` now
    computes the body hash with `crypto.subtle` and sends it. (Any other client
    that POSTs to `/auth-signout` must do the same.)

  Adds synth assertions for both grants and a live HTTP e2e
  (`atrium/e2e/auth-verify-http.e2e.ts`) covering the missing-hash, wrong-Origin,
  success, and single-use-replay cases.

## 0.3.20

### Patch Changes

- Fix the login-page CloudFront Function failing to deploy. 0.3.19 set an
  explicit `functionName` (`<prefix>AuthSiteLoginRewrite-<region>-<domain>`)
  that overflows CloudFront's 64-char function-name limit for ordinary domains
  (e.g. `atrium.dev.de-otio.org` → 66 chars), so the stack rolled back with an
  `InvalidRequest` validation error. The explicit name is dropped; CDK
  auto-generates a bounded, unique, valid name (`<region>` + a ≤40-char hash).
  Adds a regression test asserting every CloudFront Function name is ≤64 chars
  and matches `[a-zA-Z0-9_-]`.

## 0.3.19

### Patch Changes

- Make the magic-link login page actually load and function. The CloudFront
  front door served the login UI but the page never resolved end-to-end.

  - **`/login` returned 403.** The `/login` and `/login/callback` cache
    behaviours forwarded the extensionless path straight to the S3 login-page
    bucket via OAC, so CloudFront requested keys `login` / `login/callback`
    while the objects are `login.html` / `login-callback.html` — the OAC origin
    answered 403 for the missing key. The two exact behaviours are replaced by a
    single `/login*` behaviour plus a viewer-request CloudFront **Function** that
    rewrites `/login → /login.html` and `/login/callback → /login-callback.html`.
  - **Page assets fell through to the auth gate.** Because the old behaviours
    were exact matches, the page's own `login.css` / `login.js` resolved to
    `/login.css` / `/login.js`, which matched the default behaviour and were
    redirected to `/login` by the check-auth Lambda@Edge. The `/login*` prefix
    behaviour now serves all login assets without the gate.
  - **The client logic was missing entirely.** `login.html` / `login-callback.html`
    referenced `login.js` / `callback.js` that did not exist. Added `login.js`
    (browser-side Cognito `InitiateAuth` CUSTOM_AUTH → stash `{email, session}`)
    and `login-callback.js` (read the fragment token, POST `{session,
    challengeAnswer, email}` to `/auth-verify`, redirect on success). The public
    website-client id + region are injected at deploy via a `login-config.json`
    BucketDeployment source.
  - **Login-scoped CSP.** A separate response-headers policy applied only to
    `/login*` permits `connect-src` to the regional Cognito IDP endpoint (needed
    for the browser `InitiateAuth` call); the app's default CSP stays
    `connect-src 'self'`.

## 0.3.18

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

## 0.3.17

### Patch Changes

- Fix the `preTokenGenerationVersion: 'V2_0'` override so the pool actually
  deploys. The first cut set only `PreTokenGenerationConfig.LambdaVersion`, but
  the L2 `lambdaTriggers` also sets the legacy `LambdaConfig.PreTokenGeneration`
  (ARN) field, and Cognito rejects a pool that carries both
  ("Cannot use PreTokenGenerationLambda and PreTokenGeneration with different
  Lambda function ARN's"). Now set the full `PreTokenGenerationConfig` (version +
  ARN) and delete the legacy field; the Cognito→Lambda invoke permission from the
  L2 is retained.

## 0.3.16

### Patch Changes

- Add `preTokenGenerationVersion` to `MagicLinkIdentity` (`'V1_0' | 'V2_0'`,
  default `'V1_0'`). The CDK L2 `lambdaTriggers.preTokenGeneration` always wires
  the trigger as V1, so a handler returning the V2 response shape
  (`claimsAndScopeOverrideDetails`) had its claims silently dropped by Cognito —
  custom claims like `read_spaces`/`tenant_id` never reached the issued tokens.
  Setting `'V2_0'` overrides the pool's `PreTokenGenerationConfig.LambdaVersion`
  (requires an `Essentials`/`Plus` feature plan).

## 0.3.15

### Patch Changes

- Auto-confirm magic-link sign-ups. The PreSignUp trigger validated the email
  domain, signup mode, and rate limit but never set `autoConfirmUser` /
  `autoVerifyEmail`, so the user stayed UNCONFIRMED. The passwordless CUSTOM_AUTH
  flow could start (the magic-link email was sent) but the first
  `RespondToAuthChallenge` failed with `UserNotConfirmedException` — sign-in could
  never complete. PreSignUp now confirms the user and marks the email verified
  once the allow-list/rate-limit/mode checks pass (possession of the emailed link
  proves email ownership; there is no password to verify).

## 0.3.14

### Patch Changes

- Grant the VerifyAuthChallenge trigger read access to the token table. It does a
  `GetItem` to validate the submitted magic-link token before consuming it
  (`DeleteItem`), but the construct only granted write, so Cognito returned
  `VerifyAuthChallengeResponse failed: ... not authorized to perform
dynamodb:GetItem on ... TokenTable`. Changed `grantWriteData` →
  `grantReadWriteData`.

## 0.3.13

### Patch Changes

- Grant the CreateAuthChallenge trigger `ses:SendEmail` / `ses:SendRawEmail` on
  the magic-link sender identity. The handler sends the magic-link email via SES,
  but the construct never granted it, so the trigger threw and Cognito returned
  `CreateAuthChallenge failed: ... not authorized to perform ses:SendEmail on
resource arn:aws:ses:...:identity/<domain>` — no magic-link email could be
  sent. Scoped to the construct's verified sender identity ARN.

## 0.3.12

### Patch Changes

- Set `VESTIBULUM_DOMAIN` on the `MagicLinkIdentity` trigger Lambdas. The
  CreateAuthChallenge handler builds the magic-link URL
  (`https://<domain>/login/callback#token=...`) from `VESTIBULUM_DOMAIN`, but the
  construct never set it, so the handler threw and Cognito returned the generic
  `UserLambdaValidationException: CreateAuthChallenge failed with error
Authentication failed` — magic-link sign-in could not issue a challenge. It is
  now defaulted to the SES sender apex (which equals the front-door domain in the
  apex-aligned topology and must match the `domain` passed to
  `MagicLinkAuthSite`, which serves `/login/callback`).

## 0.3.11

### Patch Changes

- Make the DefineAuthChallenge Cognito trigger handler `async`. It was the only
  synchronous handler, and the AWS Lambda Node.js runtime **ignores the return
  value of a non-async handler** (a sync handler must use the `callback`
  argument). So the trigger resolved to `null`, and Cognito rejected the
  CUSTOM_AUTH flow at `InitiateAuth` with `InvalidLambdaResponseException: Invalid
lambda function output : Invalid JSON` — magic-link sign-in could never start.
  Returning a Promise makes the runtime await and return the populated event.
  The handler had no unit test (which is how it shipped sync); added coverage
  that pins both the state-machine output and that the handler is async.

## 0.3.10

### Patch Changes

- Fix DynamoDB key-name mismatches between the magic-link Cognito-trigger
  handlers and the table schemas, which made sign-up and the auth challenge fail
  at runtime with `ValidationException: The provided key element does not match
the schema`. The handlers' shipped bundles addressed three tables by the wrong
  partition-key attribute name:

  - **RateLimitTable** partition key is `bucket_id`, but the PreSignUp rate-limit
    used `pk` and the CreateAuthChallenge rate-limit used `rate_key`.
  - **DenylistTable** partition key is `email_hmac`, but the CreateAuthChallenge
    quarantine check (read) and the bounce-handler denylist write used
    `email_hash`.

  All handlers now address the tables by their actual schema keys (`bucket_id`,
  `email_hmac`; TokenTable's `token_hash` was already correct). These paths had
  unit tests with mocked DynamoDB but were never exercised against the real
  table schema, so the drift went unnoticed. Bundles rebuilt, lock regenerated.

## 0.3.9

### Patch Changes

- Stop externalising `aws-jwt-verify` in the regional Lambda bundles (Cognito
  triggers: pre-signup, pre-token-generation, post-confirmation, the CUSTOM_AUTH
  challenge handlers, bounce-handler, plus the auth-verify / auth-signout
  function-URL handlers). Every regional handler pulls `aws-jwt-verify` in
  transitively through the `@de-otio/vestibulum` barrel, and an externalised bare
  ESM `import` of it is eager — but the Lambda managed runtime does not provide
  `aws-jwt-verify` and no layer/node_modules ships it, so the function crashed at
  load with `Cannot find package 'aws-jwt-verify' imported from
/var/task/index.mjs`. This broke sign-up at the PreSignUp trigger
  (`UserLambdaValidationException`). `aws-jwt-verify` is zero-dependency, so it is
  now inlined into each regional bundle (only `@aws-sdk/*`, which the runtime does
  provide, stays external). All 12 bundles rebuilt, lock regenerated.

## 0.3.8

### Patch Changes

- Run the `MagicLinkAuthSite` check-auth Lambda@Edge function on `NODEJS_22_X`
  (was `NODEJS_20_X`). The inlined bundle pulls in undici, whose request
  internals destructure `markAsUncloneable` from `node:worker_threads` — a Node
  22.5+ API. On the node20 runtime that symbol is `undefined`, so the function
  died on init with `TypeError: ...markAsUncloneable is not a function` and
  CloudFront returned `503 LambdaExecutionError` on every request (this was the
  next failure exposed once the 0.3.7 dynamic-require crash was fixed).

  Lambda@Edge supports the current node22 runtime, so check-auth now runs there;
  the edge bundle's esbuild `target` is bumped from `node20` to `node22` to match
  (all 12 bundles rebuilt, lock regenerated).

## 0.3.7

### Patch Changes

- Fix the Lambda@Edge `check-auth` bundle crashing on init with
  `Dynamic require of "node:os" is not supported`, which made the
  `MagicLinkAuthSite` front door return `503 LambdaExecutionError` on every
  request (the function died before the handler ran, so nothing reached
  CloudWatch).

  The shipped bundles are ESM (`format: "esm"`, `index.mjs`). The edge bundle
  inlines `aws-jwt-verify` (only the AWS SDK is externalised for Lambda@Edge),
  and a transitive dependency does a runtime `require("node:os")`. esbuild
  rewrites that to its `__require` shim, which throws in an `.mjs` module because
  there is no global `require`. The shim guards on `typeof require !== "undefined"`
  first, so the build now prepends a `createRequire` banner
  (`const require = createRequire(import.meta.url)`) that defines a real
  top-level `require` — the dynamic require then resolves instead of throwing.
  All 12 bundles are rebuilt and the committed bundle lock is regenerated.

## 0.3.6

### Patch Changes

- Fix two `MagicLinkIdentity` bugs that made a cold-domain deploy fail to
  converge and then fail to roll back. Both surface only on a real, never-yet-
  verified SES sender domain, which is why the 0.3.5 verification-wait (correct
  in itself) is what exposed them.

  - **DKIM CNAME records were created with a doubled domain suffix.** The records
    were named from `sesIdentity.dkimDnsTokenName{1,2,3}`, a deploy-time
    CloudFormation attribute that resolves to the _already_ fully-qualified
    `<token>._domainkey.<sender>`. CDK's `RecordSet` decides whether to append
    the zone apex with a **synth-time** `recordName.endsWith(zoneName)` check;
    against an opaque token that check always fails, so CDK appended the zone
    again, producing `<token>._domainkey.<sender>.<zone>`. SES never finds the
    records, DKIM stays `PENDING`, and the verification-wait runs to its 45-min
    timeout. Fixed by marking the record name absolute (trailing dot), which
    short-circuits the append. (`ses.Identity.domain(senderDomain)` is kept
    rather than the records-auto-creating `publicHostedZone()` helper, because
    the sender may legitimately be a subdomain of the hosted zone — which the
    zone-apex-keyed `publicHostedZone()` would get wrong.)
  - **The verification-wait `onEvent` handler changed the physical resource id on
    Delete.** It recomputed `ses-verify-<domain>` on every event. When the async
    waiter's CREATE never completes (the domain never verifies) and the stack is
    then deleted, CloudFormation still holds the framework's _placeholder_
    physical id — so recomputing a different value on Delete violates
    CloudFormation's "physical id may not change during deletion" rule and wedges
    the stack in `DELETE_FAILED`. The handler now echoes
    `event.PhysicalResourceId` on Update/Delete, making teardown id-stable
    regardless of how the CREATE ended.

## 0.3.5

### Patch Changes

- Fix a deploy-time bug that made `MagicLinkIdentity` impossible to deploy on a
  cold (unverified) SES domain. The construct creates the SES `EmailIdentity`
  (DKIM) and Route 53 DKIM/SPF/DMARC records, then a Cognito user pool with
  `UserPoolEmail.withSES({ sesVerifiedDomain })`. Cognito validates the domain
  is verified for sending at pool-creation time, but SES DKIM verification is
  asynchronous (minutes). On a fresh domain the pool's CREATE failed
  ("Email address is not verified … identity/&lt;domain&gt;") and the stack
  rolled back, never converging.

  - **SES domain verification-wait.** A CloudFormation custom resource backed by
    `custom_resources.Provider` (async-polling `onEvent` + `isComplete`
    handlers) now blocks until SESv2 `GetEmailIdentity` reports the domain
    verified for sending (`queryInterval` 30s, `totalTimeout` 45 min). The
    custom resource depends on the three DKIM CNAME records and the SES
    identity; the Cognito pool depends on the custom resource, so the pool only
    CREATEs once the domain is actually usable. Handlers are inline
    (`lambda.Code.fromInline`) on `NODEJS_22_X` — no addition to the
    lambda-bundles pipeline. Targeted `NagSuppressions` cover the Provider
    framework + handler findings (IAM4/IAM5/L1).
  - **SES identity removal policy RETAIN → DESTROY.** With the verification-wait
    making cold deploys converge, the SES `EmailIdentity` now uses
    `RemovalPolicy.DESTROY`. RETAIN previously left a PENDING identity behind on
    a failed deploy, which then collided ("EmailIdentity already exists") on the
    next attempt and blocked recovery; DESTROY lets a failed deploy clean up
    fully and retry from a clean slate.

## 0.3.4

### Patch Changes

- Fix two bugs that made `MagicLinkAuthSite` unusable as published:
  - The package `files` list omitted `login-pages/`, so `MagicLinkAuthSite`'s
    `BucketDeployment` failed at synth with `CannotFindAsset`. The login pages
    are now shipped in the tarball.
  - `MagicLinkIdentity` never implemented `addAppClient`, although its
    `IMagicLinkIdentity` interface declares it and `MagicLinkAuthSite` calls it
    to create the website client. The method is now implemented (CUSTOM_AUTH
    forced on, password/SRP off, `generateSecret: true` rejected) with test
    coverage and a signature guard.

## 0.3.3

### Patch Changes

- Rebuild the shipped Lambda bundles with esbuild 0.28 (from 0.21) and refresh
  the committed bundle lock for vestibulum 0.3.1. Functionally equivalent
  bundles; no construct API change.

## 0.3.1

### Patch Changes

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

## 0.3.0

### Minor Changes

- fd0af90: Custom CloudWatch metrics in shared-distribution mode now carry a
  `tenantId` dimension, enabling per-tenant attribution in Cost Explorer
  and CloudWatch. Cardinality trade-off documented in
  `doc/vestibulum-cdk/08-metrics.md`. Cost-pillar review N6 (follows S2).
- 2916da9: S3 buckets created by `magic-link-auth-site` and
  `shared-distribution-identity` now apply a default lifecycle policy:
  abort incomplete multipart uploads after 7 days, transition
  immutable-asset objects to Standard-IA after 30 days, expire old
  object versions where versioning is on. Override via the new
  `lifecycle` prop. Cost-pillar review S4.
- 536e7ed: `MagicLinkIdentity` and `SharedDistributionIdentity` accept an optional
  `costDosGuard: { enabled, sendsPerHourCap, selfDefence? }` prop that
  brings SES sends inside the documented cost-DoS envelope. Enabled,
  deploys a CloudWatch alarm on SES sending statistics and (with
  `selfDefence: true`) a handler that gates Cognito sign-up when the
  alarm fires. Reserved-concurrency caps in magic-link-auth-site
  documented as cost-DoS controls, not perf knobs. Cost-pillar review
  S7, N5.

### Patch Changes

- 6f6b639: Documentation: per-tenant cost attribution model for shared-distribution
  mode (S2), "Before going live" cookbook subsection covering AWS Budgets
  and Cost Anomaly Detection (N1), a quarterly cost-pillar-checkup
  template (N7), and a RETAIN-policy watch-out for ephemeral CI / preview
  environments. Cost-pillar review S2, N1, N7.

## 0.2.0

### Minor Changes

- Add `SharedDistributionIdentity` construct: shared Cognito pool + CloudFront wildcard distribution + multi-aud Lambda@Edge + tenant-onboarding admin Lambda. Pure-data tenant onboarding (no `cdk deploy` per tenant).

## 0.1.0

### Minor Changes

- Initial release: magic-link auth, multi-pool JWT verifier, Cognito trigger factories, Lambda@Edge check-auth, admin Lambda bundles, and CDK constructs (MagicLinkIdentity, MagicLinkAuthSite, EdgeResources).
