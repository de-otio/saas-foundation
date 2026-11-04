/**
 * Address normalisation for the mailed-link sign-in (U18).
 *
 * One pure function, applied before ANY Cognito call by `auth-login` (both
 * enrolment modes) and again inside `createCognitoAllowList.lookup`, so the
 * address the allow-list is asked about is the address the Create trigger later
 * mails. The allow-list, `ses:Recipients` patterns and SES suppression entries
 * all compare addresses case-sensitively, so every producer must emit exactly
 * this form.
 *
 * `+tag` is NOT stripped: the person typed their address.
 */

import { Buffer } from "node:buffer";

/** RFC 5321 path limit, counted in UTF-8 octets. */
export const MAX_EMAIL_LENGTH = 254;

/** Whitespace or a control character anywhere in the address. */
const FORBIDDEN_INSIDE = /[\s\p{Cc}]/u;

/**
 * Returns the canonical form of `raw`, or `undefined` when it cannot be an
 * address: trim, Unicode NFC, lower-case the whole address, then require
 *
 * - exactly one `@`, with a non-empty local part and a non-empty domain,
 * - at most {@link MAX_EMAIL_LENGTH} UTF-8 octets,
 * - no whitespace and no control character.
 *
 * Idempotent: `normalizeEmail(normalizeEmail(x)) === normalizeEmail(x)`. NFC is
 * applied again after lower-casing because case mapping can yield a sequence
 * that is not itself NFC, which would break idempotency.
 *
 * Rejection depends only on the input, never on any account state, so a caller
 * can use it for input validation (a 400) without creating an oracle.
 */
export function normalizeEmail(raw: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().normalize("NFC").toLowerCase().normalize("NFC");
  if (Buffer.byteLength(value, "utf8") > MAX_EMAIL_LENGTH) return undefined;
  if (FORBIDDEN_INSIDE.test(value)) return undefined;
  const parts = value.split("@");
  if (parts.length !== 2) return undefined;
  const [local, domain] = parts;
  if (local === undefined || domain === undefined || local === "" || domain === "") return undefined;
  return value;
}
