/**
 * Tests for the updateTenant action.
 *
 * Required cases:
 * - allowedEmailDomains updated successfully.
 * - Mutation attempt on tenantId rejected at Zod parse (B2).
 * - Mutation attempt on subdomain rejected at Zod parse.
 * - AllowlistChanged metric emitted.
 * - TenantNotFoundError when row absent.
 */

import {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateTenant, TenantNotFoundError } from '../../../../src/lambda/shared-distribution/admin/actions/update-tenant.js';
import type { UpdateTenantDeps } from '../../../../src/lambda/shared-distribution/admin/actions/update-tenant.js';
import type { CallerIdentity } from '../../../../src/lambda/shared-distribution/admin/audit-log.js';
import { UpdateTenantRequestSchema } from '../../../../src/lambda/shared-distribution/admin/schemas.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const ddbMock = mockClient(DynamoDBClient);

const CALLER: CallerIdentity = {
  callerArn: 'arn:aws:iam::123456789012:role/Admin',
  callerAccount: '123456789012',
  callerId: 'AIDA123456789',
};

function makeDeps(): UpdateTenantDeps {
  return {
    ddb: new DynamoDBClient({}),
    clientConfigTable: 'ClientConfig',
  };
}

function makeExistingItem(tenantId = 'acme', clientId = 'client-001', subdomain = 'acme') {
  return {
    clientId: { S: clientId },
    subdomain: { S: subdomain },
    tenantId: { S: tenantId },
    allowedEmailDomains: { SS: ['acme.example'] },
    siteBaseUrl: { S: 'https://acme.tenants.example.com' },
    createdAt: { S: '2026-01-01T00:00:00.000Z' },
  };
}

beforeEach(() => {
  ddbMock.reset();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('updateTenant — happy path', () => {
  it('updates allowedEmailDomains successfully', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [makeExistingItem()] });
    ddbMock.on(UpdateItemCommand).resolves({});

    const result = await updateTenant(
      { action: 'updateTenant', tenantId: 'acme', allowedEmailDomains: ['new.example'] },
      makeDeps(),
      CALLER,
      'req-u-001',
    );

    expect(result.tenantId).toBe('acme');
    expect(result.updatedAt).toBeTruthy();

    // UpdateItemCommand should have been called with new domains
    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);
    const input = updateCalls[0]!.args[0].input;
    expect(input.ExpressionAttributeValues?.[':ed']?.SS).toContain('new.example');
  });

  it('emits AllowlistChanged metric', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [makeExistingItem()] });
    ddbMock.on(UpdateItemCommand).resolves({});
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await updateTenant(
      { action: 'updateTenant', tenantId: 'acme', allowedEmailDomains: ['new.example'] },
      makeDeps(),
      CALLER,
      'req-u-002',
    );

    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(written).toContain('AllowlistChanged');
  });

  it('emits TenantUpdated metric', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [makeExistingItem()] });
    ddbMock.on(UpdateItemCommand).resolves({});
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await updateTenant(
      { action: 'updateTenant', tenantId: 'acme', allowedEmailDomains: [] },
      makeDeps(),
      CALLER,
      'req-u-003',
    );

    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(written).toContain('TenantUpdated');
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('updateTenant — errors', () => {
  it('throws TenantNotFoundError when no row found', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await expect(
      updateTenant(
        { action: 'updateTenant', tenantId: 'ghost', allowedEmailDomains: [] },
        makeDeps(),
        CALLER,
        'req-u-004',
      ),
    ).rejects.toBeInstanceOf(TenantNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Zod parse-level rejection: tenantId / subdomain mutation (B2)
// ---------------------------------------------------------------------------

describe('UpdateTenantRequestSchema — immutable field protection (B2)', () => {
  it('rejects attempt to mutate tenantId via Zod .strict()', () => {
    const r = UpdateTenantRequestSchema.safeParse({
      action: 'updateTenant',
      tenantId: 'acme',
      allowedEmailDomains: [],
      // Trying to change tenantId via an unknown-looking key is rejected
      newTenantId: 'attacker',
    });
    expect(r.success).toBe(false);
  });

  it('rejects attempt to include subdomain field via Zod .strict()', () => {
    const r = UpdateTenantRequestSchema.safeParse({
      action: 'updateTenant',
      tenantId: 'acme',
      allowedEmailDomains: [],
      subdomain: 'new-subdomain',
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown fields', () => {
    const r = UpdateTenantRequestSchema.safeParse({
      action: 'updateTenant',
      tenantId: 'acme',
      allowedEmailDomains: [],
      expiryDate: '2026-12-01',
    });
    expect(r.success).toBe(false);
  });

  it('accepts the only valid shape', () => {
    const r = UpdateTenantRequestSchema.safeParse({
      action: 'updateTenant',
      tenantId: 'acme',
      allowedEmailDomains: ['acme.example'],
    });
    expect(r.success).toBe(true);
  });
});
