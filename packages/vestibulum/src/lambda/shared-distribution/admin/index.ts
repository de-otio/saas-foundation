/**
 * Admin Lambda handler — shared-distribution tenant management.
 *
 * Function URL with AuthType: AWS_IAM. Payload-discriminated by `action`.
 * Zod discriminated-union parsing at the boundary; unknown actions → 400.
 *
 * See doc/vestibulum/shared-distribution/03-tenant-onboarding.md for the
 * full spec.
 */

import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from './function-url-types.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';

import { AdminRequestSchema } from './schemas.js';
import { extractCallerIdentity } from './audit-log.js';
import { createTenant } from './actions/create-tenant.js';
import { updateTenant } from './actions/update-tenant.js';
import { deleteTenant } from './actions/delete-tenant.js';
import { getTenant } from './actions/get-tenant.js';
import { listTenants } from './actions/list-tenants.js';
import type { CreateTenantDeps } from './actions/create-tenant.js';
import type { UpdateTenantDeps } from './actions/update-tenant.js';
import type { DeleteTenantDeps } from './actions/delete-tenant.js';
import type { GetTenantDeps } from './actions/get-tenant.js';
import type { ListTenantsDeps } from './actions/list-tenants.js';

// ---------------------------------------------------------------------------
// Module-level singletons — one per Lambda container
// ---------------------------------------------------------------------------

const ddb = new DynamoDBClient({});
const cognito = new CognitoIdentityProviderClient({});

// ---------------------------------------------------------------------------
// Environment — read once at module init
// ---------------------------------------------------------------------------

const USER_POOL_ID = process.env['VESTIBULUM_USER_POOL_ID'] ?? '';
const CLIENT_CONFIG_TABLE = process.env['VESTIBULUM_CLIENT_CONFIG_TABLE'] ?? '';
const IDEMPOTENCY_TABLE = process.env['VESTIBULUM_IDEMPOTENCY_TABLE'] ?? '';
const RESERVATIONS_TABLE = process.env['VESTIBULUM_RESERVATIONS_TABLE'] ?? '';
const TENANT_PARENT = process.env['VESTIBULUM_TENANT_PARENT'] ?? '';

// ---------------------------------------------------------------------------
// Shared deps objects (constructed lazily but effectively once per container)
// ---------------------------------------------------------------------------

const createDeps: CreateTenantDeps = {
  ddb,
  cognito,
  userPoolId: USER_POOL_ID,
  clientConfigTable: CLIENT_CONFIG_TABLE,
  idempotencyTable: IDEMPOTENCY_TABLE,
  reservationsTable: RESERVATIONS_TABLE,
  tenantParent: TENANT_PARENT,
};

const updateDeps: UpdateTenantDeps = {
  ddb,
  clientConfigTable: CLIENT_CONFIG_TABLE,
};

const deleteDeps: DeleteTenantDeps = {
  ddb,
  cognito,
  userPoolId: USER_POOL_ID,
  clientConfigTable: CLIENT_CONFIG_TABLE,
};

const getDeps: GetTenantDeps = {
  ddb,
  clientConfigTable: CLIENT_CONFIG_TABLE,
};

const listDeps: ListTenantsDeps = {
  ddb,
  clientConfigTable: CLIENT_CONFIG_TABLE,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (
  event: LambdaFunctionURLEvent,
): Promise<LambdaFunctionURLResult> => {
  const requestId = event.requestContext.requestId;

  // Parse body
  let body: unknown;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
      : (event.body ?? '{}');
    body = JSON.parse(raw);
  } catch {
    return jsonResponse(400, { error: 'INVALID_JSON' });
  }

  // Validate with discriminated-union schema
  const parseResult = AdminRequestSchema.safeParse(body);
  if (!parseResult.success) {
    return jsonResponse(400, {
      error: 'INVALID_REQUEST',
      detail: parseResult.error.format(),
    });
  }

  const req = parseResult.data;
  const caller = extractCallerIdentity(event);

  try {
    switch (req.action) {
      case 'createTenant': {
        const response = await createTenant(req, createDeps, caller, requestId);
        return jsonResponse(200, response);
      }
      case 'updateTenant': {
        const response = await updateTenant(req, updateDeps, caller, requestId);
        return jsonResponse(200, response);
      }
      case 'deleteTenant': {
        await deleteTenant(req, deleteDeps, caller, requestId);
        return jsonResponse(200, { ok: true });
      }
      case 'getTenant': {
        const response = await getTenant(req, getDeps);
        return jsonResponse(200, response);
      }
      case 'listTenants': {
        const response = await listTenants(req, listDeps);
        return jsonResponse(200, response);
      }
      default: {
        // Exhaustiveness check — TypeScript ensures this is `never`
        return jsonResponse(400, { error: 'UNKNOWN_ACTION' });
      }
    }
  } catch (err) {
    if (isStatusError(err)) {
      const statusCode = (err as { statusCode: number }).statusCode;
      return jsonResponse(statusCode, { error: err.message });
    }
    // Unexpected error — 500
    console.error('Admin Lambda unhandled error', { requestId, error: err });
    return jsonResponse(500, { error: 'INTERNAL_ERROR' });
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(statusCode: number, body: unknown): LambdaFunctionURLResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function isStatusError(err: unknown): err is Error & { statusCode: number } {
  return (
    err instanceof Error &&
    typeof (err as unknown as Record<string, unknown>)['statusCode'] === 'number'
  );
}
