/**
 * `@de-otio/saas-foundation/request-context` barrel.
 *
 * Exports:
 * - `RequestContext`, `Principal` types (re-export from frozen types)
 * - `createRequestContext(input, clock?)` — builds and freezes a context
 * - `runWithRequestContext(ctx, fn)` — enters the ALS scope
 * - `getRequestContext()` — reads the ALS-current context (null outside scope)
 * - `setRequestContext(ctx)` — replaces the ALS entry in the early-request phase
 * - `createTestRequestContext(input)` — test helper (@beta-test-only)
 * - Named errors
 *
 * This module also registers itself as the ALS provider for `getLogger()` in
 * the logger module, so the two modules are wired at import time.
 */

import { setAlsProvider } from "../logger/logger.js";
import { contextStorage } from "./als.js";

// Register the ALS provider so getLogger() can pick up the per-request logger.
// This runs once at module load.
setAlsProvider(() => contextStorage.getStore());

export type { RequestContext, Principal } from "../types/frozen/request-context.js";
export type { CreateRequestContextInput } from "./factory.js";
export { createRequestContext } from "./factory.js";
export { setRequestContext } from "./set-request-context.js";
export { RequestContextPhaseError, RequestContextValidationError } from "./errors.js";

// Re-export the ALS singleton for consumers that need direct access
// (e.g., framework middleware wrappers).
export { contextStorage } from "./als.js";

/**
 * Read the current `RequestContext` from the ALS store.
 * Returns `null` when called outside a `runWithRequestContext` scope.
 *
 * Impure: reads ALS store.
 */
export function getRequestContext():
  | import("../types/frozen/request-context.js").RequestContext
  | null {
  return contextStorage.getStore() ?? null;
}

/**
 * Run `fn` inside an ALS scope backed by `context`.
 *
 * The early-request phase ends when `fn` begins — from that point,
 * `setRequestContext` will throw. This is implemented by attaching a phase
 * flag to a new frozen wrapper context just before `fn` is called.
 *
 * Impure: writes ALS store.
 */
export function runWithRequestContext<T>(
  context: import("../types/frozen/request-context.js").RequestContext,
  fn: () => T,
): T {
  return contextStorage.run(context, fn);
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

import type { Logger } from "../logger/logger.js";
import { LOGGER_KEY } from "../logger/logger.js";
import type { TenantId } from "../types/frozen/tenant.js";
import type { Principal, RequestContext } from "../types/frozen/request-context.js";
import { createRequestContext as _create } from "./factory.js";

export interface CreateTestRequestContextInput {
  readonly requestId?: string;
  readonly tenantId?: TenantId;
  readonly principal?: Principal;
  /** Override the per-request logger (useful for spy/capture assertions). */
  readonly logger?: Logger;
  readonly clock?: () => number;
}

/**
 * Build a frozen `RequestContext` suitable for tests.
 *
 * @beta-test-only
 * Exported from `@de-otio/saas-foundation/request-context` only, not from
 * the package barrel.
 */
export function createTestRequestContext(
  input: CreateTestRequestContextInput = {},
): RequestContext {
  const { logger, clock, ...rest } = input;
  const requestId = rest.requestId ?? "test-request-id";

  const ctx = _create({ requestId, ...rest }, clock);

  if (logger !== undefined) {
    // The context is already frozen. Re-create with the injected logger.
    // We build a plain draft, attach the custom logger, then re-freeze.
    const draft: RequestContext = { ...ctx };
    // defineProperty so we overwrite the existing non-configurable logger.
    // This is only safe because we are building a NEW object (draft), not
    // modifying the frozen ctx.
    Object.defineProperty(draft, LOGGER_KEY, {
      value: logger,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    return Object.freeze(draft);
  }

  return ctx;
}
