// MagicLinkIdentity (Agent A / P5)
export * from "./magic-link-identity/index.js";

// Aspects — export only names not already re-exported by magic-link-identity
export {
  DisabledAuthFlowsAspect,
  type DisabledAuthFlowsAspectProps,
  WafRequiredAspect,
  LogRetentionRequiredAspect,
  VESTIBULUM_SUBTREE_MARKER_TYPE,
  markVestibulumSubtreeRoot,
  isInsideVestibulumSubtree,
  FederationCustomAttributesAspect,
  type FederationCustomAttributesAspectProps,
  HostedUiDomainAspect,
  VESTIBULUM_HOSTED_UI_METADATA_TYPE,
  type HostedUiMetadata,
  markHostedUiConfig,
  readHostedUiConfig,
} from "./aspects/index.js";

// CDK-nag rule pack
export * from "./cdk-nag-rules/index.js";

// WAF default rules are exported from the edge-resources barrel below
// (the authoritative home is lib/edge-resources/waf-defaults.ts).

// App clients — export names not already provided by magic-link-identity
export {
  buildAppClientOptions,
  validateFederationCallbackUrls,
  type BuildAppClientOptionsInput,
  DEFAULT_ID_TOKEN_VALIDITY,
  DEFAULT_REFRESH_TOKEN_VALIDITY,
} from "./app-clients/index.js";

// Trigger hooks
export {
  attachTriggerHooks,
  validateTriggerLambdaLocality,
  type TriggerHooksProps,
} from "./trigger-hooks/index.js";

// Metrics
export {
  DEFAULT_METRICS_NAMESPACE,
  DEFAULT_METRIC_PERIOD,
  buildIdentityMetrics,
  buildAuthSiteMetrics,
  buildSharedDistributionMetrics,
  type IdentityMetrics,
  type AuthSiteMetricCollection,
  type SharedDistributionMetrics,
  type BuildIdentityMetricsInput,
  type BuildAuthSiteMetricsInput,
  type BuildSharedDistributionMetricsInput,
} from "./metrics/index.js";

// EdgeResources (Agent B / P5)
export * from "./edge-resources/index.js";

// MagicLinkAuthSite (Agent B / P5)
export * from "./magic-link-auth-site/index.js";

// Runtime-env keys for consumers writing helper Lambdas that share
// configuration with the bundled trigger handlers.
export { RuntimeEnv, type RuntimeEnvKey } from "./_internal/runtime-env.js";

// v0.2 shared-distribution mode (additive)
//
// `AdvancedSecurityMode` is intentionally NOT re-exported here — the
// type name collides with the single-tenant `MagicLinkIdentity`'s own
// `AdvancedSecurityMode`. Consumers needing the shared-distribution
// variant import directly from `@de-otio/vestibulum-cdk/shared-distribution-identity`
// (the construct surface is identical for the common 'off'/'audit'/
// 'enforced' values, so most consumers won't need the deeper import).
export {
  SharedDistributionIdentity,
  SharedDistributionIdentityPropsError,
  DEFAULT_TENANT_SUBDOMAIN_PATTERN,
  DEFAULT_RESERVED_SUBDOMAINS,
  type SharedDistributionIdentityProps,
  ClientConfigTable,
  CLIENT_CONFIG_SUBDOMAIN_INDEX,
  CLIENT_CONFIG_TENANT_ID_INDEX,
  type ClientConfigTableProps,
  ReservationsTable,
  SharedDistributionTriggers,
  type TriggersProps,
  type TriggersResult,
  WildcardCert,
  WildcardCertConfigError,
  type WildcardCertProps,
  AdminLambda,
  AdminLambdaPropsError,
  type AdminLambdaProps,
  Reconciler,
  type ReconcilerProps,
  CloudFrontDistribution,
  type CloudFrontDistributionProps,
  EdgeFunction,
  type EdgeFunctionProps,
  type ResolvedEdgeConfig,
  DEFAULT_JWKS_TTL,
  resolveEdgeConfig,
  renderEdgeConfigModule,
  defaultVestibulumPackageRoot,
  Waf,
  type WafProps,
  DEFAULT_CLOUDFRONT_RATE_LIMIT,
  DEFAULT_COGNITO_INITIATE_AUTH_RATE_LIMIT,
  DEFAULT_COGNITO_SIGNUP_RATE_LIMIT,
  defaultCloudFrontWafRules,
  defaultCognitoWafRules,
  createDefaultResponseHeadersPolicy,
  DEFAULT_CONTENT_SECURITY_POLICY,
  DEFAULT_PERMISSIONS_POLICY,
  DEFAULT_HSTS_MAX_AGE_DAYS,
  type CreateDefaultResponseHeadersPolicyOptions,
} from "./shared-distribution-identity/index.js";
