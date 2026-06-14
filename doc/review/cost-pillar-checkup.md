# Cost-pillar checkup template

Quarterly review for the *Optimize over time* focus area of the
[AWS Well-Architected Cost Optimization Pillar](https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html).
Fill in the defaults table, record findings, and date the entry.
Prior completed checkups accumulate below the template; newest first.

The cost pillar's *Optimize over time* practice asks teams to
re-evaluate cost defaults quarterly as AWS prices, free tiers, and
service capabilities change. This template is cheap to fill in and
compounds across years — a 15-minute pass per quarter saves
disproportionate time compared with a reactive post-bill investigation.

---

## Template

**Date:** YYYY-QN (e.g. 2026-Q3)
**Reviewer:**
**Packages reviewed:** `@de-otio/saas-foundation-cdk`,
`@de-otio/vestibulum-cdk` (add others if relevant)

### Defaults table

Fill in the current value for each default. Flag any that have drifted
from the documented default or from the previous checkup.

| Setting                         | Current default (in code)                | Last-checkup value | Notes / action |
| ------------------------------- | ---------------------------------------- | ------------------ | -------------- |
| PITR window (DDB tables)        |                                          |                    | See S3 finding; 7d recommended. Link to doc when S3 lands. |
| CloudFront Price Class          |                                          |                    | `PRICE_CLASS_100` (EU + US). Raise only with explicit consumer opt-in. |
| ARM / x86 Lambda ratio          |                                          |                    | All Lambda constructs default ARM64. Flag any x86 outliers. |
| Log retention — `NodejsLambda`  |                                          |                    | |
| Log retention — trigger Lambdas |                                          |                    | |
| Log retention — reconciler      |                                          |                    | |
| Log retention — edge function   |                                          |                    | Lambda@Edge log groups in `us-east-1`; retention set separately. |
| Log storage class               |                                          |                    | Standard vs. Infrequent Access. CloudWatch Logs IA is ~50% cheaper for infrequently queried groups. |
| CMK count (customer-managed KMS keys) |                                    |                    | $1/key/month each. Count keys created by constructs. |
| CloudWatch alarm count          |                                          |                    | $0.10/alarm/month above 10 free. Count construct-created alarms. |
| CloudWatch dashboard count      |                                          |                    | $3/dashboard/month. Count construct-created dashboards. |
| X-Ray tracing mode              |                                          |                    | `ACTIVE` by default (see N4 finding). Free below 100k traces/month; $5/million above. |
| Reserved concurrency (auth-verify) |                                       |                    | Default 20. Raising this widens the cost-DoS envelope (see N5). |
| Reserved concurrency (auth-signout) |                                      |                    | Default 5. Same caveat. |
| PITR enabled                    |                                          |                    | Always on; this row tracks the window, not the on/off toggle. |

### AWS price changes since last checkup

List any relevant price changes announced since the previous checkup.
Sources: [AWS Pricing History](https://aws.amazon.com/pricing/), the
AWS blog, and the monthly billing console diff.

| Service | Change | Effective date | Impact on this package |
| ------- | ------ | -------------- | ---------------------- |
|         |        |                |                        |

### New AWS services worth evaluating

List new or updated AWS services that could replace a current
implementation with lower cost or better operational properties.
Examples in prior cycles: DynamoDB Standard-IA storage class,
CloudFront Logs v2, Lambda function response streaming.

| Service / feature | Potential use | Evaluation status |
| ----------------- | ------------- | ----------------- |
|                   |               |                   |

### Findings opened

List any cost findings identified during this checkup. Use the same
severity scale as the design reviews (BLOCKER / SIGNIFICANT / NIT).
Link to the doc or code location.

| ID   | Severity | Area | File / construct | Description |
| ---- | -------- | ---- | ---------------- | ----------- |
|      |          |      |                  |             |

### Action items

| Action | Owner | Due |
| ------ | ----- | --- |
|        |       |     |

---

**Next review due:** YYYY-QN+1

---

## Completed checkups

<!-- Newest first. Copy the template block above, fill it in, and paste here. -->
