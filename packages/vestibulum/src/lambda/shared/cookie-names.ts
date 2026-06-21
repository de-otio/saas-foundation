/**
 * cookie-names.ts — the single source of truth for the auth cookie names.
 *
 * Three components must agree on these names or auth silently breaks:
 *   - `auth-verify` / `auth-login` SET them (regional Lambda),
 *   - `auth-signout` CLEARS them (regional Lambda),
 *   - `check-auth` READS the ID-token cookie (Lambda@Edge viewer-request).
 *
 * They were previously duplicated as string literals across handlers, and the
 * edge `check-auth` default drifted to `vestibulum_id_token` while the regional
 * handlers used `id-token` — so the edge gate could never find the cookie. Keep
 * every reference pointed here.
 *
 * Plain string constants only: this module is imported into the Lambda@Edge
 * bundle, which is size- and dependency-constrained.
 */

/** HttpOnly cookie holding the Cognito ID token; read by the edge `check-auth` gate. */
export const ID_TOKEN_COOKIE_NAME = "id-token";

/** HttpOnly cookie holding the Cognito refresh token (scoped to `/auth-verify`). */
export const REFRESH_TOKEN_COOKIE_NAME = "refresh-token";
