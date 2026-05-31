/**
 * Type declarations for the synth-time generated `edge-config.ts` module.
 *
 * Lambda@Edge does not support environment variables
 * ([AWS docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-at-edge-function-restrictions.html)),
 * so the construct's bundle pipeline (P2b) generates
 * `./generated/edge-config.ts` at synth time with concrete values for the
 * tenant parent domain, tenant pattern, Cognito pool issuer, and JWKS
 * coordinates. This file declares the public SHAPE the handler imports.
 *
 * The placeholder file at `./generated/edge-config.ts` is committed so the
 * package typechecks and runs tests without a synth step.
 */

/**
 * Concrete config shape baked into the bundle. The construct emits a module
 * with the same exported names; this interface is for callers that want to
 * pass the config around as a value (tests, primarily).
 */
export interface EdgeConfig {
  /** Apex domain under which tenant subdomains live (no trailing dot). */
  readonly TENANT_PARENT: string;
  /** Regex that valid tenant subdomain labels must match. */
  readonly TENANT_PATTERN: RegExp;
  /** Expected `iss` claim value: `https://cognito-idp.<region>.amazonaws.com/<poolId>`. */
  readonly POOL_ISSUER: string;
  /** Full JWKS URL for the pool. */
  readonly JWKS_URL: string;
  /** Cache TTL for the JWKS in milliseconds. */
  readonly JWKS_TTL_MS: number;
}
