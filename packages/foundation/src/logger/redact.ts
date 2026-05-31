/**
 * pino redact paths for known PII / sensitive keys.
 *
 * Per S-F10: the path globs must be spelled out explicitly (not referenced
 * via a shared audit denylist). The two lists are intentionally separate
 * because the logger sees deeply-nested objects and uses pino's glob-path
 * syntax, while the audit PII filter sees a flat metadata record and uses
 * top-level key matching.
 *
 * Extend by passing a wider `paths` array to `configureRootLogger` — the
 * call replaces rather than merges.
 *
 * Per the spec (07-logger-and-request-context.md § Sanitisation), the
 * default list also includes `req.headers.authorization` and the
 * dot-notation variants for common HTTP header structures.
 */

/**
 * Default pino redact paths. Every entry uses pino's wildcard glob syntax.
 * `*.foo` matches any nested `foo` key at any depth.
 */
export const DEFAULT_REDACT_PATHS: ReadonlyArray<string> = Object.freeze([
  // Generic credential fields at any depth
  "*.password",
  "*.token",
  "*.secret",
  "*.access_token",
  "*.refresh_token",
  "*.authorization",
  "*.cookie",
  "*.session",
  "*.api_key",
  "*.apiKey",
  "*.client_secret",
  "*.clientSecret",
  "*.private_key",
  "*.privateKey",
  "*.ssn",
  "*.creditCard",
  "*.credit_card",
  "*.cvv",
  // Explicit HTTP header paths (pino uses dot-notation for object paths)
  "req.headers.authorization",
  "req.headers.cookie",
  "request.headers.authorization",
  "request.headers.cookie",
]);

/**
 * Default pino redact configuration object.
 * The censor string is `[REDACTED]` — deliberately not `***` so it is
 * recognisable as an intentional redaction, not a missing value.
 */
export const DEFAULT_REDACT_CONFIG = Object.freeze({
  paths: DEFAULT_REDACT_PATHS as string[],
  censor: "[REDACTED]",
});
