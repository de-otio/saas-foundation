# 08 — Metrics

Both `MagicLinkIdentity` and `MagicLinkAuthSite` expose a `metrics`
namespace with named `cloudwatch.Metric` instances so consumers
don't have to assemble metric dimensions from scratch.

Consumers attach their own alarms — vestibulum-cdk's scope ends at
exposing the metrics. Notification channels and on-call rotations
are consumer infrastructure.

## `identity.metrics`

| Metric                  | Source                                                  | Notes                                                            |
| ----------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| `signUpSuccesses`       | Cognito service metric                                  | Signup completions; baseline traffic signal                      |
| `signInSuccesses`       | Cognito service metric                                  | Sign-in completions via custom-auth challenge-response           |
| `tokenRefreshSuccesses` | Cognito service metric                                  | Refresh-token exchanges; spike = client retry storm              |
| `challengeFailures`     | Cognito service metric                                  | Failed custom-auth challenge responses — mailbomb / abuse signal |
| `preSignUpRejections`   | Custom metric emitted by the bundled `PreSignUp` Lambda | Domain-allowlist rejections                                      |
| `sesBounceRate`         | SES metric via the bounce handler                       | Hard-bounce rate; alarm above ~5%                                |
| `sesComplaintRate`      | SES metric                                              | Complaint rate; AWS will throttle if > 0.1%                      |

## `site.metrics`

