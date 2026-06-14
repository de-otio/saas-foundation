/**
 * Tests for the createTenant action.
 *
 * Uses aws-sdk-client-mock to intercept DynamoDB and Cognito calls.
 *
 * Required test cases per P2c spec:
 * - Idempotency hit: returns stored response.
 * - Idempotency hit with mismatched subdomain/tenantId → 409.
 * - Reservation TransactWriteItems with OR-expired condition (B3 fix).
 * - TransactionCanceledException → 409 (concurrent create scenario).
 * - Cognito create succeeds, DDB put fails → compensation deletes the client.
 * - Compensation emits CompensationTriggered metric.
 * - Refresh-token rotation enabled; ALLOW_REFRESH_TOKEN_AUTH NOT present.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  TransactWriteItemsCommand,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  CognitoIdentityProviderClient,
  CreateUserPoolClientCommand,
  DeleteUserPoolClientCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTenant,
  ConflictError,
  IdempotencyConflictError,
} from '../../../../src/lambda/shared-distribution/admin/actions/create-tenant.js';
import type { CreateTenantDeps } from '../../../../src/lambda/shared-distribution/admin/actions/create-tenant.js';
import type { CallerIdentity } from '../../../../src/lambda/shared-distribution/admin/audit-log.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const ddbMock = mockClient(DynamoDBClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

const CALLER: CallerIdentity = {
  callerArn: 'arn:aws:iam::123456789012:role/Admin',
  callerAccount: '123456789012',
  callerId: 'AIDA123456789',
};

function makeDeps(): CreateTenantDeps {
  return {
    ddb: new DynamoDBClient({}),
    cognito: new CognitoIdentityProviderClient({}),
    userPoolId: 'us-east-1_test',
    clientConfigTable: 'ClientConfig',
    idempotencyTable: 'Idempotency',
    reservationsTable: 'Reservations',
    tenantParent: 'tenants.example.com',
  };
}

const BASE_REQ = {
  action: 'createTenant' as const,
  subdomain: 'acme',
  tenantId: 'acme',
  allowedEmailDomains: ['acme.example'],
  idempotencyKey: 'test-key-01234567',
};

beforeEach(() => {
  ddbMock.reset();
  cognitoMock.reset();
  // Suppress stdout for metric/audit log output
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Idempotency tests
// ---------------------------------------------------------------------------

describe('createTenant — idempotency', () => {
  it('returns stored response on idempotency hit', async () => {
    const storedResponse = {
      tenantId: 'acme',
      subdomain: 'acme',
      siteBaseUrl: 'https://acme.tenants.example.com',
      clientId: 'stored-client-id',
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    ddbMock.on(GetItemCommand).resolves({
      Item: {
        idempotencyKey: { S: 'test-key-01234567#acme' },
        response: { S: JSON.stringify(storedResponse) },
        expiresAt: { N: String(9_999_999_999) }, // far-future unix timestamp
      },
    });

    const result = await createTenant(BASE_REQ, makeDeps(), CALLER, 'req-001');
    expect(result).toEqual(storedResponse);
    // Should NOT have called Cognito or TransactWriteItems
    expect(cognitoMock.calls()).toHaveLength(0);
  });

  it('returns 409 when idempotency key reused for different tenant identity', async () => {
    const storedResponse = {
      tenantId: 'other-tenant',
      subdomain: 'other',
      siteBaseUrl: 'https://other.tenants.example.com',
      clientId: 'other-client-id',
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    ddbMock.on(GetItemCommand).resolves({
      Item: {
        idempotencyKey: { S: 'test-key-01234567#acme' },
        response: { S: JSON.stringify(storedResponse) },
      },
    });

    await expect(
      createTenant(BASE_REQ, makeDeps(), CALLER, 'req-002'),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

// ---------------------------------------------------------------------------
// Reservation tests (B3 fix)
// ---------------------------------------------------------------------------

describe('createTenant — reservation', () => {
  beforeEach(() => {
    // No idempotency hit
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
  });

  it('calls TransactWriteItems with OR-expired condition on both keys', async () => {
    // Set up happy-path mocks
    ddbMock.on(TransactWriteItemsCommand).resolves({});
    cognitoMock.on(CreateUserPoolClientCommand).resolves({
      UserPoolClient: { ClientId: 'new-client-id' },
    });
    ddbMock.on(PutItemCommand).resolves({});
    ddbMock.on(DeleteItemCommand).resolves({});

    await createTenant(BASE_REQ, makeDeps(), CALLER, 'req-003');

    const txCalls = ddbMock.commandCalls(TransactWriteItemsCommand);
    expect(txCalls).toHaveLength(1);

    const txInput = txCalls[0]!.args[0].input;
    const items = txInput.TransactItems ?? [];
    expect(items).toHaveLength(2);

    // Both items must have the OR-expired condition
    for (const item of items) {
      expect(item.Put?.ConditionExpression).toBe(
        'attribute_not_exists(#k) OR #exp < :now',
      );
    }

    // Keys must be correct
    const subdomainItem = items.find(
      (i) => i.Put?.Item?.['key']?.S?.startsWith('subdomain#') === true,
    );
    const tenantIdItem = items.find(
      (i) => i.Put?.Item?.['key']?.S?.startsWith('tenantId#') === true,
    );
    expect(subdomainItem?.Put?.Item?.['key']?.S).toBe('subdomain#acme');
    expect(tenantIdItem?.Put?.Item?.['key']?.S).toBe('tenantId#acme');
  });

  it('returns 409 when TransactionCanceledException (concurrent create)', async () => {
    ddbMock.on(TransactWriteItemsCommand).rejects(
      new TransactionCanceledException({
        message: 'Transaction cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      }),
    );

    await expect(
      createTenant(BASE_REQ, makeDeps(), CALLER, 'req-004'),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

// ---------------------------------------------------------------------------
// Cognito client creation
// ---------------------------------------------------------------------------

describe('createTenant — Cognito client', () => {
  beforeEach(() => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    ddbMock.on(TransactWriteItemsCommand).resolves({});
    ddbMock.on(PutItemCommand).resolves({});
    ddbMock.on(DeleteItemCommand).resolves({});
  });

  it('creates client with refresh-token rotation enabled', async () => {
    cognitoMock.on(CreateUserPoolClientCommand).resolves({
      UserPoolClient: { ClientId: 'client-rt-rotation' },
    });

    await createTenant(BASE_REQ, makeDeps(), CALLER, 'req-005');

    const createCalls = cognitoMock.commandCalls(CreateUserPoolClientCommand);
    expect(createCalls).toHaveLength(1);
    const input = createCalls[0]!.args[0].input;

    expect(input.RefreshTokenRotation?.Feature).toBe('ENABLED');
    expect(input.RefreshTokenRotation?.RetryGracePeriodSeconds).toBe(60);
  });

  it('does NOT include ALLOW_REFRESH_TOKEN_AUTH in ExplicitAuthFlows', async () => {
    cognitoMock.on(CreateUserPoolClientCommand).resolves({
      UserPoolClient: { ClientId: 'client-no-rta' },
    });

    await createTenant(BASE_REQ, makeDeps(), CALLER, 'req-006');

    const createCalls = cognitoMock.commandCalls(CreateUserPoolClientCommand);
    const flows = createCalls[0]!.args[0].input.ExplicitAuthFlows ?? [];
    expect(flows).not.toContain('ALLOW_REFRESH_TOKEN_AUTH');
    expect(flows).toContain('ALLOW_CUSTOM_AUTH');
  });

  it('includes CallbackURLs and LogoutURLs derived from tenantParent', async () => {
    cognitoMock.on(CreateUserPoolClientCommand).resolves({
      UserPoolClient: { ClientId: 'client-urls' },
    });

    await createTenant(BASE_REQ, makeDeps(), CALLER, 'req-007');

    const input = cognitoMock.commandCalls(CreateUserPoolClientCommand)[0]!.args[0].input;
    expect(input.CallbackURLs).toContain('https://acme.tenants.example.com/login/callback');
    expect(input.LogoutURLs).toContain('https://acme.tenants.example.com/logout');
  });
});

// ---------------------------------------------------------------------------
// Compensation: Cognito succeeds, DDB write fails → delete Cognito client
// ---------------------------------------------------------------------------

describe('createTenant — compensation (Cognito create success, DDB fail)', () => {
  it('deletes Cognito client when ClientConfig PutItem fails', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    ddbMock.on(TransactWriteItemsCommand).resolves({});

    // PutItemCommand: fail on first call (ClientConfig write), succeed on idempotency
    let putCallCount = 0;
    ddbMock.on(PutItemCommand).callsFake(async () => {
      putCallCount++;
      if (putCallCount === 1) throw new Error('DDB write failed');
      return {};
    });
    ddbMock.on(DeleteItemCommand).resolves({});

    cognitoMock.on(CreateUserPoolClientCommand).resolves({
      UserPoolClient: { ClientId: 'client-to-compensate' },
    });
    cognitoMock.on(DeleteUserPoolClientCommand).resolves({});

    await expect(
      createTenant(BASE_REQ, makeDeps(), CALLER, 'req-008'),
    ).rejects.toThrow('DDB write failed');

    // Compensation: DeleteUserPoolClient must have been called
    const deleteCalls = cognitoMock.commandCalls(DeleteUserPoolClientCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]!.args[0].input.ClientId).toBe('client-to-compensate');
  });

  it('emits CompensationTriggered metric when compensation runs', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    ddbMock.on(TransactWriteItemsCommand).resolves({});
    ddbMock.on(PutItemCommand).rejects(new Error('DDB write failed'));
    ddbMock.on(DeleteItemCommand).resolves({});
    cognitoMock.on(CreateUserPoolClientCommand).resolves({
      UserPoolClient: { ClientId: 'client-comp-metric' },
    });
    cognitoMock.on(DeleteUserPoolClientCommand).resolves({});

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(
      createTenant(BASE_REQ, makeDeps(), CALLER, 'req-009'),
    ).rejects.toThrow();

    // At least one stdout write should contain CompensationTriggered
    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(written).toContain('CompensationTriggered');
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('createTenant — happy path', () => {
  it('returns correct response shape', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    ddbMock.on(TransactWriteItemsCommand).resolves({});
    cognitoMock.on(CreateUserPoolClientCommand).resolves({
      UserPoolClient: { ClientId: 'happy-client-id' },
    });
    ddbMock.on(PutItemCommand).resolves({});
    ddbMock.on(DeleteItemCommand).resolves({});

    const result = await createTenant(BASE_REQ, makeDeps(), CALLER, 'req-010');

    expect(result.tenantId).toBe('acme');
    expect(result.subdomain).toBe('acme');
    expect(result.siteBaseUrl).toBe('https://acme.tenants.example.com');
    expect(result.clientId).toBe('happy-client-id');
    expect(result.createdAt).toBeTruthy();
  });

  it('emits TenantCreated metric on success', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    ddbMock.on(TransactWriteItemsCommand).resolves({});
    cognitoMock.on(CreateUserPoolClientCommand).resolves({
      UserPoolClient: { ClientId: 'metric-client-id' },
    });
    ddbMock.on(PutItemCommand).resolves({});
    ddbMock.on(DeleteItemCommand).resolves({});

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await createTenant(BASE_REQ, makeDeps(), CALLER, 'req-011');

    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(written).toContain('TenantCreated');
  });
});
