/**
 * AsyncLocalStorage carrier for `TenantId`.
 *
 * Rationale for this singleton (one of the two intentional process-global
 * singletons in the foundation; the other is `request-context/als.ts`):
 *
 * ALS is designed to be process-global in Node.js. Each `AsyncLocalStorage`
 * instance tracks its own async-context tree. Using multiple instances
 * would lose context across `await` boundaries because each carries
 * independent state. The whole point of the carrier is that any code
 * reachable from a `runWithTenantContext` call observes the same
 * `TenantId` without explicit propagation.
 *
 * Why a separate ALS from `RequestContext`?
 *
 * The two values can be set at different times. Tenant resolution
 * happens BEFORE `RequestContext` construction (the resolved tenantId
 * is part of the initial context). But some background paths need a
 * tenant scope WITHOUT a request — e.g., a tenant-scoped cron job
 * running outside an HTTP handler. Decoupling the two ALS instances
 * keeps those background paths legal without forcing them to fabricate
 * a synthetic request context.
 *
 * Impure: module-level side effect (instantiates the ALS).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { TenantId } from "../types/frozen/tenant.js";

/**
 * The one process-global ALS carrier for `TenantId`.
 * Do not create additional instances.
 */
export const tenantStorage = new AsyncLocalStorage<TenantId>();

/**
 * Run `fn` inside an ALS scope backed by `tenantId`. Reads of
 * `getCurrentTenantId()` anywhere in the synchronous-or-async call
 * tree below this point return the supplied tenant.
 *
 * Impure: writes ALS store.
 */
export function runWithTenantContext<T>(tenantId: TenantId, fn: () => T): T {
  return tenantStorage.run(tenantId, fn);
}

/**
 * Read the current `TenantId` from the ALS store.
 *
 * Returns `undefined` when called outside any `runWithTenantContext`
 * scope. Returning `undefined` (not throwing) is deliberate — callers
 * that REQUIRE a tenant should explicitly assert and decide on the
 * error shape themselves; the foundation does not assume the
 * application's "no-tenant" policy.
 *
 * Impure: reads ALS store.
 */
export function getCurrentTenantId(): TenantId | undefined {
  return tenantStorage.getStore();
}
