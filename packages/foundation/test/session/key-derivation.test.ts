/**
 * Tests for PBKDF2-SHA256 key derivation.
 *
 * Cross-checks WebCrypto-derived bits against Node's `crypto.pbkdf2Sync`
 * (both implement the same RFC 8018 algorithm) so we have a known-good
 * reference rather than hand-computing test vectors.
 *
 * The 600k-iteration default is exercised once (it's slow — ~60-180ms
 * on Node 24); the algorithm correctness check uses a deliberately
 * lower iteration count for speed across many vectors.
 */

import { pbkdf2Sync, webcrypto } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PBKDF2_ITERATIONS,
  deriveBitsForTesting,
  deriveKey,
} from "../../src/session/key-derivation.js";

describe("DEFAULT_PBKDF2_ITERATIONS", () => {
  it("is 600_000 (OWASP 2023 minimum)", () => {
    expect(DEFAULT_PBKDF2_ITERATIONS).toBe(600_000);
  });
});

describe("deriveBitsForTesting — algorithm correctness", () => {
  // Cross-check vectors at low iterations for speed. Validates the
  // WebCrypto plumbing against Node's pbkdf2.
  const cases = [
    { secret: "password", salt: "salt", iterations: 1, outBits: 256 },
    { secret: "password", salt: "salt", iterations: 4096, outBits: 256 },
    {
      secret: "supersecretpassphrase",
      salt: "deploymentsalt12",
      iterations: 10_000,
      outBits: 256,
    },
  ];

  for (const c of cases) {
    it(`matches Node's pbkdf2 for secret/salt/it=${String(c.iterations)}`, async () => {
      const expected = pbkdf2Sync(c.secret, c.salt, c.iterations, c.outBits / 8, "sha256");
      const actual = await deriveBitsForTesting(c.secret, c.salt, c.iterations, c.outBits);
      expect(Buffer.from(actual).equals(expected)).toBe(true);
    });
  }

  it("known-answer at the default 600_000 iterations matches Node's pbkdf2", async () => {
    const secret = "x".repeat(32);
    const salt = "y".repeat(16);
    const expected = pbkdf2Sync(secret, salt, DEFAULT_PBKDF2_ITERATIONS, 32, "sha256");
    const actual = await deriveBitsForTesting(secret, salt, DEFAULT_PBKDF2_ITERATIONS, 256);
    expect(Buffer.from(actual).equals(expected)).toBe(true);
  }, 30_000);
});

describe("deriveKey — produces a usable AES-GCM CryptoKey", () => {
  it("returned key can encrypt and decrypt", async () => {
    const key = await deriveKey("a-secret-of-sufficient-length-32", "salt-16-chars-aa", 1000);
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode("hello");
    const ciphertext = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    const decrypted = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    expect(new TextDecoder().decode(decrypted)).toBe("hello");
  });

  it("identical (secret, salt, iterations) tuples produce identical keys", async () => {
    // Two keys derived with the same inputs must encrypt the same
    // plaintext+iv to the same ciphertext.
    const k1 = await deriveKey("a-secret-of-sufficient-length-32", "salt-16-chars-aa", 1000);
    const k2 = await deriveKey("a-secret-of-sufficient-length-32", "salt-16-chars-aa", 1000);
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const pt = new TextEncoder().encode("payload");
    const c1 = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, k1, pt);
    const c2 = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, k2, pt);
    expect(Buffer.from(c1).equals(Buffer.from(c2))).toBe(true);
  });

  it("different salts produce different keys", async () => {
    const k1 = await deriveKey("a-secret-of-sufficient-length-32", "salt-AAAAAAAAAAAA", 1000);
    const k2 = await deriveKey("a-secret-of-sufficient-length-32", "salt-BBBBBBBBBBBB", 1000);
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const pt = new TextEncoder().encode("payload");
    const c1 = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, k1, pt);
    const c2 = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, k2, pt);
    expect(Buffer.from(c1).equals(Buffer.from(c2))).toBe(false);
  });
});
