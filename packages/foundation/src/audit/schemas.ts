/**
 * Module-local Zod schemas for the audit writer.
 *
 * The public `AuditEventSchema` lives next to the type definition in
 * `src/types/frozen/schemas.ts` and is re-exported there. The shapes
 * here are the writer-time variants:
 *
 *   - `EmitInputSchema` — what the consumer passes to
 *     `AuditLog.emit(input)`. Has no `id` / `timestamp` (the writer
 *     mints both).
 *   - `MetadataSizeLimit` — 32 KB cap on JSON-encoded `metadata` per
 *     S-Sec2 in the initial design review.
 *
 * Pure module.
 */

import { z } from "zod";

import {
  AuditActorSchema,
  AuditActionSchema,
  AuditResourceSchema,
  AuditOutcomeSchema,
  AuditSeveritySchema,
  JsonValueSchema,
  TenantIdSchema,
} from "../types/frozen/schemas.js";

/**
 * Max JSON-encoded size of `event.metadata`, in bytes (UTF-8). Default
 * `AuditLog` options use this; consumers can override per-instance.
 *
 * DynamoDB caps items at 400 KB; CloudWatch Logs caps entries at 256 KB;
 * even within those limits, a single 200 KB audit event hides what
 * it's logging behind unsearchable bulk. 32 KB is the foundation
 * default — large enough for any reasonable structured payload, small
 * enough to discourage stuffing.
 */
export const DEFAULT_METADATA_MAX_BYTES = 32_768;

/**
 * Schema for the input to `AuditLog.emit`. Mirrors `AuditEvent` minus
 * `id` and `timestamp` (which the writer mints).
 */
export const EmitInputSchema = z.object({
  tenantId: TenantIdSchema.optional(),
  actor: AuditActorSchema,
  action: AuditActionSchema,
  resource: AuditResourceSchema.optional(),
  outcome: AuditOutcomeSchema,
  failureReason: z.string().min(1).optional(),
  severity: AuditSeveritySchema,
  requestId: z.string().min(1).optional(),
  traceId: z.string().min(1).optional(),
  ipAddress: z.string().min(1).optional(),
  userAgent: z.string().min(1).optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

export type EmitInput = z.infer<typeof EmitInputSchema>;
