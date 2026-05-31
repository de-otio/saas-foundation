/**
 * Tests for wrapPreTokenHandler (review fix B1).
 *
 * Spec: doc/vestibulum/shared-distribution/06-trigger-handlers.md
 *       § Allowing consumer customisation — Required property tests.
 *
 * Required property tests:
 * 1. Wrapper sets custom:tenant_id from ClientConfig even when inner doesn't
 *    touch claims at all.
 * 2. Inner handler overwriting custom:tenant_id → wrapper throws.
 * 3. Inner handler adding custom:tenant_id to claimsToSuppress → throws (B1).
 * 4. Inner handler throwing → wrapper propagates (does not swallow).
 * 5. Inner handler returning event with no claimsToAddOrOverride →
 *    wrapper's pre-injection survives.
 *
 * Coverage target: 100 % branch.
 */

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wrapPreTokenHandler } from '../../../src/lambda/shared-distribution/shared/wrap-pre-token-handler.js';
import type { PreTokenEventLike, PreTokenResponse, PreTokenContext } from '../../../src/lambda/shared-distribution/shared/wrap-pre-token-handler.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const ddbMock = mockClient(DynamoDBClient);

let seq = 0;
const nextClientId = () => `wrapper-client-${++seq}`;

beforeEach(() => {
  ddbMock.reset();
  process.env['VESTIBULUM_CLIENT_CONFIG_TABLE'] = 'ClientConfig';
});

