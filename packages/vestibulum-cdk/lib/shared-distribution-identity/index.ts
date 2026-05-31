/**
 * `SharedDistributionIdentity` construct barrel.
 *
 * See `doc/vestibulum/shared-distribution/`.
 */

export {
  SharedDistributionIdentity,
  SharedDistributionIdentityPropsError,
  DEFAULT_TENANT_SUBDOMAIN_PATTERN,
  DEFAULT_RESERVED_SUBDOMAINS,
  type SharedDistributionIdentityProps,
  type AdvancedSecurityMode,
} from "./identity.js";

export {
  ClientConfigTable,
  CLIENT_CONFIG_SUBDOMAIN_INDEX,
  CLIENT_CONFIG_TENANT_ID_INDEX,
  type ClientConfigTableProps,
} from "./client-config-table.js";

export { ReservationsTable } from "./reservations-table.js";

export {
  SharedDistributionTriggers,
  type TriggersProps,
  type TriggersResult,
} from "./triggers.js";

export {
  WildcardCert,
  WildcardCertConfigError,
  type WildcardCertProps,
} from "./wildcard-cert.js";

export {
  AdminLambda,
  AdminLambdaPropsError,
  type AdminLambdaProps,
} from "./admin-lambda.js";

export {
  Reconciler,
  type ReconcilerProps,
} from "./reconciler.js";

// ---- P2b (CloudFront + edge + WAF + security headers) -----------------------
export {
  CloudFrontDistribution,
  type CloudFrontDistributionProps,
} from "./cloudfront-distribution.js";

export {
  EdgeFunction,
  type EdgeFunctionProps,
  type ResolvedEdgeConfig,
  DEFAULT_JWKS_TTL,
  resolveEdgeConfig,
  renderEdgeConfigModule,
  defaultVestibulumPackageRoot,
} from "./edge-function.js";

export {
  Waf,
  type WafProps,
  DEFAULT_CLOUDFRONT_RATE_LIMIT,
  DEFAULT_COGNITO_INITIATE_AUTH_RATE_LIMIT,
  DEFAULT_COGNITO_SIGNUP_RATE_LIMIT,
  defaultCloudFrontWafRules,
  defaultCognitoWafRules,
} from "./waf.js";

export {
  createDefaultResponseHeadersPolicy,
  DEFAULT_CONTENT_SECURITY_POLICY,
  DEFAULT_PERMISSIONS_POLICY,
  DEFAULT_HSTS_MAX_AGE_DAYS,
  type CreateDefaultResponseHeadersPolicyOptions,
} from "./security-headers.js";
