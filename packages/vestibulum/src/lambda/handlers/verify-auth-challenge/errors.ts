/**
 * Single source of truth for the user-facing auth error.
 *
 * Every failure path in `CreateAuthChallenge` and `VerifyAuthChallengeResponse`
 * that surfaces to the caller throws this exact `Error` — byte-identical
 * message — so an attacker cannot distinguish:
 *
 *   - no such user
 *   - wrong token
 *   - expired token
 *   - single-use violation
 *   - rate-limit hit
 *   - quarantined / denylisted address
 *
 * The cause is logged server-side in regional CloudWatch and never returned
 * to the caller. See plans/00-conventions.md § Error responses.
 */

/** The exact, immutable error message that surfaces to callers. */
export const GENERIC_AUTH_ERROR_MESSAGE = "Authentication failed";

/** Returns a fresh `Error` with the generic message. */
export function GENERIC_AUTH_ERROR(): Error {
  return new Error(GENERIC_AUTH_ERROR_MESSAGE);
}
