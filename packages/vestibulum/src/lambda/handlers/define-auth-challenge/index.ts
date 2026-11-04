/**
 * DefineAuthChallenge Cognito trigger — CUSTOM_AUTH state machine.
 *
 * Implements the Cognito CUSTOM_AUTH challenge flow for passwordless
 * magic-link sign-in. This handler acts as the state machine glue between
 * challenge rounds:
 *
 *  1. First invocation (empty session): issue a CUSTOM_CHALLENGE.
 *  2. Second invocation (`session = [CUSTOM_CHALLENGE ✓]` exactly): issue tokens.
 *  3. Every other shape fails authentication (`signin_attempts_bounded`): a
 *     failed round (no retry on the same session — prevents brute-force
 *     guessing of the 8-digit code), any round that is not `CUSTOM_CHALLENGE`,
 *     and any session longer than one.
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
    const session: unknown = event.request.session;

    // `signin_attempts_bounded`: exactly ONE answer per session. Every extra
    // round would re-invoke Create (minting and mailing again), so only two
    // shapes are ever acted on and everything else fails.
    if (Array.isArray(session) && session.length === 0) {
      // No challenge has been issued yet — start the custom auth flow.
      event.response.challengeName = "CUSTOM_CHALLENGE";
      event.response.issueTokens = false;
      event.response.failAuthentication = false;
      return event;
    }

    const only: unknown = Array.isArray(session) && session.length === 1 ? session[0] : undefined;
    const answeredOnceCorrectly =
      typeof only === "object" &&
      only !== null &&
      (only as Partial<ChallengeResult>).challengeName === "CUSTOM_CHALLENGE" &&
      (only as Partial<ChallengeResult>).challengeResult === true;

    if (answeredOnceCorrectly) {
      // The single allowed custom round was answered correctly — issue tokens.
      event.response.issueTokens = true;
      event.response.failAuthentication = false;
      return event;
    }

    // A failed round, a non-CUSTOM_CHALLENGE round (e.g. SRP/password), a longer
    // session, or anything malformed: no retry, no tokens.
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
    return event;
  };
}
