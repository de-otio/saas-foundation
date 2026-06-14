/**
 * Tests for admin Lambda Zod schemas.
 *
 * Focus: discriminated-union parsing, unknown action rejection,
 * idempotency key validation, strict-mode rejection of unknown fields.
 */

import { describe, expect, it } from 'vitest';
import {
  AdminRequestSchema,
  CreateTenantRequestSchema,
  UpdateTenantRequestSchema,
  DeleteTenantRequestSchema,
  GetTenantRequestSchema,
  ListTenantsRequestSchema,
  IdempotencyKeySchema,
} from '../../../src/lambda/shared-distribution/admin/schemas.js';

// ---------------------------------------------------------------------------
// Discriminated-union: unknown action → 400-worthy parse failure
// ---------------------------------------------------------------------------

describe('AdminRequestSchema discriminated union', () => {
  it('rejects unknown action value', () => {
    const result = AdminRequestSchema.safeParse({ action: 'nukeTenants' });
    expect(result.success).toBe(false);
  });

  it('rejects missing action field', () => {
    const result = AdminRequestSchema.safeParse({ subdomain: 'acme' });
    expect(result.success).toBe(false);
  });

  it('accepts createTenant', () => {
    const result = AdminRequestSchema.safeParse({
      action: 'createTenant',
      subdomain: 'acme',
      tenantId: 'acme',
      allowedEmailDomains: ['acme.example'],
      idempotencyKey: 'test-idempotency-key-01',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.action).toBe('createTenant');
  });

  it('accepts updateTenant', () => {
    const result = AdminRequestSchema.safeParse({
      action: 'updateTenant',
      tenantId: 'acme',
      allowedEmailDomains: ['acme.example'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts deleteTenant', () => {
    const result = AdminRequestSchema.safeParse({
      action: 'deleteTenant',
      tenantId: 'acme',
    });
    expect(result.success).toBe(true);
  });

  it('accepts getTenant', () => {
    const result = AdminRequestSchema.safeParse({
      action: 'getTenant',
      tenantId: 'acme',
    });
    expect(result.success).toBe(true);
  });

  it('accepts listTenants', () => {
    const result = AdminRequestSchema.safeParse({
      action: 'listTenants',
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createTenant schema validation
// ---------------------------------------------------------------------------

describe('CreateTenantRequestSchema', () => {
  const valid = {
    action: 'createTenant' as const,
    subdomain: 'acme',
    tenantId: 'acme',
    allowedEmailDomains: ['acme.example'],
    idempotencyKey: 'test-idempotency-key-01',
  };

  it('accepts valid input', () => {
    expect(CreateTenantRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects invalid subdomain (uppercase)', () => {
    const r = CreateTenantRequestSchema.safeParse({ ...valid, subdomain: 'ACME' });
    expect(r.success).toBe(false);
  });

  it('rejects subdomain too short', () => {
    const r = CreateTenantRequestSchema.safeParse({ ...valid, subdomain: 'ab' });
    expect(r.success).toBe(false);
  });

  it('rejects invalid email domain (has @)', () => {
    const r = CreateTenantRequestSchema.safeParse({
      ...valid,
      allowedEmailDomains: ['user@example.com'],
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown fields (.strict())', () => {
    const r = CreateTenantRequestSchema.safeParse({ ...valid, extra: 'field' });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// updateTenant .strict() — no tenantId or subdomain mutation
// ---------------------------------------------------------------------------

describe('UpdateTenantRequestSchema strict mode (B2)', () => {
  const valid = {
    action: 'updateTenant' as const,
    tenantId: 'acme',
    allowedEmailDomains: ['acme.example'],
  };

  it('accepts valid input', () => {
    expect(UpdateTenantRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects attempt to mutate subdomain', () => {
    const r = UpdateTenantRequestSchema.safeParse({ ...valid, subdomain: 'acme' });
    expect(r.success).toBe(false);
  });

  it('rejects unknown fields', () => {
    const r = UpdateTenantRequestSchema.safeParse({ ...valid, newTenantId: 'evil' });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deleteTenant schema
// ---------------------------------------------------------------------------

describe('DeleteTenantRequestSchema', () => {
  it('accepts minimal delete', () => {
    const r = DeleteTenantRequestSchema.safeParse({ action: 'deleteTenant', tenantId: 'acme' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.revokeActiveSessions).toBeUndefined();
  });

  it('accepts revokeActiveSessions: true', () => {
    const r = DeleteTenantRequestSchema.safeParse({
      action: 'deleteTenant',
      tenantId: 'acme',
      revokeActiveSessions: true,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.revokeActiveSessions).toBe(true);
  });

  it('rejects unknown fields', () => {
    const r = DeleteTenantRequestSchema.safeParse({
      action: 'deleteTenant',
      tenantId: 'acme',
      extra: 'field',
    });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getTenant schema
// ---------------------------------------------------------------------------

describe('GetTenantRequestSchema', () => {
  it('accepts valid tenantId', () => {
    const r = GetTenantRequestSchema.safeParse({ action: 'getTenant', tenantId: 'acme' });
    expect(r.success).toBe(true);
  });

  it('rejects unknown fields', () => {
    const r = GetTenantRequestSchema.safeParse({ action: 'getTenant', tenantId: 'acme', extra: 'x' });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listTenants schema
// ---------------------------------------------------------------------------

describe('ListTenantsRequestSchema', () => {
  it('accepts empty request', () => {
    const r = ListTenantsRequestSchema.safeParse({ action: 'listTenants' });
    expect(r.success).toBe(true);
  });

  it('accepts limit and cursor', () => {
    const r = ListTenantsRequestSchema.safeParse({
      action: 'listTenants',
      limit: 10,
      cursor: 'abc123',
    });
    expect(r.success).toBe(true);
  });

  it('rejects limit > 100', () => {
    const r = ListTenantsRequestSchema.safeParse({ action: 'listTenants', limit: 101 });
    expect(r.success).toBe(false);
  });

  it('rejects unknown fields', () => {
    const r = ListTenantsRequestSchema.safeParse({ action: 'listTenants', extra: 'x' });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Idempotency key validation
// ---------------------------------------------------------------------------

describe('IdempotencyKeySchema', () => {
  it('accepts 8-char key', () => {
    expect(IdempotencyKeySchema.safeParse('abcd1234').success).toBe(true);
  });

  it('accepts 128-char key', () => {
    expect(IdempotencyKeySchema.safeParse('a'.repeat(128)).success).toBe(true);
  });

  it('accepts underscores and hyphens', () => {
    expect(IdempotencyKeySchema.safeParse('abc_def-ghi').success).toBe(true);
  });

  it('rejects 7-char key (too short)', () => {
    expect(IdempotencyKeySchema.safeParse('abc1234').success).toBe(false);
  });

  it('rejects 129-char key (too long)', () => {
    expect(IdempotencyKeySchema.safeParse('a'.repeat(129)).success).toBe(false);
  });

  it('rejects keys with spaces', () => {
    expect(IdempotencyKeySchema.safeParse('abcd 1234').success).toBe(false);
  });

  it('rejects keys with special chars (e.g. /)', () => {
    expect(IdempotencyKeySchema.safeParse('abcd/1234').success).toBe(false);
  });
});
