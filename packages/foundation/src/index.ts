/**
 * `@de-otio/saas-foundation` top-level barrel.
 *
 * Per doc/foundation/01-package-api.md, this barrel is hand-curated —
 * `export *` is forbidden so internal symbols cannot graduate to
 * public API by accident.
 *
 * P1 exports the frozen vocabulary. Later phases add the module
 * barrels (logger, secrets, audit, ...).
 */

// Frozen vocabulary — TenantId
export type { TenantId, TenantIdConstraints } from "./types/frozen/tenant.js";
export {
  TENANT_ID_CONSTRAINTS,
  TenantIdValidationError,
  tenantId,
  isTenantId,
} from "./types/frozen/tenant.js";

// Frozen vocabulary — AuditEvent
export type {
  AuditEvent,
  AuditActor,
  AuditAction,
  AuditResource,
  AuditSeverity,
  AuditOutcome,
  JsonValue,
  JsonObject,
  JsonArray,
  JsonPrimitive,
} from "./types/frozen/audit.js";

// Frozen vocabulary — RequestContext
export type { RequestContext, Principal } from "./types/frozen/request-context.js";

// Frozen vocabulary — SecretRef
export type { SecretRef } from "./types/frozen/secrets.js";
export { SecretRefValidationError, secretRef, isSecretRef } from "./types/frozen/secrets.js";

// Zod schemas for the frozen types
export {
  TenantIdSchema,
  SecretRefSchema,
  AuditEventSchema,
  AuditActorSchema,
  AuditActionSchema,
  AuditResourceSchema,
  AuditSeveritySchema,
  AuditOutcomeSchema,
  JsonValueSchema,
  PrincipalSchema,
  RequestContextSchema,
} from "./types/frozen/schemas.js";

// Logger module
export type { Logger, LogLevel } from "./logger/index.js";
export {
  LOG_LEVELS,
  LOG_LEVEL_SEVERITY,
  isLogLevel,
  compareLogLevelSeverity,
  configureRootLogger,
  getLogger,
  createLogger,
  DEFAULT_REDACT_PATHS,
  DEFAULT_REDACT_CONFIG,
  LoggerConfigError,
} from "./logger/index.js";

// Request context module (lifecycle functions)
export type { CreateRequestContextInput } from "./request-context/index.js";
export {
  createRequestContext,
  runWithRequestContext,
  getRequestContext,
  setRequestContext,
  RequestContextPhaseError,
  RequestContextValidationError,
} from "./request-context/index.js";

// Net module
export type {
  TrustedProxyMode,
  TrustedClientIpConfig,
  IpAnonymizationLevel,
  IpAnonymizerOptions,
  ReservedBlock,
} from "./net/index.js";
export {
  trustedClientIp,
  isIpShape,
  isReservedIp,
  IpAnonymizer,
  anonymizeIpPartial,
  RFC6890_IPV4_RESERVED,
  RFC6890_IPV6_RESERVED,
  RFC6890_ALL_RESERVED,
  InvalidIpError,
  TrustedProxyError,
} from "./net/index.js";

// Tenant module
export type {
  TenantResolver,
  TenantResolverInput,
  SubdomainTenantResolverOptions,
  CustomDomainTenantResolverOptions,
  TenantResolverTrustClass,
} from "./tenant/index.js";
export {
  resolveTenant,
  SubdomainTenantResolver,
  CustomDomainTenantResolver,
  CompositeTenantResolver,
  runWithTenantContext,
  getCurrentTenantId,
  TenantResolverError,
  TenantNotFoundError,
  TenantAuthorizationError,
} from "./tenant/index.js";

// Rate-limit module (MemoryTokenBucketLimiter is NOT re-exported here — see sub-path)
export type { RateLimitResult, TokenBucketConfig } from "./rate-limit/index.js";
export { DynamoTokenBucketLimiter } from "./rate-limit/index.js";

// Region module
export type { Region, RegionResolution } from "./region/index.js";
export { detectRegion, getResidencyRegionForTenant } from "./region/index.js";

// Feature-toggles module (PrismaFeatureToggleStore is NOT re-exported here — see sub-path)
export type { FeatureToggle, FeatureToggleStore } from "./feature-toggles/index.js";
export { MemoryFeatureToggleStore } from "./feature-toggles/index.js";

// Audit module (PostgresAuditStore is NOT re-exported here — see sub-path)
export type {
  AuditLogOptions,
  AuditStore,
  DynamoAuditStoreOptions,
  MultiAuditStoreMode,
  MultiAuditStoreOptions,
  PiiFilterOptions,
  PiiFilterStrategy,
  EmitInput,
} from "./audit/index.js";
export {
  AuditLog,
  DynamoAuditStore,
  MultiAuditStore,
  PiiFilter,
  DEFAULT_PII_KEYS,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_METADATA_MAX_BYTES,
  retentionDaysFor,
  retentionSecondsFor,
  ttlFor,
  AuditWriteError,
  AuditEventValidationError,
  AuditStoreError,
} from "./audit/index.js";