| Metric                 | Source                                            | Notes                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `distributionRequests` | CloudFront service metric                         | Request count                                                                                                                                                                                                                                                                                                    |
| `distributionErrors`   | CloudFront service metric                         | 4xx + 5xx rate                                                                                                                                                                                                                                                                                                   |
| `edgeAuthDenies`       | Custom metric emitted by `check-auth` Lambda@Edge | Denials. Logs are suppressed (mandatory mitigation) but `cloudwatch:PutMetricData` is allowed via a narrowly-scoped IAM statement. **Sampled at 1/100 by default** (see [Emission costs](#emission-costs)) and **emitted to the home region**, not the edge region, to keep the data-residency story consistent. |
| `authVerifyErrors`     | `auth-verify` Function URL metric                 | 5xx rate                                                                                                                                                                                                                                                                                                         |

The `MagicLinkAuthSite` construct itself exposes only the namespace
handle:

```typescript
interface AuthSiteMetricsNamespace {
  readonly namespace: string; // default 'Vestibulum/AuthSite';
  // overridable via the metricsNamespace prop.
}
```

`site.metrics` is an `AuthSiteMetricsNamespace`. The per-metric
`cloudwatch.Metric` handles for the table above are built by the
`buildAuthSiteMetrics(...)` helper described in
[§ Metric builders](#metric-builders); the equivalent for the
identity table is `buildIdentityMetrics(...)`.

## Metric builders

The per-metric `cloudwatch.Metric` handles are produced by two
builder functions exported from the package barrel
(`lib/metrics/index.ts`), separated from the construct classes so the
metric shapes are testable without a full CDK stack:

```typescript
import {
  buildIdentityMetrics,
  buildAuthSiteMetrics,
  DEFAULT_METRICS_NAMESPACE, // 'Vestibulum/AuthSite'
  DEFAULT_METRIC_PERIOD, // Duration.minutes(1)
} from "@de-otio/vestibulum-cdk";

const identityMetrics = buildIdentityMetrics({
  userPoolId: identity.cognitoPool.userPoolId,
  // metricsNamespace?: defaults to DEFAULT_METRICS_NAMESPACE
});

const siteMetrics = buildAuthSiteMetrics({
  distributionId: site.distribution.distributionId,
  // metricsNamespace?: defaults to DEFAULT_METRICS_NAMESPACE
});
```

- `buildIdentityMetrics({ userPoolId, metricsNamespace? })` returns an
  `IdentityMetrics` object with the seven metrics in the
  `identity.metrics` table above (Cognito service metrics dimensioned
  on `UserPoolId`; `preSignUpRejections` in the custom namespace; SES
  reputation metrics in `AWS/SES`).
- `buildAuthSiteMetrics({ distributionId, metricsNamespace? })`
  returns an `AuthSiteMetricCollection` with the four metrics in the
  `site.metrics` table above (CloudFront service metrics dimensioned
  on `DistributionId`/`Region: 'Global'`; `edgeAuthDenies` and
  `authVerifyErrors` in the custom namespace dimensioned on
  `DistributionId`).

`AuthSiteMetricCollection` is named distinctly from the construct's
own `AuthSiteMetricsNamespace` handle to avoid a name clash.

## Naming overrides

`MagicLinkAuthSite` and `EdgeResources` accept optional props that
move the vestibulum branding off the consumer-visible surface. The
namespace prop is shared; the prefix prop is named differently on
each construct:

| Prop                              | Construct           | Default                 | Effect                                                                                                  |
| --------------------------------- | ------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `metricsNamespace`                | `MagicLinkAuthSite`, `EdgeResources` | `'Vestibulum/AuthSite'` | CloudWatch namespace for every custom metric the construct emits (including `edgeAuthDenies` from L@E).  |
| `namespacePrefix`                 | `MagicLinkAuthSite` | `'Vestibulum'`          | Prefix for physical resource names (response-headers policy name, CloudFront distribution comment).     |
| `resourceNamePrefix`              | `EdgeResources`     | `'Vestibulum'`          | Prefix for the WAF Web ACL name / description and WAF visibility-metric names.                          |

`MagicLinkIdentity` exposes no naming-override props today — its
metrics are Cognito / SES service metrics under fixed namespaces (see
[`buildIdentityMetrics`](#metric-builders) below).

Consumers who run multiple deployments side-by-side (e.g., dev /
staging / prod in the same account) typically want a deployment-
scoped prefix to disambiguate dashboards. Consumers who don't want
"Vestibulum" appearing in their executive-visible dashboards swap to
their own product name.

The IAM condition on the Lambda@Edge role narrows
`cloudwatch:PutMetricData` to the configured namespace — overriding
`metricsNamespace` is reflected in the role's IAM shape automatically;
no manual policy edit needed.

## Defaults

Each metric has sensible default `period` (1 min) and `statistic`
(`Sum` for counts, `Average` for rates). Override per-alarm as
needed:

```typescript
new Alarm(this, "SignUpFlood", {
  metric: identity.metrics.signUpSuccesses.with({
    period: Duration.minutes(5),
    statistic: "Sum",
  }),
  threshold: 20,
  evaluationPeriods: 1,
  comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
});
```

## Emission costs

`edgeAuthDenies` is emitted from the Lambda@Edge `check-auth`
function, which runs on every viewer request. A naive
`PutMetricData` call per request would be both expensive (CloudWatch
charges per metric data point) and a fan-out vector on busy sites.

The edge bundle:

- **Samples at 1/100** by default. The sampling rate is not
  configurable at the construct level; consumers who need higher
  fidelity should attach CloudFront real-time logs to a regional
  aggregator.
- **Pins the CloudWatch SDK call to the home region** (where
  `MagicLinkAuthSite` is deployed), not the edge region. Without
  this pin, custom metrics from Lambda@Edge would land in the edge
  region's CloudWatch and carry the same data-residency risk as
  logs.

The edge role's IAM statement is scoped to the metric namespace via
an IAM condition:

```typescript
edgeRole.addToPrincipalPolicy(
  new iam.PolicyStatement({
    sid: "PutVestibulumMetrics",
    actions: ["cloudwatch:PutMetricData"],
    resources: ["*"],
    conditions: {
      StringEquals: { "cloudwatch:namespace": "Vestibulum/AuthSite" },
    },
  }),
);
```

The edge function cannot emit to any other namespace, and it cannot
emit logs at all (Mandatory Mitigation 1).

## Recommended alarms

Vestibulum-cdk doesn't ship alarms (notification channels are
consumer infrastructure), but these are the ones most consumers
should configure:

- `signUpSuccesses` > 20 in 1 hour — mailbomb / abuse signal.
- `challengeFailures` > 50 in 1 hour — same.
- `preSignUpRejections` > 5 in 5 minutes — someone enumerating
  allowed domains.
- `sesBounceRate` > 5% — DKIM drift (see
  [`09-operational-notes.md § DKIM drift detection`](09-operational-notes.md#dkim-drift-detection))
  or address-list quality issue.
- `sesComplaintRate` > 0.05% — content / consent problem.
- `distributionErrors` > 1% — broken deploy or origin issue.
- `edgeAuthDenies` rate-of-change > 10× baseline — the JWKS may
  have rotated unexpectedly, or someone is probing.
- `authVerifyErrors` > 0 — Function URL failure is always
  interesting.

## Cross-region metric considerations

Most metrics live in the consumer's home region. The exceptions:

- **WAF metrics** live in `us-east-1` (the WAF Web ACL's region).
  Consumers building a dashboard with both WAF and home-region
  metrics use a CloudWatch metric stream or cross-region metric
  dashboards.
- **Lambda@Edge metrics emitted by `check-auth`** are pinned to the
  home region (see above) — they do NOT land in the edge region's
  CloudWatch.
- **Cognito service metrics** live in the pool's region (the
  consumer's home region) since the pool is regional.

## `tenantId` dimension (shared-distribution)

In shared-distribution mode, custom metrics can carry a `TenantId`
CloudWatch dimension so per-tenant series are queryable independently.
This is the cost-attribution story described in
[`doc/vestibulum/shared-distribution/cost-attribution.md`](../vestibulum/shared-distribution/cost-attribution.md)
§ Proxy-metric approach (N6 follow-up).

### Which metrics carry `TenantId`

| Metric                | Has `TenantId` | Reason                                                                                                   |
| --------------------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| `preSignUpRejections` | Yes (optional) | Emitted by the bundled regional `PreSignUp` Lambda that has `tenantId` in scope                         |
| `authVerifyErrors`    | Yes (optional) | Emitted by the `auth-verify` Function URL Lambda that has `tenantId` in scope via the `Host` header      |
| `edgeAuthDenies`      | **No**         | Emitted by `check-auth` Lambda@Edge — replicated globally, no env vars, no per-tenant context at runtime |
| Cognito service metrics | **No**       | Emitted by AWS Cognito itself; cannot be instructed to add `TenantId`                                   |
| SES metrics           | **No**         | Emitted by AWS SES; cannot be instructed to add `TenantId`                                              |

### `buildSharedDistributionMetrics`

Use the dedicated builder to obtain per-tenant metric handles:

```typescript
import { buildSharedDistributionMetrics } from "@de-otio/vestibulum-cdk";

const tenantMetrics = buildSharedDistributionMetrics({
  tenantId: "acme",
  userPoolId: identity.userPool.userPoolId,
  distributionId: identity.distribution.distributionId,
  // metricsNamespace?: defaults to DEFAULT_METRICS_NAMESPACE
});

new cloudwatch.Alarm(stack, "AcmePreSignUpRejections", {
  metric: tenantMetrics.preSignUpRejections,
  threshold: 5,
  evaluationPeriods: 1,
});
```

Alternatively, pass `tenantId` to the existing builders for mixed use:

```typescript
const identityMetrics = buildIdentityMetrics({
  userPoolId: identity.userPool.userPoolId,
  tenantId: "acme",
});
// identityMetrics.preSignUpRejections has { UserPoolId, TenantId }
// identityMetrics.signUpSuccesses has only { UserPoolId } (Cognito service metric)

const siteMetrics = buildAuthSiteMetrics({
  distributionId: identity.distribution.distributionId,
  tenantId: "acme",
});
// siteMetrics.authVerifyErrors has { DistributionId, TenantId }
// siteMetrics.edgeAuthDenies has only { DistributionId } (Lambda@Edge — no TenantId possible)
```

### Cardinality trade-off

CloudWatch charges per **unique metric series** (namespace + metric name
+ dimension set). Adding a `TenantId` dimension multiplies the unique
series count by the number of tenants.

At N tenants and M custom metrics with `TenantId`, the CloudWatch storage
cost grows as `N × M` series. The relevant line items:

- **Metric storage**: ~$0.30 per metric per month (first 10k metrics;
  tiered discounts above that). At 100 tenants × 2 custom metrics =
  200 metric series ≈ $60/month additional.
- **PutMetricData calls**: charged at $0.01 per 1,000 data points.
  At 1 call/minute/tenant × 100 tenants × 2 metrics × 43,200 min/month
  ≈ 8.6M data points ≈ $86/month additional.

Cost guidance:

1. **Enable `perTenantMetrics: true` only when you are actually using
   per-tenant alarms or dashboards.** The feature defaults to `false` on
   `SharedDistributionIdentityProps`.
2. **Bounded tenant counts are fine.** Below ~50 tenants the incremental
   CloudWatch cost is well under $100/month. At 1,000+ tenants, evaluate
   sampling or aggregation.
3. **Prefer Logs Insights for ad-hoc queries** over metric dimensions at
   very high cardinality. A `filter tenantId = "acme" | stats count() by
   bin(1d)` query against the trigger Lambda log group costs fractions of
   a cent per query and avoids the per-series storage cost.
4. **Sample at the Lambda level** if write volume is very high. The
   existing `edgeAuthDenies` sampling precedent (1/100 by default) shows
   the pattern; regional handlers can apply the same approach.

### `perTenantMetrics` prop

`SharedDistributionIdentity` exposes `perTenantMetrics?: boolean` (default
`false`). When set, consumers signal that they intend to use per-tenant
metric dimensions. The prop does **not** automatically wire the dimensions —
it is a signal to the consumer's observability layer that it should call
`buildSharedDistributionMetrics` (or pass `tenantId` to the existing
builders) when constructing alarms and dashboards. This separation keeps the
metric-construction path composable and testable independently of the CDK
construct.

## What this file doesn't cover

- **Dashboards.** Consumers' own infrastructure choice
  (CloudWatch Dashboards, Grafana, Datadog).
- **Alerting routing.** Same — consumer's PagerDuty / Opsgenie /
  SNS-to-Slack story.
- **Log-based metrics.** Edge has no logs; regional handlers'
  `logRetention` is set to `ONE_MONTH` so consumers can build
  log-based metrics from CloudWatch Logs Insights queries.
- **Cost attribution model.** See
  [`doc/vestibulum/shared-distribution/cost-attribution.md`](../vestibulum/shared-distribution/cost-attribution.md)
  for the amortised vs. metered split, the proxy-metric approach, and
  chargeback model guidance.
