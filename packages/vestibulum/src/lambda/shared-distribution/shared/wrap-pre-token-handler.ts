/**
 * `wrapPreTokenHandler` — contract-enforcing wrapper for consumer
 * PreTokenGeneration Lambda handlers (review fixes B1).
 *
 * Guarantees:
 *  1. `custom:tenant_id` is pre-injected from `ClientConfigRow` before the
 *     inner handler runs.
 *  2. If the inner handler overwrites `custom:tenant_id`, the wrapper throws
 *     (token mint fails; Cognito reports the error at login time).
 *  3. If the inner handler adds `custom:tenant_id` to `claimsToSuppress`,
 *     the wrapper throws — Cognito processes suppressions AFTER overrides,
 *     so the claim would be absent from the minted token even though it was
 *     set in step 1 (review fix B1).
 *  4. If the inner handler throws, the wrapper propagates without swallowing.
 */

import type { ClientConfigRow } from '@de-otio/saas-foundation/types/frozen';
import { loadClientConfigByClientId } from './client-config-loader.js';

/**
 * Minimal shape of a Cognito PreTokenGeneration event that the wrapper
 * depends on. Matches both V1 and V2 Cognito event shapes at the fields
 * this module reads and writes.
 *
 * Consumers may use the precise `PreTokenGenerationTriggerEvent` from
 * `@types/aws-lambda` for their handler signature; that type satisfies
 * this constraint.
 */
/** Shape of the `response` field in a Cognito PreTokenGeneration event. */
export interface PreTokenResponse {
  claimsOverrideDetails?: {
    claimsToAddOrOverride?: Record<string, string>;
    claimsToSuppress?: string[];
  };
}

export interface PreTokenEventLike {
  readonly callerContext: { readonly clientId: string };
  // Typed as `PreTokenResponse | null | undefined` to reflect Cognito's actual
  // runtime behaviour: the field may be absent or null even though the AWS
  // @types/aws-lambda declaration marks it required.  The wrapper normalises it
  // to `{}` before invoking the inner handler.
  response: PreTokenResponse | null | undefined;
}

export interface PreTokenContext {
  readonly tenantConfig: ClientConfigRow;
}

export function wrapPreTokenHandler<E extends PreTokenEventLike>(
  inner: (event: E, ctx: PreTokenContext) => Promise<E>,
): (event: E) => Promise<E> {
  return async (event: E): Promise<E> => {
    // 1. Load ClientConfig; throw if missing (fail-closed).
    const cfg = await loadClientConfigByClientId(event.callerContext.clientId);
    if (!cfg) throw new Error('Tenant configuration missing');

    // 2. Pre-set custom:tenant_id before invoking inner.
    // `event.response` may be null/undefined at runtime (Cognito may omit the
    // field); normalise defensively before writing claims.
    if (event.response == null) {
      event.response = {};
    }
    event.response.claimsOverrideDetails = event.response.claimsOverrideDetails ?? {};
    event.response.claimsOverrideDetails.claimsToAddOrOverride = {
      ...event.response.claimsOverrideDetails.claimsToAddOrOverride,
      'custom:tenant_id': cfg.tenantId,
    };

    // 3. Run inner handler.
    const result = await inner(event, { tenantConfig: cfg });

    // 4. Assert custom:tenant_id was not overwritten.
    const finalTenantId =
      result.response?.claimsOverrideDetails?.claimsToAddOrOverride?.['custom:tenant_id'];
    if (finalTenantId !== cfg.tenantId) {
      throw new Error(
        `wrapPreTokenHandler: handler must not overwrite custom:tenant_id ` +
          `(expected '${cfg.tenantId}', got '${String(finalTenantId)}')`,
      );
    }

    // 5. Assert custom:tenant_id is not in claimsToSuppress (review fix B1).
    //    Cognito processes suppressions AFTER overrides; a suppression here
    //    would silently strip the claim from the minted token.
    const suppressed = result.response?.claimsOverrideDetails?.claimsToSuppress;
    if (Array.isArray(suppressed) && suppressed.includes('custom:tenant_id')) {
      throw new Error(
        `wrapPreTokenHandler: handler must not suppress custom:tenant_id`,
      );
    }

    return result;
  };
}
