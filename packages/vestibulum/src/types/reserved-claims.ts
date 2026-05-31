/**
 * Re-exports the frozen `RESERVED_CLAIMS` set from the P1 frozen types
 * and provides a type-safe membership predicate used by the Lambda templates.
 *
 * The canonical set lives in `./frozen/callbacks.ts`; this module exposes
 * the predicate so Lambda template code can import it without importing
 * the full frozen surface.
 *
 * See doc/federation/02-runtime-api.md § Claim resolver callback.
 */

import { RESERVED_CLAIMS } from "./frozen/callbacks.js";

export { RESERVED_CLAIMS };

/**
 * Type-safe membership check. Used by the Lambda template to reject
 * consumer-supplied claim names that Cognito refuses to override.
 */
export function isReservedClaim(claimName: string): boolean {
  return RESERVED_CLAIMS.has(claimName);
}
