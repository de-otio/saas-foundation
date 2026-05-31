/**
 * `setRequestContext` — replacement-based context update during the
 * early-request phase only.
 *
 * Per B-L reconciliation: `RequestContext` is `Object.freeze`d at
 * construction; mid-request mutation is forbidden. The mechanism for
 * late-bound fields (principal after auth, traceId after tracing
 * middleware) is REPLACEMENT, not mutation.
 *
 * `setRequestContext(next)` swaps the ALS entry to a fresh frozen object.
 * It throws `RequestContextPhaseError` if called after the early-request
 * phase has ended (i.e., once handler dispatch begins).
 *
 * Permitted window:
 *   - After `runWithRequestContext` opens the ALS scope.
 *   - Before the wrapped function's synchronous dispatch returns
 *     (i.e., before any `await` in the route handler fires).
 * Consumer middleware (auth, tenant resolution) uses this freely.
 * Route handlers must not call it.
 *
 * Impure: writes to ALS store.
 */

import type { RequestContext } from "../types/frozen/request-context.js";
import { contextStorage, PHASE_FLAG_KEY } from "./als.js";
import { RequestContextPhaseError } from "./errors.js";

/** Symbol used to mark that the early-request phase has ended. */
export { PHASE_FLAG_KEY };

/**
 * Replace the ALS-current `RequestContext` with `next`.
 * The replacement is itself created via `Object.freeze`.
 *
 * Throws `RequestContextPhaseError` if:
 * - There is no current context in the ALS store.
 * - The phase flag has been set (handler dispatch has begun).
 */
export function setRequestContext(next: RequestContext): void {
  const current = contextStorage.getStore();
  if (current === undefined) {
    throw new RequestContextPhaseError(
      "setRequestContext called outside any runWithRequestContext scope",
    );
  }

  // Check the phase flag. It is stored on a symbol-keyed non-enumerable
  // property attached to the context before freeze.
  const phaseEnded = (current as unknown as Record<symbol, unknown>)[PHASE_FLAG_KEY] === true;
  if (phaseEnded) {
    throw new RequestContextPhaseError("setRequestContext called after handler dispatch began");
  }

  // Swap the ALS entry. contextStorage.enterWith replaces the store value in
  // the current async context, so all subsequent ALS reads in this async
  // subtree will see the new context.
  contextStorage.enterWith(next);
}
