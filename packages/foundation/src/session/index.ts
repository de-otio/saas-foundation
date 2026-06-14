/**
 * `@de-otio/saas-foundation/session` — module barrel.
 *
 * Hand-curated per the foundation conventions; `export *` is forbidden.
 */

export {
  SessionCookie,
  parseCookieHeader,
  serializeSetCookie,
  MIN_SECRET_LENGTH,
  MIN_SALT_LENGTH,
  type SessionCookieConfig,
  type CookieAttributes,
} from "./cookie.js";

export { DEFAULT_PBKDF2_ITERATIONS, deriveKey } from "./key-derivation.js";

export { SessionCookieConfigSchema } from "./schemas.js";

export { SealError, UnsealError, SessionCookieConfigError } from "./errors.js";
