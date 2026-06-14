/**
 * Bundle entry wrapper for the shared-distribution reconciler Lambda.
 *
 * The reconciler handler is a scheduled Lambda (EventBridge `rate(1 hour)`)
 * that detects orphaned Cognito app clients and ClientConfig rows.
 *
 * See doc/vestibulum-cdk/10-lambda-bundle-pipeline.md and
 *     doc/vestibulum/shared-distribution/03-tenant-onboarding.md § Reconciler.
 */
export { handler } from "../../../vestibulum/src/lambda/shared-distribution/admin/reconciler.js";
