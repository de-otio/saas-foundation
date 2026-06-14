/**
 * Bundle entry wrapper for the auth-signout regional Lambda.
 *
 * See `doc/vestibulum-cdk/10-lambda-bundle-pipeline.md`.
 */
import { createAuthSignoutHandler } from "@de-otio/vestibulum";

export const handler = createAuthSignoutHandler();
