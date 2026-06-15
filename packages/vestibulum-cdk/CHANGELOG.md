# @de-otio/vestibulum-cdk

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
