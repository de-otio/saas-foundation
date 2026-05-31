/**
 * AsyncLocalStorage singleton for `RequestContext`.
 *
 * This is the ONE intentional process-global singleton in the foundation.
 * ALS is designed to be process-global in Node.js: each ALS instance tracks
 * its own async context tree. Using multiple instances would lose context
 * across await boundaries because they would each maintain independent state.
 *
 * The singleton is in this file; all other request-context logic is kept
 * pure and importable without side effects.
 *
 * Impure: module-level side effect (creates the ALS instance).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestContext } from "../types/frozen/request-context.js";

/**
 * The one process-global ALS carrier for `RequestContext`.
 * Do not create additional instances.
 */
export const contextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Phase flag key — stored on a symbol-keyed field of the RequestContext.
 * Set to `true` once the early-request phase ends (handler dispatch begins).
 * `setRequestContext` reads this flag to enforce the phase guard.
 */
export const PHASE_FLAG_KEY: unique symbol = Symbol("foundation.requestPhase");
