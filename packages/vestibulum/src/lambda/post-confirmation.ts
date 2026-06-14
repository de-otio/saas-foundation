/**
 * Factory for the Cognito post-confirmation Lambda template.
 *
 * Consumers supply a {@link Provisioner} callback (and optionally an
 * `onError` hook) and receive a complete Lambda handler that:
 *
 *  1. Normalises the Cognito event.
 *  2. Calls the consumer callback with a {@link ProvisionerInput}.
 *  3. Returns the event unmodified (post-confirmation triggers
 *     cannot mutate the user — Cognito ignores response mutations
 *     on this trigger).
 *  4. If the callback throws: invokes `onError(err, event)` first,
 *     then rethrows. Cognito then rolls back the user confirmation
 *     and surfaces a sign-up error to the user, avoiding the
 *     half-created-user failure mode.
 *
 * See doc/federation/02-runtime-api.md § createPostConfirmationHandler.
 */

import type { Provisioner, ProvisionerInput } from "../callbacks/types.js";
import { parseIdentityFromUserAttributes, type PostConfirmationEvent } from "./cognito-events.js";

/**
 * Cognito post-confirmation handler. Always returns the event
 * unmodified on success.
 */
export type PostConfirmationHandler = (
  event: PostConfirmationEvent,
) => Promise<PostConfirmationEvent>;

/**
 * Callbacks passed to {@link createPostConfirmationHandler}.
 */
export interface PostConfirmationCallbacks {
  /** Consumer-supplied provisioner. */
  provision: Provisioner;

  /**
   * Optional error hook. Invoked with `(err, event)` before the
   * handler rethrows. Synchronous; if the hook itself throws, that
   * error is swallowed and the original error is rethrown.
   */
  onError?: (err: unknown, event: PostConfirmationEvent) => void;
}

/**
 * Build a post-confirmation Lambda handler from a {@link Provisioner}
 * callback.
 */
export function createPostConfirmationHandler(
  callbacks: PostConfirmationCallbacks,
): PostConfirmationHandler {
  const { provision, onError } = callbacks;

  return async (event) => {
    try {
      // B-K/H-3: `untrustedClientMetadata` makes the trust boundary
      // visible at the type level. The raw `clientMetadata` from the
      // Cognito event is UNTRUSTED input — callers MUST NOT use it
      // for authorization decisions.
      const input: ProvisionerInput = {
        userSub: event.userName,
        userAttributes: event.request.userAttributes,
        clientId: event.callerContext.clientId,
        triggerSource: event.triggerSource,
        identity: parseIdentityFromUserAttributes(event.request.userAttributes),
        untrustedClientMetadata: event.request.clientMetadata ?? {},
      };

      await provision(input);

      // Post-confirmation triggers cannot mutate the user; the
      // contract is "return the event unchanged or fail the
      // confirmation". Returning `event` (untouched) is the success
      // path.
      return event;
    } catch (err) {
      if (onError) {
        try {
          onError(err, event);
        } catch {
          // See pre-token-generation: onError throws must not mask
          // the original error.
        }
      }
      // Rethrow so Cognito rolls back the user confirmation. The
      // user sees a sign-up failure rather than a silently
      // half-created account.
      throw err;
    }
  };
}
