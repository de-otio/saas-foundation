/**
 * CloudWatch metric definitions emitted by vestibulum-cdk constructs.
 *
 * `MagicLinkIdentity` exposes an `identity.metrics` namespace and
 * `MagicLinkAuthSite` exposes a `site.metrics` namespace. Consumers attach
 * their own alarms — vestibulum-cdk's scope ends at exposing the metrics.
 *
 * Both namespaces accept a `metricsNamespace` override per S-C12 so
 * consumers can replace the `'Vestibulum/AuthSite'` default with their own
 * product name or a deployment-scoped prefix (e.g. `'MyProduct/Auth/Prod'`).
 *
 * In shared-distribution mode, custom metrics can carry a `tenantId`
 * dimension for per-tenant cost attribution. Use
 * `buildSharedDistributionMetrics` to obtain metric handles with that
 * dimension set. See {@link buildSharedDistributionMetrics} and
 * `doc/vestibulum-cdk/08-metrics.md § tenantId dimension (shared-distribution)`.
 *
 * **Cardinality note.** CloudWatch charges per unique metric series
 * (namespace + metric name + dimension set). Adding `tenantId` multiplies
 * the series count by N (number of tenants). At N tenants and M base custom
 * metrics the monthly cost is approximately `N * M * $0.30` for storage plus
 * `N * M * monthly_puts * $0.01/1000`. Keep the dimension count bounded and
 * consider not enabling `tenantId` dimensions below ~10 tenants. Enabled by
 * default only when `SharedDistributionIdentityProps.perTenantMetrics` is
 * `true`.
 *
 * Metric defaults:
 * - `period`: 1 minute
 * - `statistic`: `'Sum'` for counts, `'Average'` for rates
 */

import { Duration } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";

/**
 * Default CloudWatch namespace for all vestibulum custom metrics.
 *
 * Overridable via the `metricsNamespace` prop on `MagicLinkIdentity`,
 * `MagicLinkAuthSite`, and `EdgeResources`.
 */
export const DEFAULT_METRICS_NAMESPACE = "Vestibulum/AuthSite";

/**
 * Default metric period (1 minute).
 */
export const DEFAULT_METRIC_PERIOD = Duration.minutes(1);

/**
 * Identity-level metrics emitted by / associated with `MagicLinkIdentity`.
 */
export interface IdentityMetrics {
  /**
   * Cognito service metric: signup completions; baseline traffic signal.
   */
  readonly signUpSuccesses: cloudwatch.Metric;

  /**
   * Cognito service metric: sign-in completions via custom-auth
   * challenge-response.
   */
  readonly signInSuccesses: cloudwatch.Metric;

  /**
   * Cognito service metric: refresh-token exchanges.
   * A spike indicates a client retry storm.
   */
  readonly tokenRefreshSuccesses: cloudwatch.Metric;

  /**
   * Cognito service metric: failed custom-auth challenge responses.
   * Mailbomb / abuse signal.
   */
  readonly challengeFailures: cloudwatch.Metric;

  /**
   * Custom metric emitted by the bundled `PreSignUp` Lambda.
   * Domain-allowlist rejections.
   */
  readonly preSignUpRejections: cloudwatch.Metric;

  /**
   * SES metric via the bounce handler: hard-bounce rate.
   * Alarm above ~5%.
   */
  readonly sesBounceRate: cloudwatch.Metric;

  /**
   * SES metric: complaint rate. AWS will throttle if > 0.1%.
   */
  readonly sesComplaintRate: cloudwatch.Metric;
}

/**
 * Auth-site-level metrics emitted by / associated with `MagicLinkAuthSite`.
 *
 * Named `AuthSiteMetricCollection` to avoid a name clash with the simpler
 * `AuthSiteMetrics` shape on the `MagicLinkAuthSite` construct itself.
 */
export interface AuthSiteMetricCollection {
  /**
   * CloudFront service metric: request count.
   */
  readonly distributionRequests: cloudwatch.Metric;

  /**
   * CloudFront service metric: 4xx + 5xx rate.
   */
  readonly distributionErrors: cloudwatch.Metric;

  /**
   * Custom metric emitted by `check-auth` Lambda@Edge.
   * Denials. Sampled at 1/100 by default; emitted to the home region
   * (not the edge region) to keep data-residency consistent.
   */
  readonly edgeAuthDenies: cloudwatch.Metric;

  /**
   * `auth-verify` Function URL metric: 5xx rate.
   */
  readonly authVerifyErrors: cloudwatch.Metric;
}

/**
 * Input for `buildIdentityMetrics`.
 */
export interface BuildIdentityMetricsInput {
  /**
   * Cognito User Pool ID. Used as a metric dimension.
   */
  readonly userPoolId: string;

  /**
   * CloudWatch namespace. Defaults to `DEFAULT_METRICS_NAMESPACE`.
   */
  readonly metricsNamespace?: string;

