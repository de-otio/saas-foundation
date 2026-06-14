/**
 * Default branding tokens for resource physical names and CloudWatch
 * metric namespaces. Both are overridable via construct props per the
 * security review item S-C12: the `Vestibulum*` strings leak through
 * to consumer CloudWatch dashboards and IAM resource names, which some
 * consumers want to suppress.
 *
 * Keep these defaults stable across releases — changing them would
 * rename CloudFormation resource physical names (and hence force-replace
 * existing deployments).
 */
export const DEFAULT_RESOURCE_NAME_PREFIX = "Vestibulum";
export const DEFAULT_METRICS_NAMESPACE = "Vestibulum/AuthSite";

/**
 * Returns the resource-name prefix to use, defaulting to
 * {@link DEFAULT_RESOURCE_NAME_PREFIX} when the consumer omitted the
 * `resourceNamePrefix` prop. Empty strings fall back to the default —
 * the prefix is load-bearing in several physical names and cannot be
 * empty without colliding with consumer resources.
 */
export function resolveResourceNamePrefix(override: string | undefined): string {
  if (override === undefined || override === "") {
    return DEFAULT_RESOURCE_NAME_PREFIX;
  }
  return override;
}

/**
 * Returns the CloudWatch metric namespace, defaulting to
 * {@link DEFAULT_METRICS_NAMESPACE} when omitted. Empty strings fall
 * back to the default; CloudWatch rejects empty namespaces and the
 * edge IAM condition relies on a non-empty value to be enforceable.
 */
export function resolveMetricsNamespace(override: string | undefined): string {
  if (override === undefined || override === "") {
    return DEFAULT_METRICS_NAMESPACE;
  }
  return override;
}
