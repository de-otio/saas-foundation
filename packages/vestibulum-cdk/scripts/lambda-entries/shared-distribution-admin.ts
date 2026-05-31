/**
 * Bundle entry wrapper for the shared-distribution admin Lambda.
 *
 * The admin handler is a self-contained Function URL handler (IAM auth).
 * It is not (yet) exported through @de-otio/vestibulum's main barrel —
 * it lives in the internal shared-distribution handler tree.
 *
 * See doc/vestibulum-cdk/10-lambda-bundle-pipeline.md and
 *     doc/vestibulum/shared-distribution/03-tenant-onboarding.md.
 */
export { handler } from "../../../vestibulum/src/lambda/shared-distribution/admin/index.js";
