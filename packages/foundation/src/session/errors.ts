/**
 * Named error types for the session crypto module.
 *
 * Per the design (doc/foundation/04-session-crypto.md), `unseal` /
 * `unsealJson` return `null` on the common failure modes (bad MAC,
 * wrong key, malformed ciphertext) — those failure modes are
 * intentionally indistinguishable to the caller, since a typed error
 * here would tempt callers to distinguish "wrong key" from "tampered
 * ciphertext," which leaks information.
 *
 * The errors below cover the cases where `null` is the WRONG answer:
 *
 *   - `SealError` — encryption failed (cryptographic primitive threw,
 *     PBKDF2 failed, etc.). Indicates a programming or configuration
 *     bug, not adversarial input.
 *   - `UnsealError` — `unsealJson` could not return either a valid
 *     payload OR a typed `null`. Currently only raised when the
 *     provided Zod schema rejects an otherwise-decryptable payload —
 *     a freshly-minted cookie should never fail validation if the
 *     consumer's types are coherent; failure here means either the
 *     consumer's schema drifted from the writer's, OR an attacker who
 *     obtained the session secret minted a payload of an unexpected
 *     shape (per review S-Sec3).
 *   - `SessionCookieConfigError` — invalid constructor input
 *     (secret too short, salt too short, etc.).
 */

export class SealError extends Error {
  override readonly name = "SealError" as const;
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export class UnsealError extends Error {
  override readonly name = "UnsealError" as const;
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export class SessionCookieConfigError extends Error {
  override readonly name = "SessionCookieConfigError" as const;
}
