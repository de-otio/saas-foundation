/**
 * Tests for the deleteTenant action.
 *
 * Required cases:
 * - With revokeActiveSessions: true → ListUsers + AdminUserGlobalSignOut per user.
 * - Without flag → delete client + row only.
 * - TenantDeleted metric emitted.
 * - TenantNotFoundError when row absent.
 */

import {
  DynamoDBClient,
  QueryCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb';
import {
  CognitoIdentityProviderClient,
  DeleteUserPoolClientCommand,
  ListUsersCommand,
  AdminUserGlobalSignOutCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteTenant, TenantNotFoundError } from '../../../../src/lambda/shared-distribution/admin/actions/delete-tenant.js';
import type { DeleteTenantDeps } from '../../../../src/lambda/shared-distribution/admin/actions/delete-tenant.js';
import type { CallerIdentity } from '../../../../src/lambda/shared-distribution/admin/audit-log.js';
import { tenantId } from '@de-otio/saas-foundation/types/frozen';

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

function makeDeps(): DeleteTenantDeps {
  return {
    ddb: new DynamoDBClient({}),
    cognito: new CognitoIdentityProviderClient({}),
    userPoolId: 'us-east-1_test',
    clientConfigTable: 'ClientConfig',
  };
}

const EXISTING_ITEM = {
  clientId: { S: 'client-del-001' },
  subdomain: { S: 'acme' },
  tenantId: { S: 'acme' },
  siteBaseUrl: { S: 'https://acme.tenants.example.com' },
  allowedEmailDomains: { SS: ['acme.example'] },
  createdAt: { S: '2026-01-01T00:00:00.000Z' },
};

beforeEach(() => {
  ddbMock.reset();
  cognitoMock.reset();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Without revokeActiveSessions
// ---------------------------------------------------------------------------

describe('deleteTenant — without revokeActiveSessions', () => {
  it('deletes Cognito client and DDB row without touching users', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [EXISTING_ITEM] });
    ddbMock.on(DeleteItemCommand).resolves({});
    cognitoMock.on(DeleteUserPoolClientCommand).resolves({});

    await deleteTenant(
      { action: 'deleteTenant', tenantId: tenantId('acme') },
      makeDeps(),
      CALLER,
      'req-d-001',
    );

    // Cognito client deleted
    const deleteCognitoCalls = cognitoMock.commandCalls(DeleteUserPoolClientCommand);
    expect(deleteCognitoCalls).toHaveLength(1);
    expect(deleteCognitoCalls[0]!.args[0].input.ClientId).toBe('client-del-001');

    // DDB row deleted
    const deleteDdbCalls = ddbMock.commandCalls(DeleteItemCommand);
    expect(deleteDdbCalls).toHaveLength(1);

    // ListUsers NOT called
    expect(cognitoMock.commandCalls(ListUsersCommand)).toHaveLength(0);
    // AdminUserGlobalSignOut NOT called
    expect(cognitoMock.commandCalls(AdminUserGlobalSignOutCommand)).toHaveLength(0);
  });

  it('emits TenantDeleted metric', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [EXISTING_ITEM] });
    ddbMock.on(DeleteItemCommand).resolves({});
    cognitoMock.on(DeleteUserPoolClientCommand).resolves({});
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await deleteTenant(
      { action: 'deleteTenant', tenantId: tenantId('acme') },
      makeDeps(),
      CALLER,
      'req-d-002',
    );

    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(written).toContain('TenantDeleted');
  });

  it('TenantDeleted metric has revokedSessions: false', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [EXISTING_ITEM] });
    ddbMock.on(DeleteItemCommand).resolves({});
    cognitoMock.on(DeleteUserPoolClientCommand).resolves({});
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await deleteTenant(
      { action: 'deleteTenant', tenantId: tenantId('acme'), revokeActiveSessions: false },
      makeDeps(),
      CALLER,
      'req-d-003',
    );

    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(written).toContain('"revokedSessions":"false"');
  });
});

// ---------------------------------------------------------------------------
// With revokeActiveSessions: true
// ---------------------------------------------------------------------------

describe('deleteTenant — with revokeActiveSessions: true', () => {
  it('calls ListUsers and AdminUserGlobalSignOut for each user', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [EXISTING_ITEM] });
    ddbMock.on(DeleteItemCommand).resolves({});
    cognitoMock.on(DeleteUserPoolClientCommand).resolves({});

    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        { Username: 'user1@example.com' },
        { Username: 'user2@example.com' },
      ],
      PaginationToken: undefined,
    });
    cognitoMock.on(AdminUserGlobalSignOutCommand).resolves({});

    await deleteTenant(
      { action: 'deleteTenant', tenantId: tenantId('acme'), revokeActiveSessions: true },
      makeDeps(),
      CALLER,
      'req-d-004',
    );

    // ListUsers called once (no pagination)
    expect(cognitoMock.commandCalls(ListUsersCommand)).toHaveLength(1);

    // AdminUserGlobalSignOut called for each user
    const signOutCalls = cognitoMock.commandCalls(AdminUserGlobalSignOutCommand);
    expect(signOutCalls).toHaveLength(2);
    const usernames = signOutCalls.map((c) => c.args[0].input.Username);
    expect(usernames).toContain('user1@example.com');
    expect(usernames).toContain('user2@example.com');
  });

  it('handles paginated ListUsers results', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [EXISTING_ITEM] });
    ddbMock.on(DeleteItemCommand).resolves({});
    cognitoMock.on(DeleteUserPoolClientCommand).resolves({});

    let listCallCount = 0;
    cognitoMock.on(ListUsersCommand).callsFake(async () => {
      listCallCount++;
      if (listCallCount === 1) {
        return {
          Users: [{ Username: 'user-page1' }],
          PaginationToken: 'token-page2',
        };
      }
      return {
        Users: [{ Username: 'user-page2' }],
        PaginationToken: undefined,
      };
    });
    cognitoMock.on(AdminUserGlobalSignOutCommand).resolves({});

    await deleteTenant(
      { action: 'deleteTenant', tenantId: tenantId('acme'), revokeActiveSessions: true },
      makeDeps(),
      CALLER,
      'req-d-005',
    );

    expect(cognitoMock.commandCalls(ListUsersCommand)).toHaveLength(2);
    expect(cognitoMock.commandCalls(AdminUserGlobalSignOutCommand)).toHaveLength(2);
  });

  it('TenantDeleted metric has revokedSessions: true', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [EXISTING_ITEM] });
    ddbMock.on(DeleteItemCommand).resolves({});
    cognitoMock.on(DeleteUserPoolClientCommand).resolves({});
    cognitoMock.on(ListUsersCommand).resolves({ Users: [] });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await deleteTenant(
      { action: 'deleteTenant', tenantId: tenantId('acme'), revokeActiveSessions: true },
      makeDeps(),
      CALLER,
      'req-d-006',
    );

    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(written).toContain('"revokedSessions":"true"');
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('deleteTenant — errors', () => {
  it('throws TenantNotFoundError when tenant does not exist', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await expect(
      deleteTenant(
        { action: 'deleteTenant', tenantId: tenantId('ghost') },
        makeDeps(),
        CALLER,
        'req-d-007',
      ),
    ).rejects.toBeInstanceOf(TenantNotFoundError);
  });
});
