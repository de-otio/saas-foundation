/**
 * `IdentityProviderPort` — the narrow, provider-neutral surface Trellis-class
 * consumers need from an end-user identity provider (WS-3.3; design in
 * trellis-scaleway-portability 02 §3 step 2).
 *
 * Sibling of the other foundation ports (`KvStore`, queue, storage): the port
 * lives here; adapters are `KeycloakIdentityProvider` (this module) and the
 * consumer-side Cognito adapter (in the consuming app, over its existing
 * CUSTOM_AUTH glue).
 *
 * ## Deliberately minimal
 *
 * Two methods only:
 *
 *  - `initiateMagicLink` — the one product-facing call the core makes (the
 *    passwordless sign-in initiation).
 *  - `deleteUser` — absorbs WS-2's provisional one-method `IdentityAdminPort`
 *    (X6, `apps/api/src/lib/workers/identity-admin-port.ts`). Signature kept
 *    identical (`{ email }`) so every existing WS-2 injection site satisfies
 *    the port unchanged.
 *
 * Wider admin operations (get user, sub-preserving import) are ADAPTER
 * methods, not port methods — only migration/ops tooling needs them, and
 * keeping them off the port keeps every adapter honest about what product
 * code may depend on.
 *
 * ## Continuation mode vs plain mode is NOT a port concern
 *
 * G2's C-16 proved magic-link *continuation mode* (the emailed link
 * authenticates nobody; the initiating device completes via polling) against
 * Keycloak + phasetwo. Whether a deployment runs continuation or plain mode
 * is **consumer flow configuration** (the IdP realm's authentication-flow
 * binding plus the client app's UX) — the port's `initiateMagicLink` contract
 * is identical in both modes and carries no flow-mode flag. Do not add one.
 */

export interface MagicLinkOptions {
  /** Link validity window, seconds (G2 ran 300s; S-5). */
  readonly expirationSeconds: number;
  /**
   * OAuth redirect URI the completed login lands on. Must be registered
   * exact-match on the app client (G2 C-12 — no wildcard redirect URIs).
   */
  readonly redirectUri: string;
  /** OAuth `state`, echoed on the redirect. */
  readonly state?: string;
  /** OIDC `nonce`, bound into the issued ID token. */
  readonly nonce?: string;
  /** PKCE S256 code challenge (method is always S256; never `plain`). */
  readonly codeChallenge?: string;
  /**
   * Create the user if the email is unknown. Default false — an unknown email
   * fails with `unknown_user` (what the app reveals to clients is the app's
   * account-enumeration decision, G2 C-13/F10).
   */
  readonly forceCreate?: boolean;
}

export interface MagicLinkInitiation {
  /**
   * Provider user id (the future token `sub`), when the provider returns one.
   * Cognito's client-facing CUSTOM_AUTH initiation does not.
   */
  readonly userId?: string;
  /**
   * The single-use login link, when the provider returns it for the CONSUMER
   * to deliver — the application owns the sign-in email (G2 S-8; adapters
   * must never let the IdP send its own vendor-branded mail on this path).
   * Absent when the provider's own flow performs delivery (Cognito trigger
   * chain).
   */
  readonly link?: string;
  /**
   * True when initiation itself caused the sign-in email to be sent (the
   * Cognito path: the create-auth-challenge trigger emails the link). False
   * when delivery is the caller's job (`link` is set).
   */
  readonly emailSent: boolean;
}

/**
 * Provider-neutral identity-provider port.
 *
 * Structurally a superset of WS-2's provisional `IdentityAdminPort`
 * (`deleteUser({ email })`), so any `IdentityProviderPort` implementation can
 * be injected wherever that narrow slice is required.
 */
export interface IdentityProviderPort {
  /**
   * Initiate a magic-link (passwordless) sign-in for `email`.
   *
   * Per-email rate limiting is deliberately NOT here: it is the CALLER's
   * responsibility (inherited from G2 — S-6/F5: the API in front of this port
   * enforces the per-email limit, sliding-window/token-bucket, not the port).
   *
   * @throws IdentityProviderError — `unknown_user` when the email is unknown
   *   and `forceCreate` is false; `unauthorized`/`provider_error` otherwise.
   */
  initiateMagicLink(email: string, opts: MagicLinkOptions): Promise<MagicLinkInitiation>;

  /**
   * Delete the external identity for a user (the X6 admin surface). Callers
   * treat failures as best-effort where they do today (WS-2 delete-account
   * §1.1); whether a missing user throws or no-ops is adapter-documented.
   */
  deleteUser(input: { readonly email: string }): Promise<void>;
}

/** A provider-side user record (adapter admin surface, not on the port). */
export interface IdentityUser {
  /** Provider user id — the token `sub`. Opaque; no format assumption. */
  readonly id: string;
  readonly email: string;
  /** Provider attributes (Keycloak: multi-valued user attributes). */
  readonly attributes?: Readonly<Record<string, ReadonlyArray<string>>>;
}
