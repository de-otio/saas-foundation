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
