# Cost attribution in shared-distribution mode

Shared-distribution mode is designed around a single-blast-radius,
single-infrastructure-deployment serving N tenants. The cost win is
real and measurable (see the comparison table in
[`01-architecture.md:122-145`](01-architecture.md)). The trade-off is
that most of the bill is amortised across those N tenants, which makes
per-tenant attribution harder than in the N-CloudFront prototype.

This doc covers what is and is not attributable, how to build a proxy
metric approach that gives reasonable attribution, the cost curve as
tenant count scales, and how to back it into a chargeback or pricing
model. It does not require any code change — N6 (adding `tenantId`
dimensions to custom metrics) is the implementation-level follow-up.

## Amortised vs. metered line items

### Not per-tenant attributable (amortised across the identity)

The following resources are deployed once per `SharedDistributionIdentity`
and their AWS costs do not vary with which tenant generated a given
request:

| Resource                                      | Cost driver                                      |
| --------------------------------------------- | ------------------------------------------------ |
| CloudFront distribution                       | Data transfer out + HTTP request count (pooled)  |
| ACM wildcard cert (`us-east-1`)               | Free when attached to CloudFront                 |
| Route 53 wildcard A-record                    | $0.40/hosted zone + $0.40/million queries        |
| Lambda@Edge `check-auth`                      | Invocations + duration (pooled — no env vars, no per-tenant segregation; see [review B4](../../review/2026-05-25-shared-distribution-design-review.md)) |
| WAF WebACL (CloudFront-side)                  | $5/month WebACL + $1/million requests            |
| WAF WebACL (Cognito-side)                     | $5/month WebACL + $1/million requests            |
| Cognito user pool (base)                      | Free tier; per-MAU above 50k                     |
| `ClientConfig` DDB table (provisioned once)   | Trivial (KB/row; capacity shared across tenants) |
| `MagicLinkTokens` DDB table                   | Trivial (KB/token; TTL-expired rows billed until deletion lag) |

CloudFront access logs go to the account-level S3 bucket and carry
`cs-host` (the subdomain, which is the tenant identifier), but there
is no cost per access-log line by tenant in the billing dimension
CloudFront exposes — total data-transfer and request-count are pooled.
Lambda@Edge invocations are similarly not subdomain-splittable in the
CloudFront billing console because Lambda@Edge has no environment
variables and therefore cannot emit tenant-tagged CloudWatch metrics
from the edge itself.

### Metered and attributable (per tenant, with instrumentation)

The following line items *can* be attributed per tenant if the
consuming code emits `tenantId` at the point of activity:

| Resource                         | Attribution method                                                        | Current status                                                |
| -------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Cognito trigger Lambda invocations | `tenantId` must be present in the trigger log entry (derived from `ClientConfig` lookup on `event.callerContext.clientId`) | Verify in `magic-link-identity.ts` trigger paths |
| SES sends                        | Emit `tenantId` at send time in the magic-link send path                  | Verify in the `auth-verify` → SES send path                  |
| DDB `ClientConfig` rows          | 1 row per tenant; trivial cost indicator; zero extra instrumentation      | Already attributable                                         |
| DDB `MagicLinkTokens` rows       | Row count per tenant is a proxy for active magic-link volume; query by `tenantId` SK prefix | Attributable if `tenantId` is part of the key scheme |

Note: edge-function invocations cannot be attributed per tenant
regardless of instrumentation — Lambda@Edge cannot emit custom
CloudWatch metrics with a `tenantId` dimension because it has no env
vars and because CloudWatch PutMetricData from Lambda@Edge replicas
runs in the `us-east-1` account scope without tenant context wired in.

## Proxy-metric approach

Until per-request cost attribution from the edge is feasible, the
proxy-metric pattern gives a useful approximation:

1. **Emit `tenantId` on every CloudWatch log entry that passes through a
   tenant-aware code path.** The Cognito trigger Lambdas, the `auth-verify`
   Function URL handler, the admin Lambda, and the reconciler all have
   `tenantId` in scope and should include it as a structured log field
   on every log entry they emit.

2. **Publish custom CloudWatch metrics with a `tenantId` dimension** for
   events that directly correspond to chargeable activity: magic-link
   sends, Cognito challenge created / verified, token issued. These are
   the N6 follow-up; see
   [`../../review/2026-05-29-cost-pillar-review.md`](../../review/2026-05-29-cost-pillar-review.md)
   § N6.

3. **Use CloudWatch Logs Insights against the tenant-tagged log entries**
   to derive per-tenant activity counts at cost-reporting time. A query
   like `filter tenantId = "acme" | stats count() by bin(1d)` against the
   trigger Lambda log group gives the raw invocation count attributable to
   `acme` in a given period.

