/**
 * Bundle entry wrapper for the Cognito PreSignUp trigger.
 *
 * Imports the factory from `@de-otio/vestibulum` and re-exports a `handler`
 * function for esbuild to bundle into `lambda-bundles/pre-signup/index.mjs`.
 *
 * The wrapper exists so the build script has a stable entry point per
 * trigger, decoupled from however `@de-otio/vestibulum` lays out its
 * exports internally — see `doc/vestibulum-cdk/10-lambda-bundle-pipeline.md`.
 */
import { createPreSignupHandler } from "@de-otio/vestibulum";

export const handler = createPreSignupHandler();
