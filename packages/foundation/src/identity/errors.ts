/**
 * Error taxonomy for the identity module (WS-3.3).
 *
 * Mirrors the shape of the other foundation module error classes: one class,
 * a typed `reason`, and a human-readable message. Callers branch on `reason`,
 * never on message text.
 */

export type IdentityProviderErrorReason =
  /** Required adapter configuration is missing/empty — fail closed at construction. */
  | "config_missing"
  /** The provider rejected our service credentials (401/403 on a provider call). */
  | "unauthorized"
  /**
   * The target user does not exist at the provider surface (e.g. p2 magic-link
   * 404 with `force_create=false`). What the APPLICATION reveals to end clients
   * is an app-layer decision (G2 C-13 / F10 account-enumeration stance) — this
   * reason must never be surfaced verbatim to an end user.
   */
  | "unknown_user"
  /** An import/create collided with an existing id/email (fail-not-overwrite, G2 C-15b). */
  | "conflict"
  /** Any other provider-side failure (5xx, network, malformed response). */
  | "provider_error";

export class IdentityProviderError extends Error {
  public readonly reason: IdentityProviderErrorReason;
  /** HTTP status from the provider, when the failure came from an HTTP call. */
  public readonly status?: number;

  constructor(reason: IdentityProviderErrorReason, message: string, status?: number) {
    super(message);
    this.name = "IdentityProviderError";
    this.reason = reason;
    if (status !== undefined) this.status = status;
  }
}
