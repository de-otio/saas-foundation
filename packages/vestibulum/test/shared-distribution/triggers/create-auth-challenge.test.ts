/**
 * Tests for the shared-distribution CreateAuthChallenge trigger handler.
 *
 * Required per 06 § Tests required:
 * - Stubbed DDB → magic link uses per-client siteBaseUrl.
 * - DDB error → throws (fail-closed).
 *
 * Note: the client-config-loader uses a module-level TTL cache (5 min).
 * Tests use distinct clientIds to avoid cross-test cache contamination.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import {
  createSharedCreateAuthChallengeHandler,
  type SharedCreateAuthChallengeEvent,
} from '../../../src/lambda/shared-distribution/triggers/create-auth-challenge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let clientIdCounter = 200;
function nextClientId(): string {
  return `cac-client-${clientIdCounter++}`;
}

function makeEvent(email: string, clientId: string): SharedCreateAuthChallengeEvent {
  return {
    callerContext: { clientId },
    request: { userAttributes: { email } },
    response: {},
  };
}

function clientConfigItem(clientId: string, siteBaseUrl: string) {
  return {
    clientId: { S: clientId },
    tenantId: { S: 'tenant-a' },
    subdomain: { S: 'acme' },
    siteBaseUrl: { S: siteBaseUrl },
    allowedEmailDomains: { SS: ['acme.com'] },
    createdAt: { S: '2024-01-01T00:00:00.000Z' },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('shared-distribution create-auth-challenge handler', () => {
  const ddbMock = mockClient(DynamoDBClient);
  const sesMock = mockClient(SESClient);

  beforeEach(() => {
    ddbMock.reset();
    sesMock.reset();
    process.env['VESTIBULUM_CLIENT_CONFIG_TABLE'] = 'ClientConfig';
    process.env['VESTIBULUM_TOKEN_TABLE'] = 'MagicLinkTokens';
    process.env['VESTIBULUM_RATE_LIMIT_TABLE'] = 'RateLimit';
    process.env['VESTIBULUM_SES_FROM'] = 'noreply@example.com';
  });

  afterEach(() => {
    delete process.env['VESTIBULUM_CLIENT_CONFIG_TABLE'];
    delete process.env['VESTIBULUM_TOKEN_TABLE'];
    delete process.env['VESTIBULUM_RATE_LIMIT_TABLE'];
    delete process.env['VESTIBULUM_SES_FROM'];
  });

  it('builds magic-link URL using per-client siteBaseUrl', async () => {
    const clientId = nextClientId();
    const siteBaseUrl = 'https://acme.tenants.example.com';
    ddbMock.on(GetItemCommand).resolves({ Item: clientConfigItem(clientId, siteBaseUrl) });
    ddbMock.on(UpdateItemCommand).resolves({});
    ddbMock.on(PutItemCommand).resolves({});
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'msg-1' });

    const ddbClient = new DynamoDBClient({});
    const sesClient = new SESClient({});
    const h = createSharedCreateAuthChallengeHandler({
      dynamodb: ddbClient,
      ses: sesClient,
      randomToken: () => Buffer.alloc(32, 0xab),
    });

    const event = makeEvent('user@acme.com', clientId);
    const result = await h(event);

    // The SES command should have been called with a body containing the siteBaseUrl.
    const sesCalls = sesMock.calls();
    expect(sesCalls.length).toBe(1);
    const sesInput = sesCalls[0]?.args[0] as { input: { Message: { Body: { Text: { Data: string } } } } };
    const textBody = sesInput?.input?.Message?.Body?.Text?.Data ?? '';
    expect(textBody).toContain(siteBaseUrl);
    expect(textBody).toContain('/login/callback#token=');

    // Response params should be set.
    expect(result.response.challengeMetadata).toBe('MAGIC_LINK');
    expect(result.response.privateChallengeParameters?.['quarantined']).toBe('false');
  });

  it('uses correct siteBaseUrl for a second tenant (beta)', async () => {
    const clientId = nextClientId();
    const siteBaseUrl = 'https://beta.tenants.example.com';
    ddbMock.on(GetItemCommand).resolves({ Item: clientConfigItem(clientId, siteBaseUrl) });
    ddbMock.on(UpdateItemCommand).resolves({});
    ddbMock.on(PutItemCommand).resolves({});
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'msg-2' });

    const ddbClient = new DynamoDBClient({});
    const sesClient = new SESClient({});
    const h = createSharedCreateAuthChallengeHandler({
      dynamodb: ddbClient,
      ses: sesClient,
    });

    await h(makeEvent('user@acme.com', clientId));

    const sesCalls = sesMock.calls();
    expect(sesCalls.length).toBeGreaterThan(0);
    const sesInput = sesCalls[0]?.args[0] as { input: { Message: { Body: { Text: { Data: string } } } } };
    const textBody = sesInput?.input?.Message?.Body?.Text?.Data ?? '';
    expect(textBody).toContain(siteBaseUrl);
  });

  it('throws "Auth challenge failed" when no ClientConfig row exists', async () => {
    const clientId = nextClientId();
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });

    const ddbClient = new DynamoDBClient({});
    const sesClient = new SESClient({});
    const h = createSharedCreateAuthChallengeHandler({ dynamodb: ddbClient, ses: sesClient });

    await expect(h(makeEvent('user@acme.com', clientId))).rejects.toThrow('Auth challenge failed');
  });

  it('propagates DDB error (fail-closed)', async () => {
    const clientId = nextClientId();
    ddbMock.on(GetItemCommand).rejects(new Error('DDB unavailable'));

    const ddbClient = new DynamoDBClient({});
    const sesClient = new SESClient({});
    const h = createSharedCreateAuthChallengeHandler({ dynamodb: ddbClient, ses: sesClient });

    await expect(h(makeEvent('user@acme.com', clientId))).rejects.toThrow('DDB unavailable');
  });

  it('returns fail-closed challenge (quarantined=true) on denylist hit', async () => {
    const clientId = nextClientId();
    process.env['VESTIBULUM_DENYLIST_TABLE'] = 'Denylist';
    try {
      ddbMock.on(GetItemCommand)
        // First call: ClientConfig GetItem
        .resolvesOnce({ Item: clientConfigItem(clientId, 'https://acme.tenants.example.com') })
        // Second call: denylist GetItem (hit)
        .resolvesOnce({ Item: { email_hash: { S: 'hash' } } });
      ddbMock.on(UpdateItemCommand).resolves({});

      const ddbClient = new DynamoDBClient({});
      const sesClient = new SESClient({});
      const h = createSharedCreateAuthChallengeHandler({
        dynamodb: ddbClient,
        ses: sesClient,
      });

      const result = await h(makeEvent('user@acme.com', clientId));
      expect(result.response.privateChallengeParameters?.['quarantined']).toBe('true');
    } finally {
      delete process.env['VESTIBULUM_DENYLIST_TABLE'];
    }
  });

  it('sets non-denied token_hash in private challenge parameters on success', async () => {
    const clientId = nextClientId();
    ddbMock.on(GetItemCommand).resolves({ Item: clientConfigItem(clientId, 'https://acme.tenants.example.com') });
    ddbMock.on(UpdateItemCommand).resolves({});
    ddbMock.on(PutItemCommand).resolves({});
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'msg-3' });

    const fixedToken = Buffer.alloc(32, 0xcc);
    const ddbClient = new DynamoDBClient({});
    const sesClient = new SESClient({});
    const h = createSharedCreateAuthChallengeHandler({
      dynamodb: ddbClient,
      ses: sesClient,
      randomToken: () => fixedToken,
    });

    const result = await h(makeEvent('user@acme.com', clientId));
    const hash = result.response.privateChallengeParameters?.['token_hash'];
    expect(hash).toBeDefined();
    expect(hash).not.toBe('denied');
    expect(hash).toHaveLength(64); // sha256 hex
  });

  it('sets email in public and private challenge parameters', async () => {
    const clientId = nextClientId();
    ddbMock.on(GetItemCommand).resolves({ Item: clientConfigItem(clientId, 'https://acme.tenants.example.com') });
    ddbMock.on(UpdateItemCommand).resolves({});
    ddbMock.on(PutItemCommand).resolves({});
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'msg-4' });

    const ddbClient = new DynamoDBClient({});
    const sesClient = new SESClient({});
    const h = createSharedCreateAuthChallengeHandler({ dynamodb: ddbClient, ses: sesClient });

    const event = makeEvent('test@acme.com', clientId);
    const result = await h(event);

    expect(result.response.publicChallengeParameters?.['email']).toBe('test@acme.com');
    expect(result.response.privateChallengeParameters?.['email']).toBe('test@acme.com');
  });
});
