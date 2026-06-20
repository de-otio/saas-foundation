/**
 * Bundle entry wrapper for the auth-login regional Lambda.
 *
 * Unlike `auth-verify` / `auth-signout` (which re-export factories from
 * the `@de-otio/vestibulum` barrel), `createAuthLoginHandler` is not yet
 * surfaced on the barrel — it is imported directly from the single-tenant
 * handler module. The single-tenant handlers export FACTORIES, so this
 * entry instantiates the handler at module load.
 *
 * See `doc/vestibulum-cdk/10-lambda-bundle-pipeline.md`.
 */
import { createAuthLoginHandler } from "../../../vestibulum/src/lambda/handlers/auth-login/index.js";

export const handler = createAuthLoginHandler();
