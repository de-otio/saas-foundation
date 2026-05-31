/**
 * Tests for the shared-distribution auth-verify Function URL handler.
 *
 * Required per 06 § Tests required:
 * - Refresh flow: GetTokensFromRefreshToken invoked with correct ClientId;
 *   rotated tokens written to cookies.
 * - Direct .on.aws invocation (Host doesn't match TENANT_PARENT) → 400.
 * - No ClientConfig for resolved subdomain → 404.
 *
 * Note: loadClientConfigBySubdomain uses a module-level TTL cache (5 min).
 * Tests use distinct subdomain values to avoid cross-test cache contamination.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import {
  CognitoIdentityProviderClient,
  GetTokensFromRefreshTokenCommand,
  RespondToAuthChallengeCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  createAuthVerifyHandler,
  type FunctionUrlEvent,
} from '../../../src/lambda/shared-distribution/triggers/auth-verify.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_PARENT = 'tenants.example.com';

let subdomainCounter = 400;
function nextSubdomain(): string {
  return `subdomain${subdomainCounter++}`;
}

function makeRefreshEvent(subdomain: string, refreshToken: string): FunctionUrlEvent {
  return {
    headers: {
      host: `${subdomain}.${TENANT_PARENT}`,
      cookie: `refresh-token=${refreshToken}`,
    },
    body: JSON.stringify({ refresh: true }),
  };
}

function makeMagicLinkEvent(subdomain: string, email: string, session: string, answer: string): FunctionUrlEvent {
  return {
    headers: {
      host: `${subdomain}.${TENANT_PARENT}`,
    },
    body: JSON.stringify({ session, challengeAnswer: answer, email }),
  };
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

describe('shared-distribution auth-verify handler', () => {
  const ddbMock = mockClient(DynamoDBClient);
  const cognitoMock = mockClient(CognitoIdentityProviderClient);

  beforeEach(() => {
    ddbMock.reset();
    cognitoMock.reset();
    process.env['VESTIBULUM_CLIENT_CONFIG_TABLE'] = 'ClientConfig';
  });

  afterEach(() => {
    delete process.env['VESTIBULUM_CLIENT_CONFIG_TABLE'];
  });

  // -- Direct .on.aws host → 400 --

  it('returns 400 when Host is a direct .on.aws invocation', async () => {
    const h = createAuthVerifyHandler({ tenantParent: TENANT_PARENT });
    const event: FunctionUrlEvent = {
      headers: { host: 'abc123.lambda-url.us-east-1.on.aws' },
      body: JSON.stringify({ refresh: true }),
    };
    const result = await h(event);
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when Host is absent', async () => {
    const h = createAuthVerifyHandler({ tenantParent: TENANT_PARENT });
    const event: FunctionUrlEvent = { headers: {}, body: JSON.stringify({ refresh: true }) };
    const result = await h(event);
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when Host is the parent domain without a subdomain', async () => {
    const h = createAuthVerifyHandler({ tenantParent: TENANT_PARENT });
    const event: FunctionUrlEvent = {
      headers: { host: TENANT_PARENT },
      body: JSON.stringify({ refresh: true }),
    };
    const result = await h(event);
    expect(result.statusCode).toBe(400);
  });

  // -- Unknown subdomain → 404 --

  it('returns 404 when no ClientConfig exists for the resolved subdomain', async () => {
    const subdomain = nextSubdomain();
    ddbMock.on(QueryCommand).resolves({ Items: [], Count: 0 });

    const h = createAuthVerifyHandler({ tenantParent: TENANT_PARENT });
    const event: FunctionUrlEvent = {
      headers: { host: `${subdomain}.${TENANT_PARENT}` },
      body: JSON.stringify({ refresh: true, cookie: 'old-refresh' }),
    };
    const result = await h(event);
    expect(result.statusCode).toBe(404);
  });

  // -- Refresh path --

  it('calls GetTokensFromRefreshToken with the correct ClientId', async () => {
    const subdomain = nextSubdomain();
    const clientId = `auth-verify-client-${subdomain}`;
    ddbMock.on(QueryCommand).resolves(clientConfigQueryResult(clientId, subdomain));
    cognitoMock.on(GetTokensFromRefreshTokenCommand).resolves({
      AuthenticationResult: {
        IdToken: 'new-id-token',
        RefreshToken: 'new-refresh-token',
        AccessToken: 'new-access-token',
        ExpiresIn: 3600,
        TokenType: 'Bearer',
      },
    });

    const h = createAuthVerifyHandler({ tenantParent: TENANT_PARENT });
    const result = await h(makeRefreshEvent(subdomain, 'old-refresh-token'));

    expect(result.statusCode).toBe(200);

    const cognitoCalls = cognitoMock.calls();
    expect(cognitoCalls.length).toBe(1);
    const call = cognitoCalls[0]?.args[0] as { input: { ClientId: string; RefreshToken: string } };
    expect(call.input.ClientId).toBe(clientId);
    expect(call.input.RefreshToken).toBe('old-refresh-token');
  });

  it('sets rotated tokens as cookies on successful refresh', async () => {
    const subdomain = nextSubdomain();
    const clientId = `auth-verify-client-${subdomain}`;
    ddbMock.on(QueryCommand).resolves(clientConfigQueryResult(clientId, subdomain));
    cognitoMock.on(GetTokensFromRefreshTokenCommand).resolves({
      AuthenticationResult: {
        IdToken: 'new-id-token',
        RefreshToken: 'new-refresh-token',
        AccessToken: 'new-access-token',
        ExpiresIn: 3600,
        TokenType: 'Bearer',
      },
    });

    const h = createAuthVerifyHandler({ tenantParent: TENANT_PARENT });
    const result = await h(makeRefreshEvent(subdomain, 'old-rt'));

    expect(result.statusCode).toBe(200);
    const setCookies = result.multiValueHeaders?.['Set-Cookie'] ?? [];
    expect(setCookies.length).toBeGreaterThanOrEqual(1);
    const idCookie = setCookies.find((c) => c.startsWith('id-token='));
    expect(idCookie).toBeDefined();
    expect(idCookie).toContain('new-id-token');
    const refreshCookie = setCookies.find((c) => c.startsWith('refresh-token='));
    expect(refreshCookie).toBeDefined();
    expect(refreshCookie).toContain('new-refresh-token');
  });

  it('uses exact-host cookie domain (subdomain.parent, no leading dot)', async () => {
    const subdomain = nextSubdomain();
    const clientId = `auth-verify-client-${subdomain}`;
    ddbMock.on(QueryCommand).resolves(clientConfigQueryResult(clientId, subdomain));
    cognitoMock.on(GetTokensFromRefreshTokenCommand).resolves({
      AuthenticationResult: {
        IdToken: 'new-id-token',
        RefreshToken: 'new-refresh-token',
        AccessToken: 'new-access-token',
        ExpiresIn: 3600,
        TokenType: 'Bearer',
      },
    });

    const h = createAuthVerifyHandler({ tenantParent: TENANT_PARENT });
    const result = await h(makeRefreshEvent(subdomain, 'old-rt'));

    const setCookies = result.multiValueHeaders?.['Set-Cookie'] ?? [];
    const idCookie = setCookies.find((c) => c.startsWith('id-token=')) ?? '';
    // Should contain "Domain=<subdomain>.tenants.example.com" (no leading dot)
    expect(idCookie).toContain(`Domain=${subdomain}.${TENANT_PARENT}`);
    expect(idCookie).not.toContain(`Domain=.${subdomain}`);
  });

  it('returns 401 when no refresh-token cookie present in refresh request', async () => {
    const subdomain = nextSubdomain();
    const clientId = `auth-verify-client-${subdomain}`;
    ddbMock.on(QueryCommand).resolves(clientConfigQueryResult(clientId, subdomain));

    const h = createAuthVerifyHandler({ tenantParent: TENANT_PARENT });
    const event: FunctionUrlEvent = {
      headers: { host: `${subdomain}.${TENANT_PARENT}` },
      body: JSON.stringify({ refresh: true }),
    };
    const result = await h(event);
    expect(result.statusCode).toBe(401);
  });

  // -- Magic-link path --

  it('calls RespondToAuthChallenge with the correct ClientId for magic-link', async () => {
    const subdomain = nextSubdomain();
    const clientId = `auth-verify-client-${subdomain}`;
    ddbMock.on(QueryCommand).resolves(clientConfigQueryResult(clientId, subdomain));
    cognitoMock.on(RespondToAuthChallengeCommand).resolves({
      AuthenticationResult: {
        IdToken: 'id-tok',
        RefreshToken: 'rt',
        AccessToken: 'at',
        ExpiresIn: 3600,
        TokenType: 'Bearer',
      },
    });

    const h = createAuthVerifyHandler({ tenantParent: TENANT_PARENT });
    const result = await h(makeMagicLinkEvent(subdomain, 'user@acme.com', 'session-123', 'token-answer'));

    expect(result.statusCode).toBe(200);

    const cognitoCalls = cognitoMock.calls();
    expect(cognitoCalls.length).toBe(1);
    const call = cognitoCalls[0]?.args[0] as { input: { ClientId: string } };
    expect(call.input.ClientId).toBe(clientId);
  });

  it('returns 401 when body is missing', async () => {
    const subdomain = nextSubdomain();
    const clientId = `auth-verify-client-${subdomain}`;
    ddbMock.on(QueryCommand).resolves(clientConfigQueryResult(clientId, subdomain));

    const h = createAuthVerifyHandler({ tenantParent: TENANT_PARENT });
    const event: FunctionUrlEvent = { headers: { host: `${subdomain}.${TENANT_PARENT}` } };
    const result = await h(event);
    expect(result.statusCode).toBe(401);
  });
});