afterEach(() => {
  delete process.env['VESTIBULUM_CLIENT_CONFIG_TABLE'];
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal DDB item for a tenant config.
 * Uses a two-character subdomain suffix to satisfy the TenantSubdomain pattern
 * (`/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/` — minimum 3 chars).
 */
function makeConfigItem(clientId: string, tenantId: string) {
  return {
    clientId: { S: clientId },
    tenantId: { S: tenantId },
    subdomain: { S: `at${seq}` },
    siteBaseUrl: { S: `https://at${seq}.tenants.example.com` },
    allowedEmailDomains: { SS: ['test.com'] },
    createdAt: { S: '2024-01-01T00:00:00.000Z' },
  };
}

/** Build a minimal PreTokenGenerationTriggerEvent-like object. */
function makeEvent(clientId: string, overrides: Partial<PreTokenResponse> = {}): PreTokenEventLike {
  return {
    callerContext: { clientId },
    response: { ...overrides },
  };
}

// ---------------------------------------------------------------------------
// Required property tests
// ---------------------------------------------------------------------------

describe('wrapPreTokenHandler — required property tests', () => {
  it('1. sets custom:tenant_id even when inner does not touch claims', async () => {
    const clientId = nextClientId();
    const tenantId = `t-${seq}`;
    ddbMock.on(GetItemCommand).resolves({ Item: makeConfigItem(clientId, tenantId) });

    const handler = wrapPreTokenHandler(async (event, _ctx) => event);
    const event = makeEvent(clientId);
    const result = await handler(event);

    expect(
      result.response?.claimsOverrideDetails?.claimsToAddOrOverride?.['custom:tenant_id'],
    ).toBe(tenantId);
  });

  it('2. inner overwriting custom:tenant_id → wrapper throws', async () => {
    const clientId = nextClientId();
    const tenantId = `t-${seq}`;
    ddbMock.on(GetItemCommand).resolves({ Item: makeConfigItem(clientId, tenantId) });

    const handler = wrapPreTokenHandler(async (event, _ctx) => {
      // Overwrite the pre-set value.
      event.response.claimsOverrideDetails!.claimsToAddOrOverride!['custom:tenant_id'] =
        'attacker-value';
      return event;
    });

    const event = makeEvent(clientId);
    await expect(handler(event)).rejects.toThrow(
      /wrapPreTokenHandler: handler must not overwrite custom:tenant_id/,
    );
  });

  it('3. inner adding custom:tenant_id to claimsToSuppress → throws (review fix B1)', async () => {
    const clientId = nextClientId();
    const tenantId = `t-${seq}`;
    ddbMock.on(GetItemCommand).resolves({ Item: makeConfigItem(clientId, tenantId) });

    const handler = wrapPreTokenHandler(async (event, _ctx) => {
      // Add the claim to suppressions — Cognito would strip it after overrides.
      event.response.claimsOverrideDetails!.claimsToSuppress = ['custom:tenant_id'];
      return event;
    });

    const event = makeEvent(clientId);
    await expect(handler(event)).rejects.toThrow(
      /wrapPreTokenHandler: handler must not suppress custom:tenant_id/,
    );
  });

  it('4. inner throwing → wrapper propagates the error', async () => {
    const clientId = nextClientId();
    const tenantId = `t-${seq}`;
    ddbMock.on(GetItemCommand).resolves({ Item: makeConfigItem(clientId, tenantId) });

    const originalError = new Error('inner handler failed');
    const handler = wrapPreTokenHandler(async (_event, _ctx) => {
      throw originalError;
    });

    const event = makeEvent(clientId);
    await expect(handler(event)).rejects.toBe(originalError);
  });

  it('5. inner returning event with no claimsToAddOrOverride → pre-injection survives', async () => {
    const clientId = nextClientId();
    const tenantId = `t-${seq}`;
    ddbMock.on(GetItemCommand).resolves({ Item: makeConfigItem(clientId, tenantId) });

    const handler = wrapPreTokenHandler(async (event, _ctx) => {
      // Inner touches claimsToSuppress but not claimsToAddOrOverride.
      event.response.claimsOverrideDetails!.claimsToSuppress = ['some-other-claim'];
      return event;
    });

    const event = makeEvent(clientId);
    const result = await handler(event);

    // The pre-injection must still be present.
    expect(
      result.response?.claimsOverrideDetails?.claimsToAddOrOverride?.['custom:tenant_id'],
    ).toBe(tenantId);
  });
});

// ---------------------------------------------------------------------------
// Additional coverage tests
// ---------------------------------------------------------------------------

describe('wrapPreTokenHandler — additional coverage', () => {
  it('throws when no ClientConfig row exists for clientId', async () => {
    const clientId = nextClientId();
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });

    const handler = wrapPreTokenHandler(async (event) => event);
    const event = makeEvent(clientId);

    await expect(handler(event)).rejects.toThrow('Tenant configuration missing');
  });

  it('propagates DDB error (fail-closed)', async () => {
    const clientId = nextClientId();
    ddbMock.on(GetItemCommand).rejects(new Error('DDB unavailable'));

    const handler = wrapPreTokenHandler(async (event) => event);
    const event = makeEvent(clientId);

    await expect(handler(event)).rejects.toThrow('DDB unavailable');
  });

  it('ctx.tenantConfig contains the loaded row', async () => {
    const clientId = nextClientId();
    const tenantId = `t-${seq}`;
    ddbMock.on(GetItemCommand).resolves({ Item: makeConfigItem(clientId, tenantId) });

    let capturedCtx: PreTokenContext | undefined;
    const handler = wrapPreTokenHandler(async (event, ctx) => {
      capturedCtx = ctx;
      return event;
    });

    const event = makeEvent(clientId);
    await handler(event);

    expect(capturedCtx?.tenantConfig.clientId).toBe(clientId);
    expect(capturedCtx?.tenantConfig.tenantId).toBe(tenantId);
  });

  it('preserves existing claims set by inner handler', async () => {
    const clientId = nextClientId();
    const tenantId = `t-${seq}`;
    ddbMock.on(GetItemCommand).resolves({ Item: makeConfigItem(clientId, tenantId) });

    const handler = wrapPreTokenHandler(async (event, _ctx) => {
      event.response.claimsOverrideDetails!.claimsToAddOrOverride!['custom:role'] = 'admin';
      return event;
    });

    const event = makeEvent(clientId);
    const result = await handler(event);

    // Both the pre-injected claim and the inner's claim must be present.
    expect(
      result.response?.claimsOverrideDetails?.claimsToAddOrOverride?.['custom:tenant_id'],
    ).toBe(tenantId);
    expect(
      result.response?.claimsOverrideDetails?.claimsToAddOrOverride?.['custom:role'],
    ).toBe('admin');
  });

  it('initialises claimsOverrideDetails when event.response is empty', async () => {
    const clientId = nextClientId();
    const tenantId = `t-${seq}`;
    ddbMock.on(GetItemCommand).resolves({ Item: makeConfigItem(clientId, tenantId) });

    const handler = wrapPreTokenHandler(async (event) => event);
    // Event with completely empty response.
    const event: PreTokenEventLike = { callerContext: { clientId }, response: {} };
    const result = await handler(event);

    expect(
      result.response?.claimsOverrideDetails?.claimsToAddOrOverride?.['custom:tenant_id'],
    ).toBe(tenantId);
  });

  it('handles event with missing/null response (defensive path)', async () => {
    const clientId = nextClientId();
    const tenantId = `t-${seq}`;
    ddbMock.on(GetItemCommand).resolves({ Item: makeConfigItem(clientId, tenantId) });

    const handler = wrapPreTokenHandler(async (event) => event);
    // Cast to bypass TS to exercise the defensive `!event.response` branch.
    const event = { callerContext: { clientId }, response: null } as unknown as PreTokenEventLike;
    const result = await handler(event);

    expect(
      result.response?.claimsOverrideDetails?.claimsToAddOrOverride?.['custom:tenant_id'],
    ).toBe(tenantId);
  });

  it('claimsToSuppress not including custom:tenant_id → does not throw', async () => {
    const clientId = nextClientId();
    const tenantId = `t-${seq}`;
    ddbMock.on(GetItemCommand).resolves({ Item: makeConfigItem(clientId, tenantId) });

    const handler = wrapPreTokenHandler(async (event, _ctx) => {
      event.response.claimsOverrideDetails!.claimsToSuppress = ['email', 'phone_number'];
      return event;
    });

    const event = makeEvent(clientId);
    const result = await handler(event);

    expect(
      result.response?.claimsOverrideDetails?.claimsToAddOrOverride?.['custom:tenant_id'],
    ).toBe(tenantId);
  });

  it('inner deleting custom:tenant_id from claimsToAddOrOverride → throws', async () => {
    const clientId = nextClientId();
    const tenantId = `t-${seq}`;
    ddbMock.on(GetItemCommand).resolves({ Item: makeConfigItem(clientId, tenantId) });

    const handler = wrapPreTokenHandler(async (event, _ctx) => {
      delete event.response.claimsOverrideDetails!.claimsToAddOrOverride!['custom:tenant_id'];
      return event;
    });

    const event = makeEvent(clientId);
    await expect(handler(event)).rejects.toThrow(
      /wrapPreTokenHandler: handler must not overwrite custom:tenant_id/,
    );
  });
});
