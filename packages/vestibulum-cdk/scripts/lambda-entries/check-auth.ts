/**
 * Bundle entry wrapper for the Lambda@Edge check-auth handler.
 *
 * Lambda@Edge specifics (see `doc/vestibulum-cdk/10-lambda-bundle-pipeline.md`):
 * - bundled with `drop: ['console']` to enforce log-suppression at build time.
 * - `aws-jwt-verify` is NOT externalised — L@E does not provide it.
 * - target is `node20` (L@E coverage); the regional bundles use `node22`.
 */
import { createEdgeCheckAuthHandler } from "@de-otio/vestibulum";

export const handler = createEdgeCheckAuthHandler();
