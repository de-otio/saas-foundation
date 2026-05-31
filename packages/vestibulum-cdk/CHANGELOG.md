# @de-otio/vestibulum-cdk

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
