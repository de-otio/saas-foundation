/**
 * Tests for the low-level AES-256-GCM seal/unseal primitives.
 *
 * Property-based round-trip + tampering invariants. No real network,
 * no real time.
 */

import { webcrypto } from "node:crypto";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { seal, unseal } from "../../src/session/crypto.js";

const SUBTLE = webcrypto.subtle;

async function makeKey(): Promise<CryptoKey> {
  return SUBTLE.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

describe("seal / unseal — round-trip", () => {
  it("round-trips a short payload", async () => {
    const key = await makeKey();
    const payload = new TextEncoder().encode("hello world");
    const sealed = await seal(payload, key);
    const unsealed = await unseal(sealed, key);
    if (unsealed === null) throw new Error("expected unseal to succeed");
    expect(new TextDecoder().decode(unsealed)).toBe("hello world");
  });

  it("round-trips an empty payload", async () => {
    const key = await makeKey();
    const sealed = await seal(new Uint8Array(0), key);
    const unsealed = await unseal(sealed, key);
    if (unsealed === null) throw new Error("expected unseal to succeed");
    expect(unsealed.length).toBe(0);
  });

  it("produces distinct ciphertext for the same payload (random IV)", async () => {
    const key = await makeKey();
    const payload = new TextEncoder().encode("static-payload");
    const a = await seal(payload, key);
    const b = await seal(payload, key);
    expect(a).not.toBe(b);
  });

  it("returns null when the key does not match", async () => {
    const keyA = await makeKey();
    const keyB = await makeKey();
    const sealed = await seal(new TextEncoder().encode("foo"), keyA);
    const unsealed = await unseal(sealed, keyB);
    expect(unsealed).toBeNull();
  });
});

describe("seal / unseal — tampering", () => {
  it("returns null when one byte of the ciphertext is flipped", async () => {
    const key = await makeKey();
    const sealed = await seal(new TextEncoder().encode("attack at dawn"), key);
    const bytes = Buffer.from(sealed, "base64");
    // Flip a byte in the ciphertext region (after the 12-byte IV)
    const targetByte = 12 + 2;
    bytes[targetByte] = (bytes[targetByte] ?? 0) ^ 0x01;
    const tampered = bytes.toString("base64");
    const unsealed = await unseal(tampered, key);
    expect(unsealed).toBeNull();
  });

  it("returns null when one byte of the GCM tag is flipped", async () => {
    const key = await makeKey();
    const sealed = await seal(new TextEncoder().encode("payload"), key);
    const bytes = Buffer.from(sealed, "base64");
    // GCM tag is the last 16 bytes of the ciphertext segment.
    const tagByteIdx = bytes.length - 1;
    bytes[tagByteIdx] = (bytes[tagByteIdx] ?? 0) ^ 0x80;
    const tampered = bytes.toString("base64");
    const unsealed = await unseal(tampered, key);
    expect(unsealed).toBeNull();
  });

  it("returns null when one byte of the IV is flipped", async () => {
    const key = await makeKey();
    const sealed = await seal(new TextEncoder().encode("payload"), key);
    const bytes = Buffer.from(sealed, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 0x01;
    const tampered = bytes.toString("base64");
    const unsealed = await unseal(tampered, key);
    expect(unsealed).toBeNull();
  });

  it("returns null for malformed base64", async () => {
    const key = await makeKey();
    // Buffer.from is lenient with base64, so we need an envelope that
    // decodes to fewer than IV+1 bytes.
    const unsealed = await unseal("AAAA", key);
    expect(unsealed).toBeNull();
  });

  it("returns null for an empty envelope", async () => {
    const key = await makeKey();
    const unsealed = await unseal("", key);
    expect(unsealed).toBeNull();
  });

  it("returns null for envelope shorter than IV length", async () => {
    const key = await makeKey();
    const tooShort = Buffer.from(new Uint8Array(6)).toString("base64");
    const unsealed = await unseal(tooShort, key);
    expect(unsealed).toBeNull();
  });
});

describe("seal / unseal — property-based", () => {
  const RUN_OPTIONS = { numRuns: 50, seed: 0xabcdef } as const;

  it("round-trips any Buffer payload of length 0..4096", async () => {
    const key = await makeKey();
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 0, maxLength: 4096 }), async (bytes) => {
        const sealed = await seal(bytes, key);
        const unsealed = await unseal(sealed, key);
        if (unsealed === null) throw new Error("expected unseal to succeed");
        expect(Array.from(unsealed)).toEqual(Array.from(bytes));
      }),
      RUN_OPTIONS,
    );
  });
});
