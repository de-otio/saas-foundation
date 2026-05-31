/**
 * Zod schemas for the admin Lambda request/response shapes.
 *
 * Uses a discriminated union on `action` so unknown actions are rejected
 * at the boundary (Zod parse) rather than reaching the switch statement.
 * Each mutating schema uses `.strict()` to prevent unknown-field mutations
 * (e.g. an accidental `tenantId` or `subdomain` in an `updateTenant` body).
 *
 * Note: schemas that reference `TenantIdSchema` or `TenantSubdomainSchema`
 * (which contain brand-symbol types) are cast through `z.ZodType<T, ZodTypeDef, unknown>`
 * to prevent TS4023 errors from the brand symbols leaking into exported types.
 * Same pattern as `ClientConfigRowSchema` in the frozen-set module.
 *
 * See doc/vestibulum/shared-distribution/03-tenant-onboarding.md for the
 * canonical spec.
 */

import { z } from 'zod';
import type { TenantId, TenantSubdomain } from '@de-otio/saas-foundation/types/frozen';
import { TenantIdSchema, TenantSubdomainSchema } from '@de-otio/saas-foundation/types/frozen';

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------

/**
 * Idempotency key: 8–128 chars, alphanumeric + _ and -.
 * See 03-tenant-onboarding.md § Validation rules.
 */
export const IdempotencyKeySchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{8,128}$/, {
    message: 'must match ^[a-zA-Z0-9_-]{8,128}$',
  });

/**
 * Email domain: conservative DNS-name shape (lowercase, no wildcard).
 * Normalised on write per spec.
 */
export const EmailDomainSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, {
    message: 'must be a lowercased domain string (e.g. example.com)',
  });

// ---------------------------------------------------------------------------
// createTenant
// ---------------------------------------------------------------------------

export interface CreateTenantRequest {
  readonly action: 'createTenant';
  readonly subdomain: TenantSubdomain;
  readonly tenantId: TenantId;
  readonly allowedEmailDomains: readonly string[];
  readonly idempotencyKey: string;
}

export const CreateTenantRequestSchema: z.ZodType<CreateTenantRequest, z.ZodTypeDef, unknown> = (
  z
    .object({
      action: z.literal('createTenant'),
      subdomain: TenantSubdomainSchema,
      tenantId: TenantIdSchema,
      allowedEmailDomains: z.array(EmailDomainSchema),
      idempotencyKey: IdempotencyKeySchema,
    })
    .strict() as unknown
) as z.ZodType<CreateTenantRequest, z.ZodTypeDef, unknown>;

export interface CreateTenantResponse {
  readonly tenantId: string;
  readonly subdomain: string;
  readonly siteBaseUrl: string;
  readonly clientId: string;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// updateTenant
// ---------------------------------------------------------------------------

/**
 * `.strict()` is the load-bearing guard here: it rejects unknown fields
 * like `tenantId` or `subdomain`, enforcing the "only allowedEmailDomains
 * is mutable" invariant at the Zod parse boundary (B2 fix).
 */
export interface UpdateTenantRequest {
  readonly action: 'updateTenant';
  readonly tenantId: TenantId;
  readonly allowedEmailDomains: readonly string[];
}

export const UpdateTenantRequestSchema: z.ZodType<UpdateTenantRequest, z.ZodTypeDef, unknown> = (
  z
    .object({
      action: z.literal('updateTenant'),
      tenantId: TenantIdSchema,
      allowedEmailDomains: z.array(EmailDomainSchema),
    })
    .strict() as unknown
) as z.ZodType<UpdateTenantRequest, z.ZodTypeDef, unknown>;

export interface UpdateTenantResponse {
  readonly tenantId: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// deleteTenant
// ---------------------------------------------------------------------------

export interface DeleteTenantRequest {
  readonly action: 'deleteTenant';
  readonly tenantId: TenantId;
  readonly revokeActiveSessions?: boolean | undefined;
}

export const DeleteTenantRequestSchema: z.ZodType<DeleteTenantRequest, z.ZodTypeDef, unknown> = (
  z
    .object({
      action: z.literal('deleteTenant'),
      tenantId: TenantIdSchema,
      revokeActiveSessions: z.boolean().optional(),
    })
    .strict() as unknown
) as z.ZodType<DeleteTenantRequest, z.ZodTypeDef, unknown>;

// ---------------------------------------------------------------------------
// getTenant
// ---------------------------------------------------------------------------

export interface GetTenantRequest {
  readonly action: 'getTenant';
  readonly tenantId: TenantId;
}

export const GetTenantRequestSchema: z.ZodType<GetTenantRequest, z.ZodTypeDef, unknown> = (
  z
    .object({
      action: z.literal('getTenant'),
      tenantId: TenantIdSchema,
    })
    .strict() as unknown
) as z.ZodType<GetTenantRequest, z.ZodTypeDef, unknown>;

// ---------------------------------------------------------------------------
// listTenants
// ---------------------------------------------------------------------------

export interface ListTenantsRequest {
  readonly action: 'listTenants';
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export const ListTenantsRequestSchema: z.ZodType<ListTenantsRequest, z.ZodTypeDef, unknown> = (
  z
    .object({
      action: z.literal('listTenants'),
      cursor: z.string().optional(),
      limit: z.number().int().positive().max(100).optional(),
    })
    .strict() as unknown
) as z.ZodType<ListTenantsRequest, z.ZodTypeDef, unknown>;

// ---------------------------------------------------------------------------
// Discriminated union — the root request schema
//
// NOTE: Because the individual schemas are cast to ZodType<T, ...>, we must
// wrap this union similarly to suppress brand-symbol leakage.
// ---------------------------------------------------------------------------

export type AdminRequest =
  | CreateTenantRequest
  | UpdateTenantRequest
  | DeleteTenantRequest
  | GetTenantRequest
  | ListTenantsRequest;

/**
 * Root request schema. Parses the `action` discriminant first so unknown
 * action values fail at the boundary rather than reaching the switch.
 *
 * Because the individual schemas are cast to `ZodType<T>`, the discriminated
 * union must also be typed loosely to avoid TS inference depth errors with
 * the brand symbols.
 */
export const AdminRequestSchema: z.ZodType<AdminRequest, z.ZodTypeDef, unknown> = (
  z.discriminatedUnion('action', [
    z.object({ action: z.literal('createTenant'), subdomain: TenantSubdomainSchema, tenantId: TenantIdSchema, allowedEmailDomains: z.array(EmailDomainSchema), idempotencyKey: IdempotencyKeySchema }).strict(),
    z.object({ action: z.literal('updateTenant'), tenantId: TenantIdSchema, allowedEmailDomains: z.array(EmailDomainSchema) }).strict(),
    z.object({ action: z.literal('deleteTenant'), tenantId: TenantIdSchema, revokeActiveSessions: z.boolean().optional() }).strict(),
    z.object({ action: z.literal('getTenant'), tenantId: TenantIdSchema }).strict(),
    z.object({ action: z.literal('listTenants'), cursor: z.string().optional(), limit: z.number().int().positive().max(100).optional() }).strict(),
  ]) as unknown
) as z.ZodType<AdminRequest, z.ZodTypeDef, unknown>;
