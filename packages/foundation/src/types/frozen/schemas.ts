/**
 * Zod schemas for the foundation-owned frozen types.
 *
 * These schemas live with the types (per the design's "schemas next
 * to types" convention). The brand checkers (`isTenantId`,
 * `isSecretRef`) are the runtime-cheap predicate path; the Zod
 * schemas are the boundary-validation path used by Lambda triggers,
 * audit-log writers, and any other place that ingests untrusted
 * input.
 *
 * Schemas validate STRUCTURE only. Where the brand-checker has
 * domain rules (TenantId character set, SecretRef ARN shape), the
 * schema delegates to the brand checker via `.refine(...)` so there
 * is exactly one source of truth.
 */

import { z } from "zod";

import { isSecretRef } from "./secrets.js";
import { isTenantId } from "./tenant.js";
import type { TenantId } from "./tenant.js";
import { isTenantSubdomain } from "./tenant-subdomain.js";
import type { TenantSubdomain } from "./tenant-subdomain.js";
import type { ClientConfigRow } from "./client-config-row.js";

/**
 * Zod schema for `TenantId`. Delegates the predicate to `isTenantId`
 * so the brand-checker is the single source of truth for the rule.
 */
export const TenantIdSchema = z.string().refine((v): v is TenantId => isTenantId(v), {
  message: "must be a valid TenantId (1-256 chars, no whitespace, no control chars)",
});

/**
 * Zod schema for `SecretRef`. Delegates the predicate to `isSecretRef`.
 */
export const SecretRefSchema = z
  .object({
    arn: z.string(),
    versionId: z.string().optional(),
  })
  .refine(isSecretRef, {
    message: "must be a valid SecretRef (well-formed Secrets Manager ARN)",
  });

/** Closed: shapes alerting and retention queries. */
export const AuditOutcomeSchema = z.enum(["success", "failure"]);

/** Closed: shapes persistence retention tiers. */
export const AuditSeveritySchema = z.enum(["info", "warning", "error"]);

/** Open string union: well-known values plus extensions. */
export const AuditActionSchema = z.string().min(1);

export const AuditResourceSchema = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
});

/**
 * `AuditActor` is a discriminated union on `kind`. Zod 3 supports
 * `discriminatedUnion`, which gives better error paths than `union`.
 */
export const AuditActorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user"),
    userSub: z.string().min(1),
    idp: z
      .object({
        providerName: z.string().min(1),
        providerType: z.enum(["OIDC", "SAML"]),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal("service"),
    serviceName: z.string().min(1),
  }),
  z.object({
    kind: z.literal("system"),
    component: z.string().min(1),
  }),
  z.object({
    kind: z.literal("anonymous"),
  }),
]);

/**
 * JSON-value schema. Recursive; uses `z.lazy` for the object / array
 * branches. This is what `AuditEvent.metadata` carries.
 */
export const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/**
 * `AuditEventSchema` — validates the persisted shape. This is the
 * public boundary schema; the audit-module barrel re-exports it
 * when P3 lands.
 */
export const AuditEventSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().min(1),
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

/**
 * `PrincipalSchema` — for `RequestContext.principal`.
 */
export const PrincipalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user"),
    userSub: z.string().min(1),
    sessionId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("service"),
    serviceName: z.string().min(1),
  }),
  z.object({
    kind: z.literal("anonymous"),
  }),
]);

/**
 * `RequestContextSchema` — validates the runtime ALS carrier shape.
 * Used by middleware that reconstructs a context from a serialized
 * upstream representation.
 */
export const RequestContextSchema = z.object({
  requestId: z.string().min(1),
  startedAt: z.number().int().nonnegative(),
  tenantId: TenantIdSchema.optional(),
  principal: PrincipalSchema.optional(),
  traceId: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
  residencyRegion: z.string().min(1).optional(),
  clientIp: z.string().min(1).optional(),
});

/**
 * Zod schema for `TenantSubdomain`. Delegates the predicate to
 * `isTenantSubdomain` so the brand-checker is the single source of truth.
 */
export const TenantSubdomainSchema = z
  .string()
  .refine((v): v is TenantSubdomain => isTenantSubdomain(v), {
    message:
      "must be a valid TenantSubdomain (3-63 chars, /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/)",
  });

/**
 * Zod schema for `ClientConfigRow`. Validates the persisted DDB row shape.
 * Used by the admin Lambda when writing and reading from the ClientConfig table.
 *
 * Annotated with `z.ZodType<ClientConfigRow, ZodTypeDef, unknown>` to prevent
 * TS4023 errors from the brand symbols leaking into the exported type while
 * keeping the output type accurate. The double-cast via `unknown` is required
 * because the input side of the Zod schema uses `string` for fields that the
 * output side narrows to branded types.
 */
export const ClientConfigRowSchema: z.ZodType<ClientConfigRow, z.ZodTypeDef, unknown> =
  z.object({
    clientId: z.string().min(1),
    subdomain: TenantSubdomainSchema,
    tenantId: TenantIdSchema,
    siteBaseUrl: z.string().url().startsWith("https://"),
    allowedEmailDomains: z.array(
      z
        .string()
        .min(1)
        .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, {
          message: "must be a lowercased domain string (e.g. example.com)",
        }),
    ),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }).optional(),
  }) as unknown as z.ZodType<ClientConfigRow, z.ZodTypeDef, unknown>;
