/**
 * Tests for the shared-distribution PreSignUp trigger handler.
 *
 * Required per 06 § Tests required:
 * - Stubbed DDB returns allowlist → admits matching email, rejects non-matching.
 * - No row → throws.
 * - DDB error → throws (fail-closed).
 *
 * Note: the client-config-loader uses a module-level TTL cache (5 min).
 * Tests use distinct clientIds to avoid cross-test cache contamination.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { handler, type SharedPreSignUpEvent } from '../../../src/lambda/shared-distribution/triggers/pre-signup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let clientIdCounter = 100;
function nextClientId(): string {
  return `pre-signup-client-${clientIdCounter++}`;
}

function makeEvent(email: string, clientId: string): SharedPreSignUpEvent {
  return {
    callerContext: { clientId },
    request: { userAttributes: { email } },
    response: {},
  };
}

function clientConfigItem(clientId: string, allowedDomains: string[]) {
  return {
    clientId: { S: clientId },
    tenantId: { S: 'tenant-a' },
    subdomain: { S: 'acme' },
    siteBaseUrl: { S: 'https://acme.tenants.example.com' },
    allowedEmailDomains: { SS: allowedDomains },
    createdAt: { S: '2024-01-01T00:00:00.000Z' },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('shared-distribution pre-signup handler', () => {
  const ddbMock = mockClient(DynamoDBClient);

  beforeEach(() => {
    ddbMock.reset();
    process.env['VESTIBULUM_CLIENT_CONFIG_TABLE'] = 'ClientConfig';
  });

  afterEach(() => {
    delete process.env['VESTIBULUM_CLIENT_CONFIG_TABLE'];
  });

  it('admits an email whose domain is in the per-client allowlist', async () => {
    const clientId = nextClientId();
    ddbMock.on(GetItemCommand).resolves({ Item: clientConfigItem(clientId, ['acme.com']) });
    const event = makeEvent('user@acme.com', clientId);
    const result = await handler(event);
    expect(result).toBe(event);
  });

  it('rejects an email whose domain is NOT in the allowlist', async () => {
    const clientId = nextClientId();
    ddbMock.on(GetItemCommand).resolves({ Item: clientConfigItem(clientId, ['acme.com']) });
    const event = makeEvent('user@other.com', clientId);
    await expect(handler(event)).rejects.toThrow('Signup not allowed');
  });

  it('is case-insensitive: uppercase email is normalised before domain check', async () => {
    const clientId = nextClientId();
    ddbMock.on(GetItemCommand).resolves({ Item: clientConfigItem(clientId, ['acme.com']) });
    const event = makeEvent('USER@ACME.COM', clientId);
    const result = await handler(event);
    expect(result).toBe(event);
  });

  it('trims whitespace from email before domain check', async () => {
    const clientId = nextClientId();
    ddbMock.on(GetItemCommand).resolves({ Item: clientConfigItem(clientId, ['acme.com']) });
    const event = makeEvent('  user@acme.com  ', clientId);
    const result = await handler(event);
    expect(result).toBe(event);
  });

  it('rejects when no ClientConfig row exists for the clientId', async () => {
    const clientId = nextClientId();
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    const event = makeEvent('user@acme.com', clientId);
    await expect(handler(event)).rejects.toThrow('Signup not allowed');
  });

  it('propagates DDB error (fail-closed)', async () => {
    const clientId = nextClientId();
    ddbMock.on(GetItemCommand).rejects(new Error('DDB unavailable'));
    const event = makeEvent('user@acme.com', clientId);
    await expect(handler(event)).rejects.toThrow('DDB unavailable');
  });

  it('rejects empty email (no @ present)', async () => {
    const clientId = nextClientId();
    ddbMock.on(GetItemCommand).resolves({ Item: clientConfigItem(clientId, ['acme.com']) });
    const event = makeEvent('', clientId);
    await expect(handler(event)).rejects.toThrow('Signup not allowed');
  });

  it('rejects email with no domain part (trailing @)', async () => {
    const clientId = nextClientId();
    ddbMock.on(GetItemCommand).resolves({ Item: clientConfigItem(clientId, ['acme.com']) });
    const event = makeEvent('user@', clientId);
    await expect(handler(event)).rejects.toThrow('Signup not allowed');
  });

  it('rejects when allowedEmailDomains is empty (signups disabled)', async () => {
    const clientId = nextClientId();
    ddbMock.on(GetItemCommand).resolves({ Item: clientConfigItem(clientId, ['placeholder']) });
    // Override with empty domains for this scenario via separate clientId
    const clientIdEmpty = nextClientId();
    ddbMock.on(GetItemCommand).resolves({ Item: clientConfigItem(clientIdEmpty, []) });
    const event = makeEvent('user@acme.com', clientIdEmpty);
    await expect(handler(event)).rejects.toThrow('Signup not allowed');
  });

  it('uses per-clientId allowlist: unknown client returns no row → refuse', async () => {
    const clientId = nextClientId();
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    const event = makeEvent('user@acme.com', clientId);
    await expect(handler(event)).rejects.toThrow('Signup not allowed');
  });

  it('returns the same event object reference on success', async () => {
    const clientId = nextClientId();
    ddbMock.on(GetItemCommand).resolves({ Item: clientConfigItem(clientId, ['corp.io']) });
    const event = makeEvent('alice@corp.io', clientId);
    const result = await handler(event);
    expect(result).toStrictEqual(event);
  });
});
