/**
 * Reconciler Lambda — hourly orphan detection.
 *
 * Scheduled via EventBridge `rate(1 hour)`. Lists all Cognito app clients
 * on the pool, scans ClientConfig, and computes the orphan delta in both
 * directions. Does NOT auto-delete; emits CloudWatch metrics and logs
 * orphan details for operator inspection.
 *
 * Emits:
 *   - `Vestibulum/SharedDistribution/OrphanedAppClients` (clients without rows)
 *   - `Vestibulum/SharedDistribution/OrphanedConfigRows` (rows without clients)
 *
 * See doc/vestibulum/shared-distribution/03-tenant-onboarding.md § Reconciler Lambda.
 */

import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import {
  CognitoIdentityProviderClient,
  ListUserPoolClientsCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { emitMetric } from './metrics.js';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const USER_POOL_ID = process.env['VESTIBULUM_USER_POOL_ID'] ?? '';
const CLIENT_CONFIG_TABLE = process.env['VESTIBULUM_CLIENT_CONFIG_TABLE'] ?? '';

// ---------------------------------------------------------------------------
// Module-level singletons
// ---------------------------------------------------------------------------

const ddb = new DynamoDBClient({});
const cognito = new CognitoIdentityProviderClient({});

// ---------------------------------------------------------------------------
// Injectable deps interface (for testing)
// ---------------------------------------------------------------------------

export interface ReconcilerDeps {
  readonly ddb: DynamoDBClient;
  readonly cognito: CognitoIdentityProviderClient;
  readonly userPoolId: string;
  readonly clientConfigTable: string;
}

// ---------------------------------------------------------------------------
// Core reconciler logic (separated from handler for testability)
// ---------------------------------------------------------------------------

export interface ReconcilerResult {
  readonly orphanedAppClients: readonly string[];   // clientIds with no config row
  readonly orphanedConfigRows: readonly string[];    // clientIds in config but not in pool
}

export async function runReconciler(deps: ReconcilerDeps): Promise<ReconcilerResult> {
  const { ddb: ddbClient, cognito: cognitoClient, userPoolId, clientConfigTable } = deps;

  // -------------------------------------------------------------------------
  // Step 1: List all Cognito app clients (paginated)
  // -------------------------------------------------------------------------
  const cognitoClientIds = new Set<string>();
  let nextToken: string | undefined;

  do {
    const listResp = await cognitoClient.send(
      new ListUserPoolClientsCommand({
        UserPoolId: userPoolId,
        MaxResults: 60,
        NextToken: nextToken,
      }),
    );

    for (const client of listResp.UserPoolClients ?? []) {
      if (client.ClientId != null && client.ClientId !== '') {
        cognitoClientIds.add(client.ClientId);
      }
    }

    nextToken = listResp.NextToken;
  } while (nextToken != null && nextToken !== '');

  // -------------------------------------------------------------------------
  // Step 2: Scan ClientConfig (paginated)
  // -------------------------------------------------------------------------
  const configClientIds = new Set<string>();
  const configClientDetails = new Map<string, { subdomain: string; createdAt: string }>();
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;

  do {
    const scanResp = await ddbClient.send(
      new ScanCommand({
        TableName: clientConfigTable,
        ProjectionExpression: 'clientId, subdomain, createdAt',
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    for (const item of scanResp.Items ?? []) {
      const clientId = item['clientId']?.S ?? '';
      if (clientId) {
        configClientIds.add(clientId);
        configClientDetails.set(clientId, {
          subdomain: item['subdomain']?.S ?? 'unknown',
          createdAt: item['createdAt']?.S ?? 'unknown',
        });
      }
    }

    lastEvaluatedKey = scanResp.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  // -------------------------------------------------------------------------
  // Step 3: Compute orphan sets
  // -------------------------------------------------------------------------

  // Clients in Cognito with no matching config row
  const orphanedAppClients: string[] = [];
  for (const clientId of cognitoClientIds) {
    if (!configClientIds.has(clientId)) {
      orphanedAppClients.push(clientId);
    }
  }

  // Config rows whose clientId doesn't exist in Cognito
  const orphanedConfigRows: string[] = [];
  for (const clientId of configClientIds) {
    if (!cognitoClientIds.has(clientId)) {
      orphanedConfigRows.push(clientId);
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: Emit metrics
  // -------------------------------------------------------------------------
  emitMetric('OrphanedAppClients', orphanedAppClients.length);
  emitMetric('OrphanedConfigRows', orphanedConfigRows.length);

  // -------------------------------------------------------------------------
  // Step 5: Log orphan details for operator inspection
  // -------------------------------------------------------------------------
  if (orphanedAppClients.length > 0) {
    console.log(
      JSON.stringify({
        level: 'WARN',
        event: 'reconciler.orphaned_app_clients',
        count: orphanedAppClients.length,
        clientIds: orphanedAppClients,
      }),
    );
  }

  if (orphanedConfigRows.length > 0) {
    const details = orphanedConfigRows.map((clientId) => ({
      clientId,
      ...configClientDetails.get(clientId),
    }));
    console.log(
      JSON.stringify({
        level: 'WARN',
        event: 'reconciler.orphaned_config_rows',
        count: orphanedConfigRows.length,
        rows: details,
      }),
    );
  }

  return { orphanedAppClients, orphanedConfigRows };
}

// ---------------------------------------------------------------------------
// Lambda handler
// ---------------------------------------------------------------------------

export const handler = async (): Promise<void> => {
  const deps: ReconcilerDeps = {
    ddb,
    cognito,
    userPoolId: USER_POOL_ID,
    clientConfigTable: CLIENT_CONFIG_TABLE,
  };

  const result = await runReconciler(deps);

  console.log(
    JSON.stringify({
      level: 'INFO',
      event: 'reconciler.complete',
      orphanedAppClients: result.orphanedAppClients.length,
      orphanedConfigRows: result.orphanedConfigRows.length,
    }),
  );
};
