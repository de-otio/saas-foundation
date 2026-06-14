/**
 * Bundle entry wrapper for the Cognito CreateAuthChallenge trigger.
 *
 * See `doc/vestibulum-cdk/10-lambda-bundle-pipeline.md`.
 */
import { createCreateAuthChallengeHandler } from "@de-otio/vestibulum";

export const handler = createCreateAuthChallengeHandler();
