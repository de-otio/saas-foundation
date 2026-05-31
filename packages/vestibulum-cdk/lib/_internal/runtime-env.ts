/**
 * Environment variable names read by the bundled Lambda handlers.
 *
 * Single source of truth: construct workstreams write these names onto
 * handler environments; handler workstreams read from this file (via
 * the shared package). Neither side hard-codes strings.
 *
 * All names are prefixed with `VESTIBULUM_` to avoid collisions with
 * consumer env vars.
 */
export const RuntimeEnv = {
  /** DynamoDB table name for single-use magic-link tokens. */
  TOKEN_TABLE_NAME: "VESTIBULUM_TOKEN_TABLE",
  /** DynamoDB table for per-email rate limiting in CreateAuthChallenge. */
  RATE_LIMIT_TABLE_NAME: "VESTIBULUM_RATE_LIMIT_TABLE",
  /** DynamoDB table for the bounce/complaint denylist. */
  DENYLIST_TABLE_NAME: "VESTIBULUM_DENYLIST_TABLE",
  /** Cognito User Pool ID, used by triggers, auth-verify, and check-auth. */
  COGNITO_USER_POOL_ID: "VESTIBULUM_USER_POOL_ID",
  /** Cognito App Client ID for the website client. */
  COGNITO_CLIENT_ID: "VESTIBULUM_CLIENT_ID",
  /** SES `From` address for outbound magic-link emails. */
  SES_FROM: "VESTIBULUM_SES_FROM",
  /** AWS region in which SES sends originate. */
  SES_REGION: "VESTIBULUM_SES_REGION",
  /** The public-facing domain (e.g. `app.example.com`). */
  DOMAIN: "VESTIBULUM_DOMAIN",
  /** Magic-link token TTL in minutes. */
  TOKEN_TTL_MINUTES: "VESTIBULUM_TOKEN_TTL_MINUTES",
  /** Max magic-link sends per email per rate-limit window. */
  TOKEN_SENDS_PER_WINDOW: "VESTIBULUM_TOKEN_SENDS_PER_WINDOW",
  /** Max sign-up attempts per email per rate-limit window. */
  SIGN_UPS_PER_WINDOW: "VESTIBULUM_SIGN_UPS_PER_WINDOW",
  /** Allowed email domains for the PreSignUp allowlist (JSON-encoded). */
  ALLOWED_EMAIL_DOMAINS: "VESTIBULUM_ALLOWED_EMAIL_DOMAINS",
  /** Signup-mode flag (`'open'` | `'admin-invite-only'`). */
  SIGNUP_MODE: "VESTIBULUM_SIGNUP_MODE",
  /** HMAC-SHA-256 secret used by the bounce-handler to hash email addresses. */
  BOUNCE_HMAC_SECRET: "VESTIBULUM_BOUNCE_HMAC_SECRET",
  /** CloudWatch metrics namespace used by the regional handlers. */
  METRICS_NAMESPACE: "VESTIBULUM_METRICS_NAMESPACE",
  /**
   * Shared-distribution `ClientConfig` table name. Read by the shared
   * trigger handlers (PreSignUp, CreateAuthChallenge, PreTokenGeneration,
   * auth-verify, auth-signout) and the admin Lambda (write).
   */
  CLIENT_CONFIG_TABLE: "VESTIBULUM_CLIENT_CONFIG_TABLE",
  /**
   * Shared-distribution tenant parent subdomain
   * (e.g. `tenants.example.com`). Read by `auth-verify` and
   * `auth-signout` to extract the leftmost label from the `Host` header.
   */
  TENANT_PARENT: "VESTIBULUM_TENANT_PARENT",
  /**
   * Shared-distribution reservations table name. Used by the admin
   * Lambda's `createTenant` to atomically reserve a subdomain +
   * tenantId pair before calling Cognito.
   */
  RESERVATIONS_TABLE: "VESTIBULUM_RESERVATIONS_TABLE",
} as const;

export type RuntimeEnvKey = (typeof RuntimeEnv)[keyof typeof RuntimeEnv];
