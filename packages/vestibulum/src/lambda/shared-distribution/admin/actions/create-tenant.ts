/**
 * createTenant action.
 *
 * Three-step flow:
 *   0. Idempotency check (composite key = `${idempotencyKey}#${subdomain}`)
 *   1. Input validation (Zod pre-validated, additional runtime checks)
 *   2. Reserve subdomain + tenantId atomically via TransactWriteItems
 *      with `attribute_not_exists OR expiresAt < :now` (the B3 fix)
 *   3. Create Cognito app client (with refresh-token rotation, no REFRESH_TOKEN_AUTH)
 *   4. Write ClientConfig row (compensation on failure)
 *   5. Persist idempotency record (24-hour TTL)
 *   6. Release reservations
 *
 * See doc/vestibulum/shared-distribution/03-tenant-onboarding.md for the full spec.
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
import type { CreateTenantRequest, CreateTenantResponse } from '../schemas.js';
import { emitTenantCreated, emitCompensationTriggered } from '../metrics.js';
import type { CallerIdentity } from '../audit-log.js';
import { auditCreateTenant } from '../audit-log.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class ConflictError extends Error {
  public readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class IdempotencyConflictError extends ConflictError {
  constructor(reason: string) {
    super(`Idempotency conflict: ${reason}`);
    this.name = 'IdempotencyConflictError';
  }
}

// ---------------------------------------------------------------------------
// Dependencies interface — injectable for testing
// ---------------------------------------------------------------------------

export interface CreateTenantDeps {
  readonly ddb: DynamoDBClient;
  readonly cognito: CognitoIdentityProviderClient;
  readonly userPoolId: string;
  readonly clientConfigTable: string;
  readonly idempotencyTable: string;
  readonly reservationsTable: string;
  readonly tenantParent: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function createTenant(
  req: CreateTenantRequest,
  deps: CreateTenantDeps,
  caller: CallerIdentity,
  requestId: string,
): Promise<CreateTenantResponse> {
  const {
    ddb,
    cognito,
    userPoolId,
    clientConfigTable,
    idempotencyTable,
    reservationsTable,
    tenantParent,
  } = deps;

  // -------------------------------------------------------------------------
  // (0) Idempotency check
  //
  // Composite key = `${idempotencyKey}#${subdomain}` prevents cross-tenant
  // collisions if callers reuse idempotency keys for different subdomains.
  // -------------------------------------------------------------------------
  const compositeIdempotencyKey = `${req.idempotencyKey}#${req.subdomain}`;

  const existingItem = await ddb.send(
    new GetItemCommand({
      TableName: idempotencyTable,
      Key: { idempotencyKey: { S: compositeIdempotencyKey } },
    }),
  );

  if (existingItem.Item) {
    const stored = JSON.parse(existingItem.Item['response']?.S ?? '{}') as CreateTenantResponse;
    // Defensive: stored response must match this request's subdomain + tenantId.
    if (stored.subdomain !== req.subdomain || stored.tenantId !== req.tenantId) {
      throw new IdempotencyConflictError(
        'Idempotency key reused with different tenant identity',
      );
    }
    return stored;
  }

  // -------------------------------------------------------------------------
  // (2) Reserve subdomain + tenantId atomically
  //
  // The `attribute_not_exists(#k) OR #exp < :now` condition handles DDB's
  // eventually-consistent TTL deletion: an expired-but-not-yet-deleted
  // reservation is treated as absent (B3 fix).
  // -------------------------------------------------------------------------
  const now = Math.floor(Date.now() / 1000);
  const reservationTtl = now + 60; // 60-second window for the in-flight flow

  try {
    await ddb.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            Put: {
              TableName: reservationsTable,
              Item: {
                key: { S: `subdomain#${req.subdomain}` },
                expiresAt: { N: String(reservationTtl) },
              },
              ConditionExpression: 'attribute_not_exists(#k) OR #exp < :now',
              ExpressionAttributeNames: { '#k': 'key', '#exp': 'expiresAt' },
              ExpressionAttributeValues: { ':now': { N: String(now) } },
            },
          },
          {
            Put: {
              TableName: reservationsTable,
              Item: {
                key: { S: `tenantId#${req.tenantId}` },
                expiresAt: { N: String(reservationTtl) },
              },
              ConditionExpression: 'attribute_not_exists(#k) OR #exp < :now',
              ExpressionAttributeNames: { '#k': 'key', '#exp': 'expiresAt' },
              ExpressionAttributeValues: { ':now': { N: String(now) } },
            },
          },
        ],
      }),
    );
  } catch (err) {
    // TransactionCanceledException means one or both reservations are taken
    // by an active (non-expired) entry → concurrent create for same
    // subdomain or tenantId → 409.
    if (err instanceof TransactionCanceledException) {
      throw new ConflictError(
        `Subdomain or tenantId already in use: ${req.subdomain} / ${req.tenantId}`,
      );
    }
    throw err;
  }

  const siteBaseUrl = `https://${req.subdomain}.${tenantParent}`;

  // -------------------------------------------------------------------------
  // (3) Create Cognito app client
  //
  // `ALLOW_REFRESH_TOKEN_AUTH` EXCLUDED — refresh-token rotation
  // (enabled below) is incompatible with that auth flow.
  // -------------------------------------------------------------------------
  let clientId: string;
  try {
    const clientResp = await cognito.send(
      new CreateUserPoolClientCommand({
        UserPoolId: userPoolId,
        ClientName: `tenant-${req.subdomain}`,
        GenerateSecret: false,
        ExplicitAuthFlows: ['ALLOW_CUSTOM_AUTH'], // NO ALLOW_REFRESH_TOKEN_AUTH
        PreventUserExistenceErrors: 'ENABLED',
        EnableTokenRevocation: true,
        RefreshTokenRotation: {
          Feature: 'ENABLED',
          RetryGracePeriodSeconds: 60,
        },
        TokenValidityUnits: {
          AccessToken: 'minutes',
          IdToken: 'minutes',
          RefreshToken: 'days',
        },
        AccessTokenValidity: 60,
        IdTokenValidity: 60,
        RefreshTokenValidity: 30,
        CallbackURLs: [`${siteBaseUrl}/login/callback`],
        LogoutURLs: [`${siteBaseUrl}/logout`],
        AllowedOAuthFlows: [],
        SupportedIdentityProviders: ['COGNITO'],
      }),
    );
    clientId = clientResp.UserPoolClient?.ClientId ?? '';
    if (!clientId) {
      throw new Error('Cognito returned empty ClientId');
    }
  } catch (err) {
    // Cognito failed → release reservations before rethrowing.
    await releaseReservations(ddb, reservationsTable, req.subdomain, req.tenantId).catch(
      () => undefined, // best-effort; 60s TTL is the fallback
    );
    throw err;
  }

  const createdAt = new Date().toISOString();

  // -------------------------------------------------------------------------
  // (4) Write ClientConfig row
  //
  // On failure: compensate by deleting the just-created Cognito client.
  // -------------------------------------------------------------------------
  try {
    await ddb.send(
      new PutItemCommand({
        TableName: clientConfigTable,
        Item: {
          clientId: { S: clientId },
          subdomain: { S: req.subdomain },
          tenantId: { S: req.tenantId },
          siteBaseUrl: { S: siteBaseUrl },
          allowedEmailDomains: {
            SS:
              req.allowedEmailDomains.length > 0
                ? [...req.allowedEmailDomains]
                : ['__EMPTY__'],
          },
          createdAt: { S: createdAt },
        },
        ConditionExpression: 'attribute_not_exists(clientId)',
      }),
    );
  } catch (err) {
    // Compensation: roll back the Cognito client.
    emitCompensationTriggered(req.subdomain);
    await cognito
      .send(
        new DeleteUserPoolClientCommand({
          UserPoolId: userPoolId,
          ClientId: clientId,
        }),
      )
      .catch(() => undefined); // best-effort; reconciler is the safety net
    await releaseReservations(ddb, reservationsTable, req.subdomain, req.tenantId).catch(
      () => undefined,
    );
    throw err;
  }

  const response: CreateTenantResponse = {
    tenantId: req.tenantId,
    subdomain: req.subdomain,
    siteBaseUrl,
    clientId,
    createdAt,
  };

  // -------------------------------------------------------------------------
  // (5) Persist idempotency record (24-hour TTL)
  // -------------------------------------------------------------------------
  await ddb
    .send(
      new PutItemCommand({
        TableName: idempotencyTable,
        Item: {
          idempotencyKey: { S: compositeIdempotencyKey },
          response: { S: JSON.stringify(response) },
          expiresAt: { N: String(Math.floor(Date.now() / 1000) + 86400) },
        },
      }),
    )
    .catch(() => undefined); // Non-fatal — worst case is a non-idempotent retry

  // -------------------------------------------------------------------------
  // (6) Release reservations (60s TTL handles it, but explicit release
  //     frees the namespace immediately for retries)
  // -------------------------------------------------------------------------
  await releaseReservations(ddb, reservationsTable, req.subdomain, req.tenantId).catch(
    () => undefined,
  );

  // Audit + metric
  auditCreateTenant({ caller, requestId, tenantId: req.tenantId, subdomain: req.subdomain, clientId });
  emitTenantCreated(req.tenantId);

  return response;
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

async function releaseReservations(
  ddb: DynamoDBClient,
  table: string,
  subdomain: string,
  tenantId: string,
): Promise<void> {
  await Promise.all([
    ddb.send(
      new DeleteItemCommand({
        TableName: table,
        Key: { key: { S: `subdomain#${subdomain}` } },
      }),
    ),
    ddb.send(
      new DeleteItemCommand({
        TableName: table,
        Key: { key: { S: `tenantId#${tenantId}` } },
      }),
    ),
  ]);
}
