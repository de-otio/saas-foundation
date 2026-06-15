# @de-otio/vestibulum-cdk

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
