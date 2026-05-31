/**
 * Minimal ulid (Universally Lexicographically-Sortable IDentifier)
 * generator.
 *
 * Spec: https://github.com/ulid/spec
 *   - 128-bit identifier
 *   - 48-bit unix-timestamp prefix (ms precision)
 *   - 80-bit random suffix
 *   - Crockford's Base32 encoding (26 characters, sorted)
 *
 * Why a local implementation rather than the `ulid` package?
 *
 * 1. Foundation already has `crypto.randomBytes` available via
 *    `node:crypto`; the npm `ulid` package adds no functionality
 *    beyond the spec for our use.
 * 2. Keeping the dependency surface small. The whole module is ~50
 *    lines of pure code.
 *
 * Impure: reads `crypto.randomBytes` for the random suffix.
 */

import { randomBytes } from "node:crypto";

/** Crockford's Base32 alphabet (excludes I, L, O, U). */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENCODING_LEN = ENCODING.length; // 32
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(timeMs: number): string {
  if (timeMs < 0 || timeMs > 0xffff_ffff_ffff) {
    throw new RangeError(`ulid: timestamp out of range (got ${String(timeMs)})`);
  }
  let mod: number;
  let str = "";
  let time = Math.floor(timeMs);
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    mod = time % ENCODING_LEN;
    str = ENCODING.charAt(mod) + str;
    time = (time - mod) / ENCODING_LEN;
  }
  return str;
}

function encodeRandom(len: number): string {
  const bytes = randomBytes(len);
  let str = "";
  for (let i = 0; i < len; i++) {
    const b = bytes[i];
    if (b === undefined) {
      throw new Error("ulid: insufficient random bytes");
    }
    str += ENCODING.charAt(b % ENCODING_LEN);
  }
  return str;
}

/**
 * Generate a new ulid. Pass `timeMs` to control the timestamp prefix
 * (useful in tests with a frozen clock); defaults to `Date.now()`.
 */
export function ulid(timeMs: number = Date.now()): string {
  return encodeTime(timeMs) + encodeRandom(RANDOM_LEN);
}
