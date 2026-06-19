/**
 * DefineAuthChallenge Cognito trigger — CUSTOM_AUTH state machine.
 *
 * Implements the Cognito CUSTOM_AUTH challenge flow for passwordless
 * magic-link sign-in. This handler acts as the state machine glue between
 * challenge rounds:
 *
 *  1. First invocation (empty session): issue a CUSTOM_CHALLENGE.
 *  2. Second invocation (one session entry): check the challenge result.
 *     - `true`  → issue tokens (challenge succeeded).
 *     - `false` → fail auth (no retry on the same session — prevents
 *                 brute-force token guessing).
 *
 * No PII is written to logs. Challenge results and session indexes are
 * logged at most as boolean/numeric values.
 */

/** Shape of a single challenge round in the Cognito session array. */
interface ChallengeResult {
  readonly challengeName: string;
  readonly challengeResult: boolean;
}

/** Cognito DefineAuthChallenge trigger event (minimal shape we need). */
export interface DefineAuthChallengeEvent {
  readonly request: {
    readonly session: readonly ChallengeResult[];
    readonly userNotFound?: boolean;
  };
  response: {
    challengeName?: string;
    issueTokens?: boolean;
    failAuthentication?: boolean;
  };
}

/**
 * Create a DefineAuthChallenge Cognito trigger handler.
 *
 * Governs the CUSTOM_AUTH challenge state machine. Allows exactly one
 * challenge round per session — on failure, immediately fails authentication
 * without offering a retry. This prevents iterative token-guessing attacks.
 *
 * The handler is logically pure (it only reads the event), but it is declared
 * `async` deliberately: the AWS Lambda Node.js runtime **ignores the return
 * value of a non-async handler** (a synchronous handler must use the
 * `callback` argument), so a sync handler would resolve to `null` and Cognito
 * would reject it with `InvalidLambdaResponseException: Invalid JSON`. Async
 * makes the runtime await and return the populated event.
 */
export function createDefineAuthChallengeHandler() {
  // `async` is intentional despite the absence of `await` — see the JSDoc
  // above: a non-async Lambda handler's return value is ignored by the
  // runtime, so Cognito would receive `null` and fail with
  // `InvalidLambdaResponseException`.
  // eslint-disable-next-line @typescript-eslint/require-await
  return async function handler(
    event: DefineAuthChallengeEvent,
  ): Promise<DefineAuthChallengeEvent> {
    const session = event.request.session;

    if (session.length === 0) {
      // No challenge has been issued yet — start the custom auth flow.
      event.response.challengeName = "CUSTOM_CHALLENGE";
      event.response.issueTokens = false;
      event.response.failAuthentication = false;
      return event;
    }

    // There is exactly one session entry (the single allowed challenge round).
    // Retrieve the last result.
    const lastResult = session[session.length - 1];

    if (lastResult !== undefined && lastResult.challengeResult === true) {
      // Challenge answered correctly — issue tokens.
      event.response.issueTokens = true;
      event.response.failAuthentication = false;
      return event;
    }

    // Challenge failed (or session is in an unexpected state).
    // No retry: immediately fail authentication.
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
    return event;
  };
}
