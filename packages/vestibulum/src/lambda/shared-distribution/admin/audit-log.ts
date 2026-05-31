/**
 * Structured audit-log helper for the admin Lambda.
 *
 * Emits to stdout (CloudWatch Logs picks it up automatically from Lambda).
 * Format per doc/vestibulum/shared-distribution/08-observability-and-audit.md
 * § Audit logging.
 *
 * Only mutating actions are emitted with the `event: "admin.tenant.*"`
 * discriminator. Read-only ops use plain INFO-level logs.
 */

import type { LambdaFunctionURLEvent } from './function-url-types.js';

/** IAM identity from the Function URL's AWS_IAM auth context. */
export interface CallerIdentity {
  readonly callerArn: string;
  readonly callerAccount: string;
  readonly callerId: string;
  readonly callerSessionContext?: Record<string, unknown> | undefined;
}

/** Extract caller identity from the Function URL event's IAM authorizer context. */
export function extractCallerIdentity(event: LambdaFunctionURLEvent): CallerIdentity {
  const iam = event.requestContext.authorizer?.iam;
  const result: CallerIdentity = {
    callerArn: iam?.userArn ?? iam?.principalOrgId ?? 'unknown',
    callerAccount: iam?.accountId ?? 'unknown',
    callerId: iam?.userId ?? 'unknown',
  };
  if (iam) {
    return { ...result, callerSessionContext: iam as Record<string, unknown> };
  }
  return result;
}

/** Base fields shared by all audit entries. */
interface AuditLogBase {
  readonly '@timestamp': string;
  readonly level: 'INFO' | 'WARN' | 'ERROR';
  readonly event: string;
  readonly action: string;
  readonly requestId: string;
  readonly callerArn: string;
  readonly callerAccount: string;
}

/** Emit a structured audit entry to stdout (-> CloudWatch Logs). */
export function emitAuditLog(
  entry: AuditLogBase & Record<string, unknown>,
): void {
  // Use process.stdout.write to avoid any logger intercepting the output.
  process.stdout.write(JSON.stringify(entry) + '\n');
}

/** Emit a create-tenant audit entry. */
export function auditCreateTenant(opts: {
  caller: CallerIdentity;
  requestId: string;
  tenantId: string;
  subdomain: string;
  clientId: string;
}): void {
  emitAuditLog({
    '@timestamp': new Date().toISOString(),
    level: 'INFO',
    event: 'admin.tenant.create',
    action: 'createTenant',
    requestId: opts.requestId,
    tenantId: opts.tenantId,
    subdomain: opts.subdomain,
    clientId: opts.clientId,
    callerArn: opts.caller.callerArn,
    callerAccount: opts.caller.callerAccount,
    callerSessionContext: opts.caller.callerSessionContext,
  });
}

/** Emit an update-tenant audit entry. */
export function auditUpdateTenant(opts: {
  caller: CallerIdentity;
  requestId: string;
  tenantId: string;
  subdomain: string;
  before: { allowedEmailDomains: readonly string[] };
  after: { allowedEmailDomains: readonly string[] };
}): void {
  emitAuditLog({
    '@timestamp': new Date().toISOString(),
    level: 'INFO',
    event: 'admin.tenant.update',
    action: 'updateTenant',
    requestId: opts.requestId,
    tenantId: opts.tenantId,
    subdomain: opts.subdomain,
    before: opts.before,
    after: opts.after,
    callerArn: opts.caller.callerArn,
    callerAccount: opts.caller.callerAccount,
    callerSessionContext: opts.caller.callerSessionContext,
  });
}

/** Emit a delete-tenant audit entry. */
export function auditDeleteTenant(opts: {
  caller: CallerIdentity;
  requestId: string;
  tenantId: string;
  subdomain: string;
  revokedSessions: boolean;
}): void {
  emitAuditLog({
    '@timestamp': new Date().toISOString(),
    level: 'INFO',
    event: 'admin.tenant.delete',
    action: 'deleteTenant',
    requestId: opts.requestId,
    tenantId: opts.tenantId,
    subdomain: opts.subdomain,
    revokedSessions: opts.revokedSessions,
    callerArn: opts.caller.callerArn,
    callerAccount: opts.caller.callerAccount,
    callerSessionContext: opts.caller.callerSessionContext,
  });
}
