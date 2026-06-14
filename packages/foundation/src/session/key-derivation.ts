/**
 * PBKDF2-SHA256 key derivation for AES-256-GCM session cookies.
 *
 * Per doc/foundation/04-session-crypto.md and review S-Sec4: iterations
 * default to **600,000** (OWASP 2023 minimum for PBKDF2-HMAC-SHA-256).
 *
 * Trellis's current 100k is below the modern floor; the port raises
 * the default. Consumers may pass a higher value via the
 * `iterations` parameter; passing a lower value throws
 * `SessionCookieConfigError` at construction (enforced in cookie.ts).
 *
 * The cold-start budget grew with the iteration count — see the
 * "PBKDF2 is intentionally slow" caveat in the design doc.
 *
 * This module uses Node's WebCrypto (`crypto.subtle`) directly so it
 * works under both Node 24 and Workers-shaped runtimes (the
 * Cloudflare-compat hedge in doc/01-scope-and-philosophy.md).
 */

import { webcrypto } from "node:crypto";

const SUBTLE = webcrypto.subtle;

/** OWASP 2023 minimum for PBKDF2-HMAC-SHA-256. */
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;

/** Output length in bits. AES-256-GCM uses a 256-bit key. */
const KEY_LENGTH_BITS = 256;

/**
 * Derive a 256-bit AES-GCM key from a UTF-8 secret + UTF-8 salt.
 *
 * Returns a `CryptoKey` ready for `encrypt` / `decrypt` operations.
 * Re-deriving the key on every call is intentional (no in-class
 * cache) — see the design doc's open question on `CryptoKey` caching.
 */
export async function deriveKey(
  secret: string,
  salt: string,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS,
): Promise<webcrypto.CryptoKey> {
  const secretBytes = new TextEncoder().encode(secret);
  const saltBytes = new TextEncoder().encode(salt);
  const baseKey = await SUBTLE.importKey("raw", secretBytes, { name: "PBKDF2" }, false, [
    "deriveKey",
  ]);
  return SUBTLE.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: KEY_LENGTH_BITS },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Derive raw PBKDF2 bytes (without wrapping in a CryptoKey). For
 * test/known-answer-vector use only. Production code paths use
 * `deriveKey` so the key never leaves WebCrypto's protected boundary.
 */
export async function deriveBitsForTesting(
  secret: string,
  salt: string,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS,
  outputBits: number = KEY_LENGTH_BITS,
): Promise<Uint8Array> {
  const secretBytes = new TextEncoder().encode(secret);
  const saltBytes = new TextEncoder().encode(salt);
  const baseKey = await SUBTLE.importKey("raw", secretBytes, { name: "PBKDF2" }, false, [
    "deriveBits",
  ]);
  const bits = await SUBTLE.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    outputBits,
  );
  return new Uint8Array(bits);
}