  /**
   * Tenant identifier dimension value.
   *
   * When set, custom metrics (`preSignUpRejections`) carry an additional
   * `TenantId` dimension so per-tenant series are queryable independently
   * in CloudWatch and Cost Explorer.
   *
   * Only set this in shared-distribution mode when
   * `SharedDistributionIdentityProps.perTenantMetrics` is `true`. The
   * dimension multiplies unique metric series by N tenants; see the
   * cardinality note in the module-level JSDoc.
   *
   * Cognito service metrics (`signUpSuccesses`, `signInSuccesses`, etc.)
   * and SES metrics do NOT gain this dimension — Cognito emits those
   * metrics itself and cannot be instructed to add `TenantId`.
   */
  readonly tenantId?: string;
}

/**
 * Build the `IdentityMetrics` object for a `MagicLinkIdentity` construct.
 *
 * Separating metric construction from the construct class makes the
 * shape testable without a full CDK stack.
 *
 * In shared-distribution mode, pass `tenantId` to add a `TenantId`
 * dimension to custom metrics (`preSignUpRejections`). Cognito service
 * metrics and SES metrics never carry `TenantId` — those are emitted by
 * AWS services that cannot be instructed to add the dimension.
 */
export function buildIdentityMetrics(input: BuildIdentityMetricsInput): IdentityMetrics {
  const namespace = input.metricsNamespace ?? DEFAULT_METRICS_NAMESPACE;
  const baseDimensions: Record<string, string> = { UserPoolId: input.userPoolId };
  const customDimensions: Record<string, string> =
    input.tenantId !== undefined
      ? { ...baseDimensions, TenantId: input.tenantId }
      : baseDimensions;
  const period = DEFAULT_METRIC_PERIOD;

  return {
    signUpSuccesses: new cloudwatch.Metric({
      namespace,
      metricName: "SignUpSuccesses",
      dimensionsMap: baseDimensions,
      period,
      statistic: "Sum",
    }),
    signInSuccesses: new cloudwatch.Metric({
      namespace,
      metricName: "SignInSuccesses",
      dimensionsMap: baseDimensions,
      period,
      statistic: "Sum",
    }),
    tokenRefreshSuccesses: new cloudwatch.Metric({
      namespace,
      metricName: "TokenRefreshSuccesses",
      dimensionsMap: baseDimensions,
      period,
      statistic: "Sum",
    }),
    challengeFailures: new cloudwatch.Metric({
      namespace,
      metricName: "ChallengeFailures",
      dimensionsMap: baseDimensions,
      period,
      statistic: "Sum",
    }),
    preSignUpRejections: new cloudwatch.Metric({
      namespace,
      metricName: "PreSignUpRejections",
      dimensionsMap: customDimensions,
      period,
      statistic: "Sum",
    }),
    sesBounceRate: new cloudwatch.Metric({
      namespace: "AWS/SES",
      metricName: "Reputation.BounceRate",
      period,
      statistic: "Average",
    }),
    sesComplaintRate: new cloudwatch.Metric({
      namespace: "AWS/SES",
      metricName: "Reputation.ComplaintRate",
      period,
      statistic: "Average",
    }),
  };
}

/**
 * Input for `buildAuthSiteMetrics`.
 */
export interface BuildAuthSiteMetricsInput {
  /**
   * CloudFront distribution ID. Used as a metric dimension.
   */
  readonly distributionId: string;

  /**
   * CloudWatch namespace. Defaults to `DEFAULT_METRICS_NAMESPACE`.
   */
  readonly metricsNamespace?: string;

  /**
   * Tenant identifier dimension value.
   *
   * When set, `authVerifyErrors` carries an additional `TenantId`
   * dimension. `edgeAuthDenies` is intentionally excluded — it is emitted
   * by the Lambda@Edge `check-auth` function, which runs in replicated edge
   * regions without per-tenant environment context and cannot include a
   * `TenantId` dimension.
   *
   * Only set in shared-distribution mode when
   * `SharedDistributionIdentityProps.perTenantMetrics` is `true`. See the
   * cardinality note in the module-level JSDoc.
   */
  readonly tenantId?: string;
}

/**
 * Metrics emitted by / associated with `SharedDistributionIdentity` in
 * shared-distribution mode for a single tenant.
 *
 * All metrics carry a `TenantId` dimension when the construct is running
 * with `perTenantMetrics: true`. Use `buildSharedDistributionMetrics` to
 * obtain an instance of this collection for a given tenant.
 */
export interface SharedDistributionMetrics {
  /**
   * Custom metric emitted by the bundled `PreSignUp` Lambda.
   * Domain-allowlist rejections for this tenant.
   * Dimension: `TenantId`.
   */
  readonly preSignUpRejections: cloudwatch.Metric;

  /**
   * `auth-verify` Function URL 5xx rate for this tenant.
   * Dimension: `TenantId`.
   */
  readonly authVerifyErrors: cloudwatch.Metric;
}

/**
 * Input for `buildSharedDistributionMetrics`.
 */
