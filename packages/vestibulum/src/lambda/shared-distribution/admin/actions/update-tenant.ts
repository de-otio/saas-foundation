/**
 * updateTenant action.
 *
 * Only `allowedEmailDomains` is mutable. The Zod schema uses `.strict()`
 * to reject any attempt to include `tenantId` or `subdomain` in the request.
 *
 * See doc/vestibulum/shared-distribution/03-tenant-onboarding.md § updateTenant.
 */

import {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import type { UpdateTenantRequest, UpdateTenantResponse } from '../schemas.js';
import { emitTenantUpdated, emitAllowlistChanged } from '../metrics.js';
import type { CallerIdentity } from '../audit-log.js';
import { auditUpdateTenant } from '../audit-log.js';

export class TenantNotFoundError extends Error {
  public readonly statusCode = 404;
  constructor(tenantId: string) {
    super(`Tenant not found: ${tenantId}`);
    this.name = 'TenantNotFoundError';
  }
}

export interface UpdateTenantDeps {
  readonly ddb: DynamoDBClient;
  readonly clientConfigTable: string;
}

export async function updateTenant(
  req: UpdateTenantRequest,
  deps: UpdateTenantDeps,
  caller: CallerIdentity,
  requestId: string,
): Promise<UpdateTenantResponse> {
  const { ddb, clientConfigTable } = deps;

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
  const beforeDomains = item['allowedEmailDomains']?.SS ?? [];

  const updatedAt = new Date().toISOString();

  await ddb.send(
    new UpdateItemCommand({
      TableName: clientConfigTable,
      Key: { clientId: { S: clientId } },
      UpdateExpression: 'SET allowedEmailDomains = :ed, updatedAt = :now',
      ExpressionAttributeValues: {
        ':ed': {
          SS:
            req.allowedEmailDomains.length > 0
              ? [...req.allowedEmailDomains]
              : ['__EMPTY__'],
        },
        ':now': { S: updatedAt },
      },
      ConditionExpression: 'attribute_exists(clientId)',
    }),
  );

  // Audit + metrics
  auditUpdateTenant({
    caller,
    requestId,
    tenantId: req.tenantId,
    subdomain,
    before: { allowedEmailDomains: beforeDomains },
    after: { allowedEmailDomains: req.allowedEmailDomains },
  });
  emitAllowlistChanged(req.tenantId, subdomain);
  emitTenantUpdated(req.tenantId);

  return { tenantId: req.tenantId, updatedAt };
}