4. **Accept that the amortised pool (CloudFront, WAF, Cognito base) is
   split pro-rata by activity count.** Each tenant's share of the
   amortised cost is `(tenant_invocations / total_invocations) * amortised_cost`.
   This is the standard SaaS cost-attribution approximation when the
   infrastructure is truly shared; it is what every multi-tenant SaaS
   uses for shared-tier offerings.

## Amortised-vs-metered split at scale

Rough numbers at AWS eu-central-1 list prices (2026-Q2). These are
order-of-magnitude to show the curve, not a billing audit. Assumptions:
one identity, 5 magic-link logins per tenant per day, 2 KB/request for
the edge function, 0.2 KB per DDB row.

| Scaling point | Monthly amortised cost (CloudFront + WAF + Cognito + R53) | Monthly metered cost (Lambda invocations + SES + DDB I/O) | Metered / Total |
| ------------- | --------------------------------------------------------- | --------------------------------------------------------- | --------------- |
| 10 tenants    | ~$17/mo                                                   | ~$1/mo                                                    | ~5%             |
| 100 tenants   | ~$19/mo                                                   | ~$10/mo                                                   | ~35%            |
| 1,000 tenants | ~$30/mo                                                   | ~$100/mo                                                  | ~77%            |

Key observations:

- At 10 tenants the infrastructure-overhead-per-tenant cost (~$1.70/mo)
  dwarfs the metered cost per tenant (~$0.10/mo). Shared-distribution
  mode is not cost-optimal at this point; the N-CloudFront prototype
  costs roughly the same per-tenant but with worse onboarding UX.
- At 100 tenants the amortised cost per tenant drops to ~$0.19/mo.
  The shared-distribution economics start to show clearly.
- At 1,000 tenants the amortised cost per tenant is ~$0.03/mo and the
  metered cost is ~$0.10/mo. The distribution is metering-dominated;
  each tenant pays roughly its fair share via per-invocation billing.
- WAF is the dominant amortised line item at low tenant counts ($10/mo
  for two WebACLs). Consumers who need to manage cost at <20 tenants
  can opt out of WAF on the Cognito-side WebACL (see
  [`07-security-and-isolation.md`](07-security-and-isolation.md) §
  WAF posture). Not recommended for production workloads.

Cognito per-MAU pricing (above 50k MAU free tier): $0.0055/MAU for
the standard tier. At 1,000 tenants with an average of 50 monthly
active users each, total MAU is 50k — exactly at the free tier. Past
this point Cognito per-MAU becomes the dominant growing line item and
should feed directly into per-seat pricing.

## Chargeback model guidance

### Per-seat model

The straightforward approach for B2B SaaS:

1. **Fixed per-seat price** covers the amortised pool split pro-rata
   by seat count: `amortised_cost / total_seats`.
2. **Variable per-seat charge** covers the metered activity: Cognito
   MAU cost + SES send cost. CloudWatch Logs Insights queries against
   tenant-tagged logs give the raw counts; multiply by the list price
   per unit.
3. **Amortised pool split** is billed once per month by dividing total
   amortised cost by total active tenants (not seats). A tenant with 1
   seat and a tenant with 100 seats pay the same share of the WAF and
   CloudFront base cost. This is acceptable at high tenant counts; at
   low tenant counts the per-tenant overhead cost exceeds most
   per-tenant budgets and signals you are not yet at shared-distribution
   scale.

### Per-tenant (flat) model

Appropriate when tenants are priced at a monthly flat rate regardless
of usage:

1. Set the flat monthly rate above the per-tenant overhead cost at the
   expected scaling point. Using the numbers above, a tenant at the
   100-tenant scale point costs ~$0.29/mo all-in. A $49/month flat rate
   has very comfortable gross margin; a $1/month flat rate does not.
2. Use the per-tenant activity metrics (magic-link sends, Cognito
   trigger invocations) as an anomaly signal, not a billing input. A
   tenant consuming 10× the average invocation rate is a free-tier abuse
   candidate or a throttling candidate; both need attention before they
   move the metered line significantly.

### Usage-based model

If the consumer wants to charge by event (e.g. per login or per
magic-link sent):

1. The tenant-tagged SES send metric gives the login-initiation count
   directly.
2. The Cognito `VerifyAuthChallengeResponse` trigger invocation count
   gives the successful-authentication count.
3. The amortised pool is a cost floor that must be covered by the
   usage revenue before any margin is earned. At 10 tenants and a
   $0.10/login price, the amortised cost is recovered after ~170 logins
   across the identity per month — well within realistic usage at that
   scale.

## See also

- [`01-architecture.md`](01-architecture.md) — the amortised-vs-metered
  topology table and N-CloudFront vs. shared-distribution comparison.
- [`08-observability-and-audit.md`](08-observability-and-audit.md) —
  the CloudWatch metrics catalogue; this doc's N6 items live there.
- [`../../review/2026-05-29-cost-pillar-review.md`](../../review/2026-05-29-cost-pillar-review.md)
  § S2 and N6 — the review findings this doc addresses.