export interface BuildSharedDistributionMetricsInput {
  /**
   * Tenant identifier. Applied as the `TenantId` dimension on every metric
   * in the returned collection.
   *
   * **Cardinality note.** Each unique `tenantId` value creates N new metric
   * series in CloudWatch. At N tenants and M metrics in this collection,
   * CloudWatch charges for `N * M` unique metric series. Keep tenant counts
   * bounded or consider sampling for very high-cardinality deployments.
   * See `doc/vestibulum-cdk/08-metrics.md § tenantId dimension`.
   */
  readonly tenantId: string;

  /**
   * Cognito User Pool ID. Used as an additional metric dimension on
   * `preSignUpRejections` alongside `TenantId`.
   */
  readonly userPoolId: string;

  /**
   * CloudFront distribution ID. Used as an additional metric dimension on
   * `authVerifyErrors` alongside `TenantId`.
   */
  readonly distributionId: string;

  /**
   * CloudWatch namespace. Defaults to `DEFAULT_METRICS_NAMESPACE`.
   */
  readonly metricsNamespace?: string;
}

/**
 * Build the `AuthSiteMetricCollection` object for a `MagicLinkAuthSite` construct.
 *
 * In shared-distribution mode, pass `tenantId` to add a `TenantId` dimension
 * to `authVerifyErrors`. `edgeAuthDenies` never carries `TenantId` — it is
 * emitted by Lambda@Edge which has no access to per-tenant context at emit
 * time.
 */
export function buildAuthSiteMetrics(input: BuildAuthSiteMetricsInput): AuthSiteMetricCollection {
  const namespace = input.metricsNamespace ?? DEFAULT_METRICS_NAMESPACE;
  const cfDimensions = { DistributionId: input.distributionId, Region: "Global" };
  const edgeDimensions: Record<string, string> = { DistributionId: input.distributionId };
  const authVerifyDimensions: Record<string, string> =
    input.tenantId !== undefined
      ? { DistributionId: input.distributionId, TenantId: input.tenantId }
      : { DistributionId: input.distributionId };
  const period = DEFAULT_METRIC_PERIOD;

  return {
    distributionRequests: new cloudwatch.Metric({
      namespace: "AWS/CloudFront",
      metricName: "Requests",
      dimensionsMap: cfDimensions,
      period,
      statistic: "Sum",
    }),
    distributionErrors: new cloudwatch.Metric({
      namespace: "AWS/CloudFront",
      metricName: "TotalErrorRate",
      dimensionsMap: cfDimensions,
      period,
      statistic: "Average",
    }),
    edgeAuthDenies: new cloudwatch.Metric({
      namespace,
      metricName: "EdgeAuthDenies",
      dimensionsMap: edgeDimensions,
      period,
      statistic: "Sum",
    }),
    authVerifyErrors: new cloudwatch.Metric({
      namespace,
      metricName: "AuthVerifyErrors",
      dimensionsMap: authVerifyDimensions,
      period,
      statistic: "Sum",
    }),
  };
}

/**
 * Build a `SharedDistributionMetrics` collection for a single tenant.
 *
 * This function produces metric handles for the custom metrics that are
 * attributable per tenant in shared-distribution mode. Every metric in the
 * returned collection carries a `TenantId` dimension.
 *
 * Call this once per tenant from the observability or dashboarding layer
 * of the consumer application (e.g., when rendering per-tenant CloudWatch
 * dashboards or setting up per-tenant alarms).
 *
 * **Lambda@Edge exclusion.** `edgeAuthDenies` is NOT included here because
 * the `check-auth` Lambda@Edge function runs in edge-regional replicas with
 * no environment variable access and cannot emit a `TenantId` dimension.
 * Per-tenant edge metrics are not possible at the CloudWatch `PutMetricData`
 * level; use CloudFront access-log analysis against the `cs-host` field for
 * edge-level per-tenant attribution.
 *
 * @example
 * ```typescript
 * const tenantMetrics = buildSharedDistributionMetrics({
 *   tenantId: 'acme',
 *   userPoolId: identity.userPool.userPoolId,
 *   distributionId: identity.distribution.distributionId,
 * });
 * new cloudwatch.Alarm(stack, 'AcmePreSignUpRejections', {
 *   metric: tenantMetrics.preSignUpRejections,
 *   threshold: 5,
 *   evaluationPeriods: 1,
 * });
 * ```
 */
export function buildSharedDistributionMetrics(
  input: BuildSharedDistributionMetricsInput,
): SharedDistributionMetrics {
  const namespace = input.metricsNamespace ?? DEFAULT_METRICS_NAMESPACE;
  const period = DEFAULT_METRIC_PERIOD;
  const tenantDimBase: Record<string, string> = { TenantId: input.tenantId };

  return {
    preSignUpRejections: new cloudwatch.Metric({
      namespace,
      metricName: "PreSignUpRejections",
      dimensionsMap: { ...tenantDimBase, UserPoolId: input.userPoolId },
      period,
      statistic: "Sum",
    }),
    authVerifyErrors: new cloudwatch.Metric({
      namespace,
      metricName: "AuthVerifyErrors",
      dimensionsMap: { ...tenantDimBase, DistributionId: input.distributionId },
      period,
      statistic: "Sum",
    }),
  };
}
