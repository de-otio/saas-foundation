/**
 * `PiiFilter` — pre-persistence scrub of `AuditEvent.metadata`.
 *
 * Removes / redacts keys matching a configurable denylist. The filter
 * does NOT touch top-level `AuditEvent` fields:
 *   - `ipAddress` is scrubbed by region policy BEFORE the event is
 *     constructed (see `doc/foundation/11-ip-derivation.md`).
 *   - `userAgent` is full-fidelity by design (UA mismatch is a
 *     session-takeover signal).
 *
 * The filter is recursive: nested objects and array elements are
 * traversed so a key-match in a deep position still triggers
 * redaction. Strings outside `metadata` are passed through unchanged.
 *
 * Strategies:
 *   - `'redact'` (default): replace matching values with `[REDACTED]`
 *   - `'drop'`:             remove the key entirely
 *
 * Pure, side-effect free. The instance is reusable across calls; the
 * input object is not mutated.
 */

import type { JsonValue } from "../types/frozen/audit.js";

/** Default denylist of well-known PII / secret key names. Lower-cased. */
export const DEFAULT_PII_KEYS: ReadonlyArray<string> = Object.freeze([
  "password",
  "pwd",
  "passwd",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "secret",
  "api_key",
  "apikey",
  "authorization",
  "cookie",
  "session",
  "session_id",
  "set_cookie",
  // 'email' is allowed — audit needs principal identity.
  // 'email_raw' is for handlers that explicitly distinguish a raw,
  // unmasked email from a hashed/keyed identifier.
  "email_raw",
  "ssn",
  "credit_card",
  "card_number",
]);

const REDACTED_SENTINEL = "[REDACTED]";

export type PiiFilterStrategy = "redact" | "drop";

export interface PiiFilterOptions {
  /**
   * Replace the default denylist. Compared case-insensitively against
   * the keys of every nested object inside `metadata`.
   */
  readonly keys?: ReadonlyArray<string>;

  /**
   * Add to the default denylist (instead of replacing). Useful for
   * "the defaults plus my consumer-specific fields".
   */
  readonly additionalKeys?: ReadonlyArray<string>;

  /** `'redact'` (default) replaces values; `'drop'` removes them. */
  readonly strategy?: PiiFilterStrategy;
}

export class PiiFilter {
  private readonly denylist: ReadonlySet<string>;
  private readonly strategy: PiiFilterStrategy;

  public constructor(options: PiiFilterOptions = {}) {
    const base = options.keys !== undefined ? options.keys : DEFAULT_PII_KEYS;
    const extra = options.additionalKeys ?? [];
    this.denylist = new Set([...base, ...extra].map((k) => k.toLowerCase()));
    this.strategy = options.strategy ?? "redact";
  }

  /**
   * Apply the filter to a metadata object. Returns a new object;
   * never mutates the input. Pure.
   */
  public apply(metadata: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> {
    return this.scrubObject(metadata);
  }

  private scrubObject(input: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
    const out: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(input)) {
      if (this.denylist.has(key.toLowerCase())) {
        if (this.strategy === "redact") {
          out[key] = REDACTED_SENTINEL;
        }
        // 'drop' strategy: omit the key entirely.
        continue;
      }
      out[key] = this.scrubValue(value);
    }
    return out;
  }

  private scrubValue(value: JsonValue): JsonValue {
    if (value === null) return null;
    if (Array.isArray(value)) {
      const arr = value as ReadonlyArray<JsonValue>;
      return arr.map((v: JsonValue) => this.scrubValue(v));
    }
    if (typeof value === "object") {
      return this.scrubObject(value as Readonly<Record<string, JsonValue>>);
    }
    return value;
  }
}
