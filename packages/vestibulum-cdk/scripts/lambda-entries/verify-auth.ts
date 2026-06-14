/**
 * Bundle entry wrapper for the Cognito VerifyAuthChallengeResponse trigger.
 *
 * See `doc/vestibulum-cdk/10-lambda-bundle-pipeline.md`.
 */
import { createVerifyAuthChallengeResponseHandler } from "@de-otio/vestibulum";

export const handler = createVerifyAuthChallengeResponseHandler();
