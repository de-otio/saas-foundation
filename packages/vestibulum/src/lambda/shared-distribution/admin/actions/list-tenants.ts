/**
 * listTenants action — paginated scan of the ClientConfig table.
 *
 * Returns up to `limit` (default 20, max 100) rows per page with a
 * base64-encoded cursor for continuation. Read-only; no audit log.
 */

import {
  DynamoDBClient,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import type { ListTenantsRequest } from '../schemas.js';
import type { ClientConfigRow } from '@de-otio/saas-foundation/types/frozen';
import { tenantSubdomain, tenantId as tenantIdFn } from '@de-otio/saas-foundation/types/frozen';

export interface ListTenantsResponse {
  readonly items: readonly ClientConfigRow[];
  readonly nextCursor?: string | undefined;
}

export interface ListTenantsDeps {
  readonly ddb: DynamoDBClient;
  readonly clientConfigTable: string;
}

export async function listTenants(
  req: ListTenantsRequest,
  deps: ListTenantsDeps,
): Promise<ListTenantsResponse> {
  const { ddb, clientConfigTable } = deps;
  const limit = req.limit ?? 20;

  // Decode cursor if provided
  let exclusiveStartKey: Record<string, { S?: string }> | undefined;
  if (req.cursor != null && req.cursor !== '') {
    try {
      exclusiveStartKey = JSON.parse(Buffer.from(req.cursor, 'base64').toString('utf8')) as Record<string, { S?: string }>;
    } catch {
      // Invalid cursor — start from beginning
    }
  }

  const scanResult = await ddb.send(
    new ScanCommand({
      TableName: clientConfigTable,
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey,
    }),
  );

  const items: ClientConfigRow[] = (scanResult.Items ?? []).map((item) => {
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
  });

  let nextCursor: string | undefined;
  if (scanResult.LastEvaluatedKey) {
    nextCursor = Buffer.from(JSON.stringify(scanResult.LastEvaluatedKey)).toString('base64');
  }

  return { items, nextCursor };
}
