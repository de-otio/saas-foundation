/**
 * Bundle entry wrapper for the shared-distribution `auth-signout` Function URL
 * Lambda (the multi-tenant variant).
 *
 * Distinct from the single-tenant `auth-signout` bundle: that one wraps the
 * `@de-otio/vestibulum` barrel export (`handlers/auth-signout`). This one wraps
 * the shared-distribution trigger, which reads the tenant `Host` header and
 * loads per-tenant ClientConfig from DynamoDB. It is not exported through the
 * main barrel — it lives in the internal shared-distribution handler tree.
 *
 * See doc/vestibulum-cdk/10-lambda-bundle-pipeline.md and
 *     doc/vestibulum/shared-distribution/06-trigger-handlers.md.
 */
export { handler } from "../../../vestibulum/src/lambda/shared-distribution/triggers/auth-signout.js";
