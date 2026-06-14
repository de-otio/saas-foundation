/**
 * Bundle entry wrapper for the auth-verify regional Lambda.
 *
 * See `doc/vestibulum-cdk/10-lambda-bundle-pipeline.md`.
 */
import { createAuthVerifyHandler } from "@de-otio/vestibulum";

export const handler = createAuthVerifyHandler();
