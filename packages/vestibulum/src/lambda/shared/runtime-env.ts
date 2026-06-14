/**
 * Environment variable name constants read by all bundled Lambda handlers.
 *
 * This is the single source of truth for env-var names. Construct workstreams
 * write these onto handler environments; handler workstreams read from this
 * file. Neither side hard-codes strings.
 *
 * All names are prefixed with `VESTIBULUM_` to avoid collisions with consumer
 * environment variables.
 */
export const RuntimeEnv = {
  /** DynamoDB table name for single-use magic-link tokens. */
  TOKEN_TABLE_NAME: "VESTIBULUM_TOKEN_TABLE",

  /**
   * DynamoDB table name for per-email rate limiting in CreateAuthChallenge.
   * Separate from the token table so rate-limit data never touches token rows.
   */
  RATE_LIMIT_TABLE_NAME: "VESTIBULUM_RATE_LIMIT_TABLE",

  /**
   * DynamoDB table name for the bounce/complaint denylist.
   * Populated by the bounce-handler Lambda; checked before every SES send.
   */
  DENYLIST_TABLE_NAME: "VESTIBULUM_DENYLIST_TABLE",

  /** Cognito User Pool ID, used by triggers and auth-verify. */
  COGNITO_USER_POOL_ID: "VESTIBULUM_USER_POOL_ID",

  /** Cognito App Client ID for the website client created by MagicLinkAuthSite. */
  COGNITO_CLIENT_ID: "VESTIBULUM_CLIENT_ID",

  /** SES "From" address for outbound magic-link emails. */
  SES_FROM: "VESTIBULUM_SES_FROM",

  /**
   * AWS region in which SES sends originate.
   * MagicLinkIdentity sets this to the identity stack's region; the edge
   * function reads it to route presigned requests.
   */
  SES_REGION: "VESTIBULUM_SES_REGION",

  /** The public-facing domain (e.g. `app.example.com`). */
  DOMAIN: "VESTIBULUM_DOMAIN",

  /**
   * Magic-link token TTL in minutes. Matches MagicLinkIdentityProps.tokenTtlMinutes.
   * Injected at synth time so the handler doesn't need to read CDK context.
   */
  TOKEN_TTL_MINUTES: "VESTIBULUM_TOKEN_TTL_MINUTES",

  /**
   * Maximum magic-link sends per email per rate-limit window.
   * Injected at synth time from MagicLinkIdentityProps.tokenSendsPerWindow.
   */
  TOKEN_SENDS_PER_WINDOW: "VESTIBULUM_TOKEN_SENDS_PER_WINDOW",

  /**
   * Maximum sign-up attempts per email per rate-limit window.
   * Injected at synth time from MagicLinkIdentityProps.signUpsPerWindow.
   */
  SIGN_UPS_PER_WINDOW: "VESTIBULUM_SIGN_UPS_PER_WINDOW",

  /**
   * Allowed email domains for the PreSignUp allowlist (JSON-encoded string[]).
   * Injected at synth time from MagicLinkIdentityProps.allowedEmailDomains.
   */
  ALLOWED_EMAIL_DOMAINS: "VESTIBULUM_ALLOWED_EMAIL_DOMAINS",

  /**
   * Signup-mode flag for the PreSignUp Lambda.
   *
   * Values:
   *   - `'open'` (default): user-initiated signups are subject only to the
   *     domain allowlist + rate-limit checks.
   *   - `'admin-invite-only'`: `PreSignUp_SignUp` is rejected outright;
   *     `PreSignUp_AdminCreateUser` and `PreSignUp_ExternalProvider`
   *     continue past this guard to the domain/rate-limit checks (federated
   *     users are allowed; only self-registration is blocked).
   *
   * Load-bearing for B2B-pool bootstrap-site security per
   * doc/federation/07-pool-topology.md. Injected at synth time from
   * MagicLinkAuthSiteProps.signupMode.
   */
  SIGNUP_MODE: "VESTIBULUM_SIGNUP_MODE",

  /**
   * HMAC-SHA-256 secret used by the bounce-handler to hash email addresses
   * before writing them to logs or the denylist table.
   *
   * Never log raw email addresses — only log the HMAC hash. This key must be
   * unique per deployment and rotated on a schedule consistent with the
   * consumer's security policy.
   */
  BOUNCE_HMAC_SECRET: "VESTIBULUM_BOUNCE_HMAC_SECRET",
} as const;

/** Union of all known runtime environment variable names. */
export type RuntimeEnvKey = (typeof RuntimeEnv)[keyof typeof RuntimeEnv];
