/**
 * Tests for the shared-distribution auth-signout Function URL handler.
 *
 * Required per 06 § Tests required:
 * - Cookie cleared with exact-host Domain (no leading dot).
 * - Invalid Host → 400.
 *
 * Note: loadClientConfigBySubdomain uses a module-level TTL cache (5 min).
 * Tests use distinct subdomain values to avoid cross-test cache contamination.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import {
  createAuthSignoutHandler,
  type FunctionUrlEvent,
} from '../../../src/lambda/shared-distribution/triggers/auth-signout.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_PARENT = 'tenants.example.com';

let subdomainCounter = 500;
function nextSubdomain(): string {
  return `signout${subdomainCounter++}`;
}

function makeEvent(host: string | undefined): FunctionUrlEvent {
  return { headers: host !== undefined ? { host } : {} };
}

function clientConfigQueryResult(clientId: string, subdomain: string) {
  return {
    Items: [{
      clientId: { S: clientId },
      tenantId: { S: 'tenant-a' },
      subdomain: { S: subdomain },
      siteBaseUrl: { S: `https://${subdomain}.${TENANT_PARENT}` },
      allowedEmailDomains: { SS: ['acme.com'] },
      createdAt: { S: '2024-01-01T00:00:00.000Z' },
    }],
    Count: 1,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('shared-distribution auth-signout handler', () => {
  const ddbMock = mockClient(DynamoDBClient);

  beforeEach(() => {
    ddbMock.reset();
    process.env['VESTIBULUM_CLIENT_CONFIG_TABLE'] = 'ClientConfig';
  });

  afterEach(() => {
    delete process.env['VESTIBULUM_CLIENT_CONFIG_TABLE'];
  });

  // -- Invalid host → 400 --

  it('returns 400 when Host is absent', async () => {
    const h = createAuthSignoutHandler({ tenantParent: TENANT_PARENT });
    const result = await h(makeEvent(undefined));
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when Host is a .on.aws direct invocation', async () => {
    const h = createAuthSignoutHandler({ tenantParent: TENANT_PARENT });
    const event = makeEvent('abc123.lambda-url.us-east-1.on.aws');
    const result = await h(event);
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when Host is the parent domain without subdomain', async () => {
    const h = createAuthSignoutHandler({ tenantParent: TENANT_PARENT });
    const result = await h(makeEvent(TENANT_PARENT));
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when Host has a multi-level subdomain', async () => {
    const h = createAuthSignoutHandler({ tenantParent: TENANT_PARENT });
    const result = await h(makeEvent(`nested.acme.${TENANT_PARENT}`));
    expect(result.statusCode).toBe(400);
  });

  // -- Cookie clearing with exact domain --

  it('clears cookies with exact-host Domain (no leading dot)', async () => {
    const subdomain = nextSubdomain();
    ddbMock.on(QueryCommand).resolves(clientConfigQueryResult(`client-${subdomain}`, subdomain));

    const h = createAuthSignoutHandler({ tenantParent: TENANT_PARENT });
    const result = await h(makeEvent(`${subdomain}.${TENANT_PARENT}`));

    expect(result.statusCode).toBe(303);
    const setCookies = result.cookies ?? [];
    expect(setCookies.length).toBeGreaterThanOrEqual(2);

    const exactDomain = `${subdomain}.${TENANT_PARENT}`;
    for (const cookie of setCookies) {
      // No leading dot in Domain
      expect(cookie).toContain(`Domain=${exactDomain}`);
      expect(cookie).not.toContain(`Domain=.${subdomain}`);
      // Max-Age=0 to clear
      expect(cookie).toContain('Max-Age=0');
    }
  });

  it('id-token cookie is cleared with Max-Age=0', async () => {
    const subdomain = nextSubdomain();
    ddbMock.on(QueryCommand).resolves(clientConfigQueryResult(`client-${subdomain}`, subdomain));

    const h = createAuthSignoutHandler({ tenantParent: TENANT_PARENT });
    const result = await h(makeEvent(`${subdomain}.${TENANT_PARENT}`));

    const setCookies = result.cookies ?? [];
    const idCookie = setCookies.find((c) => c.startsWith('id-token='));
    expect(idCookie).toBeDefined();
    expect(idCookie).toContain('Max-Age=0');
    expect(idCookie).toContain('HttpOnly');
    expect(idCookie).toContain('Secure');
  });

  it('refresh-token cookie is cleared with Max-Age=0', async () => {
    const subdomain = nextSubdomain();
    ddbMock.on(QueryCommand).resolves(clientConfigQueryResult(`client-${subdomain}`, subdomain));

    const h = createAuthSignoutHandler({ tenantParent: TENANT_PARENT });
    const result = await h(makeEvent(`${subdomain}.${TENANT_PARENT}`));

    const setCookies = result.cookies ?? [];
    const rtCookie = setCookies.find((c) => c.startsWith('refresh-token='));
    expect(rtCookie).toBeDefined();
    expect(rtCookie).toContain('Max-Age=0');
  });

  it('redirects to tenant siteBaseUrl on signout', async () => {
    const subdomain = nextSubdomain();
    ddbMock.on(QueryCommand).resolves(clientConfigQueryResult(`client-${subdomain}`, subdomain));

    const h = createAuthSignoutHandler({ tenantParent: TENANT_PARENT });
    const result = await h(makeEvent(`${subdomain}.${TENANT_PARENT}`));

    expect(result.statusCode).toBe(303);
    expect(result.headers?.['location']).toBe(`https://${subdomain}.${TENANT_PARENT}/`);
  });

  it('returns 404 when no ClientConfig exists for the subdomain', async () => {
    const subdomain = nextSubdomain();
    ddbMock.on(QueryCommand).resolves({ Items: [], Count: 0 });

    const h = createAuthSignoutHandler({ tenantParent: TENANT_PARENT });
    const result = await h(makeEvent(`${subdomain}.${TENANT_PARENT}`));
    expect(result.statusCode).toBe(404);
  });

  it('propagates DDB error (fail-closed)', async () => {
    const subdomain = nextSubdomain();
    ddbMock.on(QueryCommand).rejects(new Error('DDB error'));

    const h = createAuthSignoutHandler({ tenantParent: TENANT_PARENT });
    await expect(h(makeEvent(`${subdomain}.${TENANT_PARENT}`))).rejects.toThrow('DDB error');
  });
});
