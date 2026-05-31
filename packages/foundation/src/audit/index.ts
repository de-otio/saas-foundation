/**
 * `@de-otio/saas-foundation/audit` barrel.
 *
 * Append-only event log primitives. The writer is in `AuditLog`; the
 * default storage backend is `DynamoAuditStore`; the durability
 * recipe is `MultiAuditStore`; the PII scrub is `PiiFilter`.
 *
 * NOT re-exported here:
 *   - `PostgresAuditStore` — lives behind the sub-path
 *     `@de-otio/saas-foundation/audit/prisma`. The quarantine is
 *     critical for the optional-peer-dep pattern; see
 *     `doc/foundation/01-package-api.md § Prisma sub-paths`.
 *   - `AuditQuery` and its reader API — not in v0.1.
 *
 * Per H-1: the `DynamoAuditStore` implementation calls
 * `PutItemCommand` only. The IAM-shape grep test in
 * `test/audit/iam-shape.test.ts` enforces this at CI time.
 */

// Writer
export { AuditLog } from "./audit-log.js";
export type { AuditLogOptions } from "./audit-log.js";

// Store interface + bundled backends
export type { AuditStore } from "./store.js";
export { DynamoAuditStore } from "./dynamo-store.js";
export type { DynamoAuditStoreOptions } from "./dynamo-store.js";
export { MultiAuditStore } from "./multi-store.js";
export type { MultiAuditStoreMode, MultiAuditStoreOptions } from "./multi-store.js";

// Metadata scrub
export { PiiFilter, DEFAULT_PII_KEYS } from "./pii-filter.js";
export type { PiiFilterStrategy, PiiFilterOptions } from "./pii-filter.js";

// Retention helpers
export {
  DEFAULT_RETENTION_DAYS,
  retentionDaysFor,
  retentionSecondsFor,
  ttlFor,
} from "./retention.js";

// Schemas / constants
export { DEFAULT_METADATA_MAX_BYTES, EmitInputSchema } from "./schemas.js";
export type { EmitInput } from "./schemas.js";

// Named errors
export { AuditWriteError, AuditEventValidationError, AuditStoreError } from "./errors.js";

// Frozen-vocabulary re-exports (ergonomics for `import { AuditSeverity }
// from "@de-otio/saas-foundation/audit"` per S-F3)
export type {
  AuditEvent,
  AuditActor,
  AuditAction,
  AuditResource,
  AuditSeverity,
  AuditOutcome,
} from "../types/frozen/audit.js";
