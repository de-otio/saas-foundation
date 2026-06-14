# `@de-otio/saas-foundation-cdk` — design notes

The fourth published package. AWS CDK constructs for the deployment
plumbing every house backend needs, independent of identity topology.

Position and dependency arrows: see
[`../09-foundation-cdk-package.md`](../09-foundation-cdk-package.md).

## What it ships

Five pieces, each with its own design note:

- [`01-package-api.md`](01-package-api.md) — exports surface,
  `package.json` shape, sub-paths.
- [`02-nodejs-lambda.md`](02-nodejs-lambda.md) — `NodejsLambda`
  construct: `NodejsFunction` + house defaults (ARM64, X-Ray,
  log retention, error/throttle alarms, optional Prisma bundling).
- [`03-queue-with-dlq.md`](03-queue-with-dlq.md) — `QueueWithDlq`
  construct: SQS queue + DLQ + DLQ-non-empty alarm.
- [`04-single-table.md`](04-single-table.md) — `SingleTable`
  construct: DynamoDB single-table design (`pk`/`sk` + optional `gsi1`),
  PITR, read/write-spike alarms.
- [`05-dashboards.md`](05-dashboards.md) — house CloudWatch
  dashboard templates (api-health, database, workers) shipped as
  JSON assets with a small substitution helper.
- [`06-aspects.md`](06-aspects.md) — `HouseDefaultsAspect` and
  `HouseTaggingAspect`: opt-in CDK Aspects that warn on raw
  `aws-cdk-lib` resources and enforce cost-allocation tagging.

## What it does not ship

- WAF rule packs.
- VPC / NAT-instance / ALB / ACM / Route53 helpers.
- Pre-assembled stacks (api-stack, workers-stack, etc.).
- Lambda artifacts.

Rationale and deferred-list detail in
[`../09-foundation-cdk-package.md § Out of scope`](../09-foundation-cdk-package.md#out-of-scope-deferred-to-v02).

## Source patterns

Each construct's design transplants and generalises an existing
working pattern from `trellis/infra/lib/constructs/` and
`trellis/infra/lib/dashboards/`. The trellis implementations are
production-tested (one consumer, but a real one); the migration is
mostly removing the trellis-specific source-path hardcodes and
shipping the result behind a constructed API.

## Status

Implemented. The constructs in this directory are built and tested in
`packages/foundation-cdk/`. The construct API is still pre-1.0 and may
change; the per-doc § Open questions sections flag the calls most
likely to move.
