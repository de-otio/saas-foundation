/**
 * getTenant action — read-only debugging endpoint.
 *
 * Returns the ClientConfig row for the given tenantId. No audit log
 * emission (read-only per 08 spec). INFO-level console log only.
 */

import {
  DynamoDBClient,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import type { GetTenantRequest } from '../schemas.js';
import type { ClientConfigRow } from '@de-otio/saas-foundation/types/frozen';
import { tenantSubdomain, tenantId as tenantIdFn } from '@de-otio/saas-foundation/types/frozen';

export class TenantNotFoundError extends Error {
  public readonly statusCode = 404;
  constructor(tenantId: string) {
    super(`Tenant not found: ${tenantId}`);
    this.name = 'TenantNotFoundError';
  }
}

export interface GetTenantDeps {
  readonly ddb: DynamoDBClient;
  readonly clientConfigTable: string;
}

export async function getTenant(
  req: GetTenantRequest,
  deps: GetTenantDeps,
): Promise<ClientConfigRow> {
  const { ddb, clientConfigTable } = deps;

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

  const domainsSS = item['allowedEmailDomains']?.SS ?? [];
  const allowedEmailDomains =
    domainsSS.length === 1 && domainsSS[0] === '__EMPTY__' ? [] : domainsSS;

  const row: ClientConfigRow = {
    clientId: item['clientId']?.S ?? '',
    subdomain: tenantSubdomain(item['subdomain']?.S ?? ''),
    tenantId: tenantIdFn(item['tenantId']?.S ?? ''),
    siteBaseUrl: item['siteBaseUrl']?.S ?? '',
    allowedEmailDomains,
    createdAt: item['createdAt']?.S ?? '',
  };

  const updatedAt = item['updatedAt']?.S;
  if (updatedAt !== undefined) {
    return { ...row, updatedAt };
  }

  return row;
}
