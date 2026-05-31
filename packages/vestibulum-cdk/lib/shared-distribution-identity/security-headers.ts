/**
 * Default `ResponseHeadersPolicy` for the shared-distribution
 * CloudFront. Implements review fix H4 per
 * `doc/vestibulum/shared-distribution/04-multi-aud-edge-check.md` §
 * Security headers.
 *
 * Posture (browser-visible login pages run behind this):
 *
 * - **HSTS**: max-age 2 years (730 days), includeSubdomains, preload.
 * - **CSP**: tight default — `default-src 'self'`, no inline scripts,
 *   no remote eval; `frame-ancestors 'none'`; `form-action 'self'`.
 * - **X-Frame-Options**: `DENY`.
 * - **X-Content-Type-Options**: `nosniff`.
 * - **Referrer-Policy**: `strict-origin-when-cross-origin`.
 * - **Permissions-Policy**: `accelerometer=()`, `camera=()`,
 *   `geolocation=()`, `microphone=()`, `payment=()` — all default-off.
 *
 * Both a singleton-style export (`DEFAULT_*` constants) and a factory
 * (`createDefaultResponseHeadersPolicy`) are provided so consumers
 * either accept the default outright or extend it without duplicating
 * the CSP string.
 *
 * The construct accepts `responseHeadersPolicy` as a prop; the default
 * factory below is what gets used when the prop is unset.
 */

import { Duration, aws_cloudfront as cloudfront } from "aws-cdk-lib";
import { Construct } from "constructs";

/**
 * The CSP value applied by default. Tight by intent — the login pages
 * shipped with vestibulum-cdk use no inline JS, no remote scripts, and
 * inline `<style>` only (so `style-src 'self' 'unsafe-inline'`).
 *
 * Consumers who override the login pages with code that needs more
 * relaxed CSP MUST pass their own `ResponseHeadersPolicy`.
 */
export const DEFAULT_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

/**
 * The Permissions-Policy header. All five listed features default-off.
 * Adding a feature here is a security-policy decision — extending the
 * list does NOT require a consumer-side opt-out.
 */
export const DEFAULT_PERMISSIONS_POLICY = [
  "accelerometer=()",
  "camera=()",
  "geolocation=()",
  "microphone=()",
  "payment=()",
].join(", ");

/**
 * HSTS `max-age` for the default. 730 days = 2 years; preloaded so
 * browsers ship the policy in their preload list (one-way commitment).
 */
export const DEFAULT_HSTS_MAX_AGE_DAYS = 730;

export interface CreateDefaultResponseHeadersPolicyOptions {
  /**
   * Optional name prefix for the resource. Defaults to
   * `'VestibulumSharedDistribution'` so the resource is recognisable
   * in the console.
   */
  readonly resourceNamePrefix?: string;
  /**
   * Override the CSP body. When unset, {@link DEFAULT_CONTENT_SECURITY_POLICY}
   * is applied.
   */
  readonly contentSecurityPolicy?: string;
}

/**
 * Create the default {@link cloudfront.ResponseHeadersPolicy} as
 * documented in `04-multi-aud-edge-check.md` § Security headers.
 *
 * Consumers who want different headers should either pass their own
 * `ResponseHeadersPolicy` to the construct or wrap this function and
 * tweak the returned instance via CDK escape hatches.
 */
export function createDefaultResponseHeadersPolicy(
  scope: Construct,
  id: string,
  options: CreateDefaultResponseHeadersPolicyOptions = {},
): cloudfront.ResponseHeadersPolicy {
  const csp = options.contentSecurityPolicy ?? DEFAULT_CONTENT_SECURITY_POLICY;
  const prefix = options.resourceNamePrefix ?? "VestibulumSharedDistribution";
  return new cloudfront.ResponseHeadersPolicy(scope, id, {
    responseHeadersPolicyName: `${prefix}-SecurityHeaders-${scope.node.addr.slice(0, 8)}`,
    comment: `${prefix} default security headers (HSTS preload 2y, strict CSP, X-Frame-Options DENY).`,
    securityHeadersBehavior: {
      strictTransportSecurity: {
        accessControlMaxAge: Duration.days(DEFAULT_HSTS_MAX_AGE_DAYS),
        includeSubdomains: true,
        preload: true,
        override: true,
      },
      contentTypeOptions: { override: true },
      frameOptions: {
        frameOption: cloudfront.HeadersFrameOption.DENY,
        override: true,
      },
      referrerPolicy: {
        referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
        override: true,
      },
      xssProtection: { protection: true, modeBlock: true, override: true },
      contentSecurityPolicy: {
        contentSecurityPolicy: csp,
        override: true,
      },
    },
    customHeadersBehavior: {
      customHeaders: [
        {
          header: "Permissions-Policy",
          value: DEFAULT_PERMISSIONS_POLICY,
          override: true,
        },
      ],
    },
  });
}
