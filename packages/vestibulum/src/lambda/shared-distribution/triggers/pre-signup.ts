/**
 * Shared-distribution `PreSignUp` Cognito trigger.
 *
 * Reads per-client `allowedEmailDomains` from `ClientConfig` via DDB.
 * Fail-closed: DDB errors propagate; unknown client → refuse.
 *
 * Security properties:
 * - Generic "Signup not allowed" on every rejection — no enumeration.
 * - Per-client allowlist from DDB, not pool-wide env.
 * - Cached for 5 min per container; DDB errors evict the cache entry.
 */

import { loadClientConfigByClientId } from '../shared/client-config-loader.js';

/** Minimal Cognito PreSignUp trigger event shape. */
export interface SharedPreSignUpEvent {
  readonly callerContext: {
    readonly clientId: string;
  };
  readonly request: {
    readonly userAttributes: {
      readonly email?: string;
    };
  };
  readonly response: Record<string, unknown>;
}

/**
 * PreSignUp handler for shared-distribution mode.
 *
 * Differences from single-tenant handler:
 * - Reads `allowedEmailDomains` from `ClientConfig` row (per clientId), not env.
 * - Unknown client → refuse (no pool-wide fallback).
 * - No rate-limit check here — rate-limit is on `CreateAuthChallenge`.
 */
export const handler = async (event: SharedPreSignUpEvent): Promise<SharedPreSignUpEvent> => {
  // `event.callerContext.clientId` is Cognito-set, not user-set. Trustworthy.
  const clientId = event.callerContext.clientId;

  // Fail-closed: DDB errors propagate (no catch). Unknown client → refuse.
  const cfg = await loadClientConfigByClientId(clientId);
  if (!cfg) {
    throw new Error('Signup not allowed');
  }

  const rawEmail = event.request.userAttributes.email;
  const email = rawEmail?.toLowerCase().trim() ?? '';
  if (!email) throw new Error('Signup not allowed');

  const atIdx = email.lastIndexOf('@');
  const domain = atIdx >= 0 ? email.slice(atIdx + 1) : '';

  if (!domain || !cfg.allowedEmailDomains.includes(domain)) {
    // Generic error — don't leak whether domain or email was the problem.
    throw new Error('Signup not allowed');
  }

  return event;
};
