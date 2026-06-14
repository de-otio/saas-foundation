/**
 * Low-level AES-256-GCM seal / unseal primitives.
 *
 * Per doc/foundation/04-session-crypto.md:
 *   - AES-256-GCM (authenticated encryption — no padding oracle).
 *   - 96-bit IV (12 bytes), randomly generated per encryption via
 *     `crypto.getRandomValues`.
 *   - GCM tag is appended to the ciphertext by the WebCrypto API;
 *     verification is constant-time (provided by the SubtleCrypto
 *     implementation — we do not roll our own).
 *   - Envelope format: [IV (12 bytes)][ciphertext + tag (variable)],
 *     then base64-encoded for cookie storage.
 *   - `unseal` returns `null` on any failure (bad MAC, wrong key,
 *     malformed input) — see errors.ts for the rationale.
 *
 * No nonce-reuse log is maintained. With a 96-bit random IV the
 * birthday bound is reached after ~2^48 encryptions per key, which
 * exceeds any realistic per-key cookie volume; rotating the secret
 * keeps the per-key count well below the bound.
 */

import { webcrypto } from "node:crypto";

const SUBTLE = webcrypto.subtle;

/** GCM standard IV length. */
const IV_LENGTH_BYTES = 12;

/**
 * Encrypt `payload` (UTF-8 bytes) under the given key. Returns the
 * base64-encoded envelope `[IV || ciphertext+tag]`.
 *
 * Throws on any underlying SubtleCrypto failure — this should be
 * unreachable for a correctly constructed key.
 */
export async function seal(payload: Uint8Array, key: webcrypto.CryptoKey): Promise<string> {
  const iv = webcrypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
  // Copy into a fresh ArrayBuffer-backed view: @types/node 25 types the
  // subtle data param as BufferSource, which a Uint8Array<ArrayBufferLike>
  // (possibly SharedArrayBuffer-backed) is not assignable to.
  const ciphertext = await SUBTLE.encrypt({ name: "AES-GCM", iv }, key, new Uint8Array(payload));
  const envelope = new Uint8Array(IV_LENGTH_BYTES + ciphertext.byteLength);
  envelope.set(iv, 0);
  envelope.set(new Uint8Array(ciphertext), IV_LENGTH_BYTES);
  return Buffer.from(envelope).toString("base64");
}

/**
 * Decrypt a base64-encoded envelope. Returns the plaintext bytes, or
 * `null` on any failure:
 *   - base64 input was malformed
 *   - envelope shorter than IV length
 *   - GCM authentication tag did not verify
 *   - wrong key
 *
 * The failure modes intentionally collapse to a single `null` so an
 * attacker cannot distinguish "wrong key" from "tampered ciphertext"
 * from "your client truncated the cookie."
 */
export async function unseal(token: string, key: webcrypto.CryptoKey): Promise<Uint8Array | null> {
  let envelope: Buffer;
  try {
    envelope = Buffer.from(token, "base64");
  } catch {
    return null;
  }

  if (envelope.length <= IV_LENGTH_BYTES) {
    return null;
  }

  // Fresh ArrayBuffer-backed copies: @types/node 25 types the subtle
  // params as BufferSource, to which a Buffer<ArrayBufferLike> view over
  // the envelope is not assignable.
  const iv = new Uint8Array(envelope.subarray(0, IV_LENGTH_BYTES));
  const ciphertext = new Uint8Array(envelope.subarray(IV_LENGTH_BYTES));

  try {
    const plaintext = await SUBTLE.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new Uint8Array(plaintext);
  } catch {
    // SubtleCrypto's decrypt throws on tag mismatch, key mismatch, or
    // malformed input. Collapse all to null per the design.
    return null;
  }
}
