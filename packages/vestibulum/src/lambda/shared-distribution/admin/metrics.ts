/**
 * CloudWatch metric emission helpers for the admin Lambda.
 *
 * Uses the EMF (Embedded Metrics Format) approach: writes a structured
 * JSON line to stdout that the Lambda CloudWatch Logs agent interprets as
 * a metric. This avoids the need for the CloudWatch PutMetricData API call.
 *
 * Namespace: `Vestibulum/SharedDistribution`
 * See doc/vestibulum/shared-distribution/08-observability-and-audit.md
 * § CloudWatch metrics for the full metric inventory.
 */

const NAMESPACE = 'Vestibulum/SharedDistribution';

/** EMF root shape for structured metric emission. */
interface EmfMetric {
  readonly _aws: {
    readonly Timestamp: number;
    readonly CloudWatchMetrics: Array<{
      readonly Namespace: string;
      readonly Dimensions: string[][];
      readonly Metrics: Array<{ readonly Name: string; readonly Unit: string }>;
    }>;
  };
  readonly [key: string]: unknown;
}

/**
 * Emit a single CloudWatch metric via EMF (stdout -> Lambda agent).
 *
 * Dimensions are optional. Per 08 § Cardinality note, the default
 * behaviour is to emit scalar metrics without dimensions.
 * `perTenantMetrics` mode would pass dimensions; for now we emit
 * without dimensions by default and accept whatever is passed.
 */
export function emitMetric(
  metricName: string,
  value: number,
  dimensions: Record<string, string> = {},
): void {
  const dimensionKeys = Object.keys(dimensions);
  const payload: EmfMetric = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: NAMESPACE,
          Dimensions: dimensionKeys.length > 0 ? [dimensionKeys] : [[]],
          Metrics: [{ Name: metricName, Unit: 'Count' }],
        },
      ],
    },
    [metricName]: value,
    ...dimensions,
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

// ---------------------------------------------------------------------------
// Named metric helpers — correspond to table in 08 § CloudWatch metrics
// ---------------------------------------------------------------------------

export function emitTenantCreated(tenantId: string): void {
  emitMetric('TenantCreated', 1, { tenantId });
}

export function emitTenantUpdated(tenantId: string): void {
  emitMetric('TenantUpdated', 1, { tenantId });
}

export function emitTenantDeleted(
  tenantId: string,
  subdomain: string,
  revokedSessions: boolean,
): void {
  emitMetric('TenantDeleted', 1, {
    tenantId,
    subdomain,
    revokedSessions: String(revokedSessions),
  });
}

export function emitAllowlistChanged(tenantId: string, subdomain: string): void {
  emitMetric('AllowlistChanged', 1, { tenantId, subdomain });
}

export function emitCompensationTriggered(subdomain: string): void {
  emitMetric('CompensationTriggered', 1, { subdomain });
}
