/**
 * Public surface of the shared-distribution edge Lambda@Edge package.
 *
 * The CDK construct (P2b) bundles the `check-auth` handler into a
 * `cloudfront.experimental.EdgeFunction`. Only the handler is part of
 * the public contract; everything else is internal.
 */

export { handler } from './check-auth.js';
