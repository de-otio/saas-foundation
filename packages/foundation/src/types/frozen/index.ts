/**
 * Layer-0 barrel for the foundation-owned frozen types.
 *
 * Imports from this barrel are permitted from any layer in foundation
 * (see doc/03-package-relationships.md § Cycle prevention). This is
 * the single path the CI fanout gate watches.
 *
 * Hand-curated — `export *` is forbidden so internal symbols cannot
 * graduate to public API by accident.
 */

// TenantId
export type { TenantId, TenantIdConstraints } from "./tenant.js";
export { TENANT_ID_CONSTRAINTS, TenantIdValidationError, tenantId, isTenantId } from "./tenant.js";

// TenantSubdomain
export type { TenantSubdomain, TenantSubdomainConstraints } from "./tenant-subdomain.js";
export {
  TENANT_SUBDOMAIN_CONSTRAINTS,
  TenantSubdomainValidationError,
  tenantSubdomain,
  isTenantSubdomain,
} from "./tenant-subdomain.js";

// ClientConfigRow
export type { ClientConfigRow } from "./client-config-row.js";

// AuditEvent and its sub-shapes
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
} from "./audit.js";

// RequestContext
export type { RequestContext, Principal } from "./request-context.js";

// SecretRef
export type { SecretRef } from "./secrets.js";
export { SecretRefValidationError, secretRef, isSecretRef } from "./secrets.js";

// Zod schemas
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
  TenantSubdomainSchema,
  ClientConfigRowSchema,
} from "./schemas.js";
