/**
 * Tests for the shared-distribution PreTokenGeneration trigger handler.
 *
 * Required per 06 § Tests required:
 * - custom:tenant_id injected from row.
 * - No row → throws (via wrapPreTokenHandler).
 * - Suppression guard: handler that adds custom:tenant_id to claimsToSuppress throws.
 *
 * Note: the client-config-loader uses a module-level TTL cache (5 min).
 * Tests use distinct clientIds to avoid cross-test cache contamination.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { handler } from '../../../src/lambda/shared-distribution/triggers/pre-token-generation.js';
import {
  wrapPreTokenHandler,
  type PreTokenEventLike,
} from '../../../src/lambda/shared-distribution/shared/wrap-pre-token-handler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let clientIdCounter = 300;
function nextClientId(): string {
  return `ptg-client-${clientIdCounter++}`;
}

function makePreTokenEvent(clientId: string): PreTokenEventLike {
  return {
    callerContext: { clientId },
    response: {},
  };
}

function clientConfigItem(clientId: string, tenantId = 'tenant-a') {
  return {
    clientId: { S: clientId },
    tenantId: { S: tenantId },
    subdomain: { S: 'acme' },
    siteBaseUrl: { S: 'https://acme.tenants.example.com' },
    allowedEmailDomains: { SS: ['acme.com'] },
    createdAt: { S: '2024-01-01T00:00:00.000Z' },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('shared-distribution pre-token-generation handler', () => {
  const ddbMock = mockClient(DynamoDBClient);

  beforeEach(() => {
    ddbMock.reset();
    process.env['VESTIBULUM_CLIENT_CONFIG_TABLE'] = 'ClientConfig';
  });

  afterEach(() => {
    delete process.env['VESTIBULUM_CLIENT_CONFIG_TABLE'];
  });

  it('injects custom:tenant_id from ClientConfig row', async () => {
    const clientId = nextClientId();
    ddbMock.on(GetItemCommand).resolves({ Item: clientConfigItem(clientId, 'tenant-xyz') });
    const event = makePreTokenEvent(clientId);
    const result = await handler(event);
    expect(
      result.response!.claimsOverrideDetails?.claimsToAddOrOverride?.['custom:tenant_id'],
    ).toBe('tenant-xyz');
  });

  it('throws when no ClientConfig row exists', async () => {
    const clientId = nextClientId();
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    const event = makePreTokenEvent(clientId);
    await expect(handler(event)).rejects.toThrow('Tenant configuration missing');
  });

  it('propagates DDB error (fail-closed)', async () => {
    const clientId = nextClientId();
    ddbMock.on(GetItemCommand).rejects(new Error('DDB error'));
    const event = makePreTokenEvent(clientId);
    await expect(handler(event)).rejects.toThrow('DDB error');
  });

  it('returns the event with custom:tenant_id set correctly', async () => {
    const clientId = nextClientId();
    ddbMock.on(GetItemCommand).resolves({ Item: clientConfigItem(clientId, 't-42') });
    const event = makePreTokenEvent(clientId);
    const result = await handler(event);
    expect(result).toBe(event);
    expect(
      result.response!.claimsOverrideDetails?.claimsToAddOrOverride?.['custom:tenant_id'],
    ).toBe('t-42');
  });
});

describe('wrapPreTokenHandler — contract enforcement (smoke tests)', () => {
  const ddbMock = mockClient(DynamoDBClient);

  beforeEach(() => {
    ddbMock.reset();
    process.env['VESTIBULUM_CLIENT_CONFIG_TABLE'] = 'ClientConfig';
  });

  afterEach(() => {
    delete process.env['VESTIBULUM_CLIENT_CONFIG_TABLE'];
  });

  it('throws when inner handler overwrites custom:tenant_id', async () => {
    const clientId = nextClientId();
    ddbMock.on(GetItemCommand).resolves({ Item: clientConfigItem(clientId, 'tenant-a') });
    const badHandler = wrapPreTokenHandler(async (event) => {
      event.response!.claimsOverrideDetails!.claimsToAddOrOverride!['custom:tenant_id'] = 'evil';
      return event;
    });
    const event = makePreTokenEvent(clientId);
    await expect(badHandler(event)).rejects.toThrow(
      /handler must not overwrite custom:tenant_id/,
    );
  });

  it('throws when inner handler adds custom:tenant_id to claimsToSuppress', async () => {
    const clientId = nextClientId();
    ddbMock.on(GetItemCommand).resolves({ Item: clientConfigItem(clientId, 'tenant-a') });
    const badHandler = wrapPreTokenHandler(async (event) => {
      event.response!.claimsOverrideDetails!.claimsToSuppress = ['custom:tenant_id'];
      return event;
    });
    const event = makePreTokenEvent(clientId);
    await expect(badHandler(event)).rejects.toThrow(
      /handler must not suppress custom:tenant_id/,
    );
  });

  it('passes through when inner handler adds other claims without touching tenant_id', async () => {
    const clientId = nextClientId();
    ddbMock.on(GetItemCommand).resolves({ Item: clientConfigItem(clientId, 'tenant-a') });
    const goodHandler = wrapPreTokenHandler(async (event) => {
      event.response!.claimsOverrideDetails!.claimsToAddOrOverride!['custom:role'] = 'admin';
      return event;
    });
    const event = makePreTokenEvent(clientId);
    const result = await goodHandler(event);
    expect(result.response!.claimsOverrideDetails?.claimsToAddOrOverride?.['custom:tenant_id']).toBe('tenant-a');
    expect(result.response!.claimsOverrideDetails?.claimsToAddOrOverride?.['custom:role']).toBe('admin');
  });

  it('propagates errors thrown by the inner handler', async () => {
    const clientId = nextClientId();
    ddbMock.on(GetItemCommand).resolves({ Item: clientConfigItem(clientId, 'tenant-a') });
    const errorHandler = wrapPreTokenHandler<PreTokenEventLike>(async () => {
      throw new Error('inner error');
    });
    const event = makePreTokenEvent(clientId);
    await expect(errorHandler(event)).rejects.toThrow('inner error');
  });
});
