# @de-otio/saas-foundation-cdk

## 0.3.0

### Minor Changes

- f74c1f5: Add `HouseTaggingAspect` for cost-allocation tagging (`Environment`,
  `Service`, `CostCenter`, `Owner`). Synth-time validation fails if a
  stack contains house constructs but the aspect was not applied. Maps
  to the AWS Well-Architected Cost Optimization Pillar Practice Cloud
  Financial Management focus area.
- d33b19e: `SingleTable` PITR retention default is now 7 days (was 35). Tables
  created without an explicit `pitrRetention` prop will use the
  documented recovery-window starting point. Override via the existing
  prop. Synth-time annotation fires for windows > 14 days, mirroring
  the Advanced Security pattern. Cost-pillar review S3.
- 2c9ddfd: `NodejsLambda` adds a `logClass: 'standard' | 'infrequent-access'` prop
  (default `'standard'`). IA storage is ~50% cheaper than Standard with
  the trade-off that Logs Insights queries cost more per scanned GB; pick
  IA for write-heavy/read-rare streams (audit, bounce-handler). Doc adds
  recurring-cost disclosure (alarms, X-Ray, log retention) and a Lambda
  Power Tuner reference. Cost-pillar review S6, S5, N3, N4.

### Patch Changes

- 6f6b639: Documentation: per-tenant cost attribution model for shared-distribution
  mode (S2), "Before going live" cookbook subsection covering AWS Budgets
  and Cost Anomaly Detection (N1), a quarterly cost-pillar-checkup
  template (N7), and a RETAIN-policy watch-out for ephemeral CI / preview
  environments. Cost-pillar review S2, N1, N7.
- 2489bf1: Document recurring per-construct costs for `QueueWithDlq` (1 alarm
  default) and `houseDashboard()` (CloudWatch dashboards cross the
  account-wide free tier quickly). Cost-pillar review S5.

## 0.2.0

### Minor Changes

- Initial public release. Generic AWS CDK constructs for deployment plumbing independent of identity topology: `NodejsLambda` (with error/throttle/duration/iterator-age alarms), `QueueWithDlq`, `SingleTable`, house CloudWatch dashboard templates, and the opt-in `HouseDefaultsAspect` compliance enforcer.
