/**
 * Tests for the DefineAuthChallenge Cognito trigger
 * (`src/lambda/handlers/define-auth-challenge/index.ts`).
 *
 * This handler had NO dedicated test before this file — which is how it
 * shipped synchronous. The AWS Lambda Node.js runtime ignores the return value
 * of a non-async handler, so a sync handler resolves to `null` and Cognito
 * rejects it with `InvalidLambdaResponseException: Invalid JSON`. These tests
 * pin both the state-machine output AND that the handler is async (returns a
 * Promise that resolves to the populated event).
 */

import fc from "fast-check";
import { describe, it, expect } from "vitest";

import {
  createDefineAuthChallengeHandler,
  type DefineAuthChallengeEvent,
} from "../../../../src/lambda/handlers/define-auth-challenge/index.js";

function makeEvent(
  session: { challengeName: string; challengeResult: boolean }[],
): DefineAuthChallengeEvent {
  return { request: { session }, response: {} };
}

const CUSTOM_OK = { challengeName: "CUSTOM_CHALLENGE", challengeResult: true } as const;

describe("createDefineAuthChallengeHandler", () => {
  const handler = createDefineAuthChallengeHandler();

  it("returns a Promise (async) so the Lambda runtime honours the return value", () => {
    const result = handler(makeEvent([]));
    expect(typeof (result as { then?: unknown }).then).toBe("function");
  });

  it("empty session → issues a CUSTOM_CHALLENGE", async () => {
    const out = await handler(makeEvent([]));
    expect(out.response.challengeName).toBe("CUSTOM_CHALLENGE");
    expect(out.response.issueTokens).toBe(false);
    expect(out.response.failAuthentication).toBe(false);
  });

  it("correct challenge result → issues tokens", async () => {
    const out = await handler(
      makeEvent([{ challengeName: "CUSTOM_CHALLENGE", challengeResult: true }]),
    );
    expect(out.response.issueTokens).toBe(true);
    expect(out.response.failAuthentication).toBe(false);
  });

  it("failed challenge → fails authentication with no retry", async () => {
    const out = await handler(
      makeEvent([{ challengeName: "CUSTOM_CHALLENGE", challengeResult: false }]),
    );
    expect(out.response.issueTokens).toBe(false);
    expect(out.response.failAuthentication).toBe(true);
  });
});

// signin_attempts_bounded (I10 / U16): exactly ONE answer per session. Define
// issues tokens only for [CUSTOM_CHALLENGE ✓], the first challenge for [], and
// fails every other shape.
describe("signin_attempts_bounded — the Define state machine", () => {
  const handler = createDefineAuthChallengeHandler();

  const round = fc.record({
    challengeName: fc.constantFrom("CUSTOM_CHALLENGE", "SRP_A", "PASSWORD_VERIFIER", "SMS_MFA", "x"),
    challengeResult: fc.boolean(),
  });

  it("P: over arbitrary session arrays, tokens are issued iff the session is exactly one successful custom round", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(round, { maxLength: 5 }), async (session) => {
        const out = await handler(makeEvent(session));
        const exactlyOneGoodCustomRound =
          session.length === 1 &&
          session[0]!.challengeName === "CUSTOM_CHALLENGE" &&
          session[0]!.challengeResult;
        expect(out.response.issueTokens === true).toBe(exactlyOneGoodCustomRound);
        // The first challenge is issued iff the session is empty; every other
        // non-token shape fails authentication.
        expect(out.response.challengeName === "CUSTOM_CHALLENGE").toBe(session.length === 0);
        expect(out.response.failAuthentication === true).toBe(
          session.length !== 0 && !exactlyOneGoodCustomRound,
        );
      }),
      { numRuns: 300 },
    );
  });

  it("a successful round that is NOT a custom challenge (e.g. SRP) gets no tokens", async () => {
    const out = await handler(makeEvent([{ challengeName: "SRP_A", challengeResult: true }]));
    expect(out.response.issueTokens).toBe(false);
    expect(out.response.failAuthentication).toBe(true);
  });

  it("a second round fails even when the last one succeeded (no extra Create, no extra mail)", async () => {
    const out = await handler(
      makeEvent([{ challengeName: "CUSTOM_CHALLENGE", challengeResult: false }, CUSTOM_OK]),
    );
    expect(out.response.issueTokens).toBe(false);
    expect(out.response.failAuthentication).toBe(true);
  });

  it("a long session of successes still fails", async () => {
    const out = await handler(makeEvent([CUSTOM_OK, CUSTOM_OK, CUSTOM_OK]));
    expect(out.response.issueTokens).toBe(false);
    expect(out.response.failAuthentication).toBe(true);
  });

  it("a malformed session (not an array, or a non-object round) fails closed without throwing", async () => {
    for (const session of [undefined, null, "x", {}, [null], [42], [undefined]]) {
      const out = await handler({
        request: { session: session as never },
        response: {},
      });
      expect(out.response.issueTokens).toBe(false);
      expect(out.response.failAuthentication).toBe(true);
    }
  });
});
