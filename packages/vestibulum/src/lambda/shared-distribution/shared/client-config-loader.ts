/**
 * Shared client-config loader for the regional Lambda trigger handlers.
 *
 * NOT for use in the edge function — the edge function cannot reach regional
 * DDB efficiently. This module reads `VESTIBULUM_CLIENT_CONFIG_TABLE` from the
 * environment at module initialisation time.
 *
 * Fail-closed semantics: DDB errors propagate to the caller (no swallowing).
 * Only `null` (row not found) is returned as a value — `null` is NOT cached
 * so a newly-created tenant becomes visible immediately. The TTL applies to
 * positive lookups only.
 *
 * Per-container singleton: one DDB client and one cache per Lambda container.
 */

import { DynamoDBClient, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import type { ClientConfigRow } from '@de-otio/saas-foundation/types/frozen';
import { tenantSubdomain, tenantId } from '@de-otio/saas-foundation/types/frozen';
import { TtlCache } from './ttl-cache.js';

// Read at module init — stable within one Lambda container lifetime.
const TABLE = process.env['VESTIBULUM_CLIENT_CONFIG_TABLE'] ?? '';

// Module-level singletons: one DDB client per container, per spec.
const ddb = new DynamoDBClient({});
const cacheByClientId = new TtlCache<ClientConfigRow | null>({ ttlMs: 5 * 60 * 1000 });
const cacheBySubdomain = new TtlCache<ClientConfigRow | null>({ ttlMs: 5 * 60 * 1000 });

/**
 * Load a ClientConfigRow by Cognito app client ID.
 *
 * Returns null when no row exists; throws on DDB errors (fail-closed).
 * Caches positive lookups for 5 minutes.
 */
export async function loadClientConfigByClientId(clientId: string): Promise<ClientConfigRow | null> {
  return cacheByClientId.getOrLoad(clientId, async () => {
    const resp = await ddb.send(new GetItemCommand({
      TableName: TABLE,
      Key: { clientId: { S: clientId } },
    }));
    if (!resp.Item) return null;
    return parseRow(clientId, resp.Item as DdbItem);
  });
}

/**
 * Load a ClientConfigRow by tenant subdomain label (e.g. "acme").
 *
 * Uses the `SubdomainIndex` GSI. Returns null when no row exists;
 * throws on DDB errors (fail-closed). Caches positive lookups for 5 minutes.
 */
export async function loadClientConfigBySubdomain(subdomain: string): Promise<ClientConfigRow | null> {
  return cacheBySubdomain.getOrLoad(subdomain, async () => {
    const resp = await ddb.send(new QueryCommand({
      TableName: TABLE,
      IndexName: 'SubdomainIndex',
      KeyConditionExpression: 'subdomain = :sd',
      ExpressionAttributeValues: { ':sd': { S: subdomain } },
      Limit: 1,
    }));
    const item = resp.Items?.[0] as DdbItem | undefined;
    if (!item) return null;
    return parseRow(item['clientId']?.S ?? '', item);
  });
}

/** DDB attribute map shape used internally. */
type DdbItem = Record<string, { S?: string; SS?: string[] } | undefined>;

/** Parse a raw DDB attribute map into a ClientConfigRow. */
function parseRow(clientId: string, item: DdbItem): ClientConfigRow {
  const row: ClientConfigRow = {
    clientId,
    subdomain: tenantSubdomain(item['subdomain']?.S ?? ''),
    tenantId: tenantId(item['tenantId']?.S ?? ''),
    siteBaseUrl: item['siteBaseUrl']?.S ?? '',
    allowedEmailDomains: [...(item['allowedEmailDomains']?.SS ?? [])],
    createdAt: item['createdAt']?.S ?? '',
  };
  const updatedAt = item['updatedAt']?.S;
  if (updatedAt !== undefined) {
    return { ...row, updatedAt };
  }
  return row;
}
