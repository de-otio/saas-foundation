/**
 * Tests for the reconciler Lambda logic.
 *
 * Required cases:
 * - 3 Cognito clients, 2 config rows → OrphanedAppClients = 1.
 * - 2 Cognito clients, 3 config rows → OrphanedConfigRows = 1.
 * - No orphans → both metrics at 0.
 * - Metrics emitted via stdout (EMF format).
 */

import {
  DynamoDBClient,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import {
  CognitoIdentityProviderClient,
  ListUserPoolClientsCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runReconciler,
} from '../../../src/lambda/shared-distribution/admin/reconciler.js';
import type { ReconcilerDeps } from '../../../src/lambda/shared-distribution/admin/reconciler.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const ddbMock = mockClient(DynamoDBClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

function makeDeps(): ReconcilerDeps {
  return {
    ddb: new DynamoDBClient({}),
    cognito: new CognitoIdentityProviderClient({}),
    userPoolId: 'us-east-1_test',
    clientConfigTable: 'ClientConfig',
  };
}

function makeClientItem(clientId: string, subdomain: string) {
  return {
    clientId: { S: clientId },
    subdomain: { S: subdomain },
    createdAt: { S: '2026-01-01T00:00:00.000Z' },
  };
}

beforeEach(() => {
  ddbMock.reset();
  cognitoMock.reset();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Orphan detection tests
// ---------------------------------------------------------------------------

describe('runReconciler — orphan detection', () => {
  it('detects orphaned app clients (3 clients, 2 rows → 1 orphan)', async () => {
    // 3 Cognito clients
    cognitoMock.on(ListUserPoolClientsCommand).resolves({
      UserPoolClients: [
        { ClientId: 'client-a' },
        { ClientId: 'client-b' },
        { ClientId: 'client-c' }, // orphan — no config row
      ],
    });

    // 2 config rows
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeClientItem('client-a', 'tenant-a'),
        makeClientItem('client-b', 'tenant-b'),
      ],
    });

    const result = await runReconciler(makeDeps());
    expect(result.orphanedAppClients).toHaveLength(1);
    expect(result.orphanedAppClients[0]).toBe('client-c');
    expect(result.orphanedConfigRows).toHaveLength(0);
  });

  it('detects orphaned config rows (2 clients, 3 rows → 1 orphan)', async () => {
    // 2 Cognito clients
    cognitoMock.on(ListUserPoolClientsCommand).resolves({
      UserPoolClients: [
        { ClientId: 'client-a' },
        { ClientId: 'client-b' },
      ],
    });

    // 3 config rows — client-c is an orphan row
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeClientItem('client-a', 'tenant-a'),
        makeClientItem('client-b', 'tenant-b'),
        makeClientItem('client-c', 'tenant-c'), // orphan row
      ],
    });

    const result = await runReconciler(makeDeps());
    expect(result.orphanedConfigRows).toHaveLength(1);
    expect(result.orphanedConfigRows[0]).toBe('client-c');
    expect(result.orphanedAppClients).toHaveLength(0);
  });

  it('reports zero orphans when sets match', async () => {
    cognitoMock.on(ListUserPoolClientsCommand).resolves({
      UserPoolClients: [
        { ClientId: 'client-a' },
        { ClientId: 'client-b' },
      ],
    });
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeClientItem('client-a', 'tenant-a'),
        makeClientItem('client-b', 'tenant-b'),
      ],
    });

    const result = await runReconciler(makeDeps());
    expect(result.orphanedAppClients).toHaveLength(0);
    expect(result.orphanedConfigRows).toHaveLength(0);
  });

  it('handles empty pool and empty config', async () => {
    cognitoMock.on(ListUserPoolClientsCommand).resolves({ UserPoolClients: [] });
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const result = await runReconciler(makeDeps());
    expect(result.orphanedAppClients).toHaveLength(0);
    expect(result.orphanedConfigRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Metric emission tests
// ---------------------------------------------------------------------------

describe('runReconciler — metric emission', () => {
  it('emits OrphanedAppClients metric via EMF stdout', async () => {
    cognitoMock.on(ListUserPoolClientsCommand).resolves({
      UserPoolClients: [{ ClientId: 'orphan-client' }],
    });
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runReconciler(makeDeps());

    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(written).toContain('OrphanedAppClients');
  });

  it('emits OrphanedConfigRows metric via EMF stdout', async () => {
    cognitoMock.on(ListUserPoolClientsCommand).resolves({ UserPoolClients: [] });
    ddbMock.on(ScanCommand).resolves({
      Items: [makeClientItem('orphan-row', 'tenant-x')],
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runReconciler(makeDeps());

    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(written).toContain('OrphanedConfigRows');
  });
});

// ---------------------------------------------------------------------------
// Pagination tests
// ---------------------------------------------------------------------------

describe('runReconciler — pagination', () => {
  it('paginates ListUserPoolClients', async () => {
    let callCount = 0;
    cognitoMock.on(ListUserPoolClientsCommand).callsFake(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          UserPoolClients: [{ ClientId: 'client-page1' }],
          NextToken: 'next-token',
        };
      }
      return {
        UserPoolClients: [{ ClientId: 'client-page2' }],
      };
    });

    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeClientItem('client-page1', 'tenant-1'),
        makeClientItem('client-page2', 'tenant-2'),
      ],
    });

    const result = await runReconciler(makeDeps());
    expect(cognitoMock.commandCalls(ListUserPoolClientsCommand)).toHaveLength(2);
    expect(result.orphanedAppClients).toHaveLength(0);
  });

  it('paginates DDB scan', async () => {
    cognitoMock.on(ListUserPoolClientsCommand).resolves({
      UserPoolClients: [
        { ClientId: 'client-a' },
        { ClientId: 'client-b' },
      ],
    });

    let scanCallCount = 0;
    ddbMock.on(ScanCommand).callsFake(async () => {
      scanCallCount++;
      if (scanCallCount === 1) {
        return {
          Items: [makeClientItem('client-a', 'tenant-a')],
          LastEvaluatedKey: { clientId: { S: 'client-a' } },
        };
      }
      return {
        Items: [makeClientItem('client-b', 'tenant-b')],
      };
    });

    const result = await runReconciler(makeDeps());
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
    expect(result.orphanedAppClients).toHaveLength(0);
    expect(result.orphanedConfigRows).toHaveLength(0);
  });
});
