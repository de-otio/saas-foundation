/**
 * deleteTenant action.
 *
 * Order: (1) optionally revoke sessions, (2) delete Cognito client,
 * (3) delete ClientConfig row.
 *
 * App-client-first order is deliberate: the moment the Cognito client is
 * deleted, no new tokens can be issued. The row deletion failing after
 * leaves a garbage row (safe — reconciler picks it up) rather than a
 * live client with no row.
 *
 * See doc/vestibulum/shared-distribution/03-tenant-onboarding.md § deleteTenant.
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
import type { DeleteTenantRequest } from '../schemas.js';
import { emitTenantDeleted } from '../metrics.js';
import type { CallerIdentity } from '../audit-log.js';
import { auditDeleteTenant } from '../audit-log.js';

export class TenantNotFoundError extends Error {
  public readonly statusCode = 404;
  constructor(tenantId: string) {
    super(`Tenant not found: ${tenantId}`);
    this.name = 'TenantNotFoundError';
  }
}

export interface DeleteTenantDeps {
  readonly ddb: DynamoDBClient;
  readonly cognito: CognitoIdentityProviderClient;
  readonly userPoolId: string;
  readonly clientConfigTable: string;
}

export async function deleteTenant(
  req: DeleteTenantRequest,
  deps: DeleteTenantDeps,
  caller: CallerIdentity,
  requestId: string,
): Promise<void> {
  const { ddb, cognito, userPoolId, clientConfigTable } = deps;

  // Look up by TenantIdIndex GSI
  const queryResult = await ddb.send(
    new QueryCommand({
      TableName: clientConfigTable,
      IndexName: 'TenantIdIndex',
      KeyConditionExpression: 'tenantId = :tid',
      ExpressionAttributeValues: { ':tid': { S: req.tenantId } },
      Limit: 1,
    }),
  );

  const item = queryResult.Items?.[0];
  if (!item) {
    throw new TenantNotFoundError(req.tenantId);
  }

  const clientId = item['clientId']?.S ?? '';
  const subdomain = item['subdomain']?.S ?? '';

  // -------------------------------------------------------------------------
  // (1) Optionally revoke active sessions for all users
  // -------------------------------------------------------------------------
  if (req.revokeActiveSessions === true) {
    await revokeAllSessionsForClient(cognito, userPoolId, clientId);
  }

  // -------------------------------------------------------------------------
  // (2) Delete Cognito app client — prevents new token issuance
  // -------------------------------------------------------------------------
  await cognito.send(
    new DeleteUserPoolClientCommand({
      UserPoolId: userPoolId,
      ClientId: clientId,
    }),
  );

  // -------------------------------------------------------------------------
  // (3) Delete ClientConfig row
  // -------------------------------------------------------------------------
  await ddb.send(
    new DeleteItemCommand({
      TableName: clientConfigTable,
      Key: { clientId: { S: clientId } },
    }),
  );

  // Audit + metric
  auditDeleteTenant({
    caller,
    requestId,
    tenantId: req.tenantId,
    subdomain,
    revokedSessions: req.revokeActiveSessions ?? false,
  });
  emitTenantDeleted(req.tenantId, subdomain, req.revokeActiveSessions ?? false);
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

/**
 * Iterate all users in the pool and call AdminUserGlobalSignOut for each.
 * This closes the post-deletion token-validity window.
 *
 * Note: this iterates ALL pool users (no efficient per-client index in
 * Cognito). For large pools this may be slow. The caller should set
 * `revokeActiveSessions: true` only for sensitive deletions.
 */
async function revokeAllSessionsForClient(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  _clientId: string,
): Promise<void> {
  let paginationToken: string | undefined;

  do {
    const listResult = await cognito.send(
      new ListUsersCommand({
        UserPoolId: userPoolId,
        PaginationToken: paginationToken,
        Limit: 60,
      }),
    );

    const users = listResult.Users ?? [];

    await Promise.all(
      users.map(async (user) => {
        if (user.Username == null || user.Username === '') return;
        try {
          await cognito.send(
            new AdminUserGlobalSignOutCommand({
              UserPoolId: userPoolId,
              Username: user.Username,
            }),
          );
        } catch {
          // Best-effort per user — one failure should not block the rest.
        }
      }),
    );

    paginationToken = listResult.PaginationToken;
  } while (paginationToken != null && paginationToken !== '');
}
