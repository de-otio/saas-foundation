/**
 * Bundle entry wrapper for the Cognito DefineAuthChallenge trigger.
 *
 * See `doc/vestibulum-cdk/10-lambda-bundle-pipeline.md`.
 */
import { createDefineAuthChallengeHandler } from "@de-otio/vestibulum";

export const handler = createDefineAuthChallengeHandler();
