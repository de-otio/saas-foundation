/**
 * `createRequestContext` — constructs and freezes a `RequestContext`.
 *
 * Invariants enforced here:
 * 1. `requestId` must be a non-empty string.
 * 2. `startedAt` defaults to `clock()` when absent.
 * 3. The returned object is `Object.freeze`d.
 * 4. The per-request logger is attached via `Object.defineProperty` BEFORE
 *    `Object.freeze` (S-F9 requirement).
 *
 * The `clock` parameter defaults to `Date.now` in production; tests inject
 * a frozen value for determinism (per doc/10-ai-maintained-conventions.md).
 */

import type { RequestContext, Principal } from "../types/frozen/request-context.js";
import type { TenantId } from "../types/frozen/tenant.js";
import { RequestContextValidationError } from "./errors.js";
import { attachLoggerToContext } from "../logger/logger.js";

export interface CreateRequestContextInput {
  readonly requestId: string;
  /** Epoch ms at request entry. Defaults to `clock()`. */
  readonly startedAt?: number;
  readonly tenantId?: TenantId;
  readonly principal?: Principal;
  readonly traceId?: string;
  readonly region?: string;
  readonly residencyRegion?: string;
  readonly clientIp?: string;
}

/**
 * Create and freeze a `RequestContext`.
 *
 * @param input - Request context fields. `startedAt` defaults to `clock()`.
 * @param clock - Time source. Defaults to `Date.now`. Injected in tests for
 *   determinism.
 */
export function createRequestContext(
  input: CreateRequestContextInput,
  clock: () => number = Date.now,
): RequestContext {
  if (typeof input.requestId !== "string" || input.requestId.length === 0) {
    throw new RequestContextValidationError("requestId", "must be a non-empty string");
  }

  // Build the draft as a plain object. All fields that are present on the
  // input are copied; absent optional fields are omitted (exactOptionalPropertyTypes).
  const draft: RequestContext = {
    requestId: input.requestId,
    startedAt: input.startedAt ?? clock(),
    ...(input.tenantId !== undefined && { tenantId: input.tenantId }),
    ...(input.principal !== undefined && { principal: input.principal }),
    ...(input.traceId !== undefined && { traceId: input.traceId }),
    ...(input.region !== undefined && { region: input.region }),
    ...(input.residencyRegion !== undefined && {
      residencyRegion: input.residencyRegion,
    }),
    ...(input.clientIp !== undefined && { clientIp: input.clientIp }),
  };

  // Attach the per-request logger on a private, non-enumerable symbol-keyed
  // property BEFORE Object.freeze. This is the S-F9 load-bearing order.
  const logBindings: Record<string, unknown> = {
    requestId: draft.requestId,
    ...(draft.tenantId !== undefined && { tenantId: draft.tenantId }),
    ...(draft.traceId !== undefined && { traceId: draft.traceId }),
    ...(draft.principal?.kind === "user" && {
      userId: draft.principal.userSub,
    }),
  };
  attachLoggerToContext(draft, logBindings);

  return Object.freeze(draft);
}
