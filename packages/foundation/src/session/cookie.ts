/**
 * `SessionCookie` — the consumer-facing round-trip class.
 *
 * Per doc/foundation/04-session-crypto.md and review S-Sec4 / S-Sec3:
 *   - Payload is opaque (foundation does not sniff structure).
 *   - JSON convenience helpers `sealJson<T>` / `unsealJson<T>` exist
 *     for the common case.
 *   - `unsealJson<T>(token, schema)` REQUIRES a Zod schema (S-Sec3) —
 *     the schema is the runtime check at the seam where untrusted
 *     bytes re-enter the application.
 *   - Rolling rotation: `primarySecret` + optional `fallbackSecret`.
 *     `unseal` tries primary first, falls back if set.
 *   - Salt is REQUIRED at construction. No "fallback to default salt"
 *     mode — a default salt across deployments is a sharp edge that
 *     trellis identified.
 *
 * Cookie header parsing / serialisation delegates to the npm `cookie`
 * package (review S-F11). Foundation does NOT hand-roll the parser.
 */

import * as cookieLib from "cookie";
import type { ZodSchema } from "zod";

import { seal, unseal } from "./crypto.js";
import { SealError, SessionCookieConfigError, UnsealError } from "./errors.js";
import { DEFAULT_PBKDF2_ITERATIONS, deriveKey } from "./key-derivation.js";

/** Minimum allowed secret length (UTF-8 characters). */
export const MIN_SECRET_LENGTH = 32;
/** Minimum allowed salt length (UTF-8 characters). */
export const MIN_SALT_LENGTH = 16;

export interface SessionCookieConfig {
  /** Primary secret. Must be ≥32 chars (UTF-8 length, not bytes). */
  readonly primarySecret: string;
  /** Optional fallback secret for rolling rotation. */
  readonly fallbackSecret?: string;
  /** Per-deployment salt. ≥16 chars. */
  readonly salt: string;
  /** PBKDF2 iterations. Defaults to 600_000 (OWASP 2023). */
  readonly iterations?: number;
}

export interface CookieAttributes {
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: "strict" | "lax" | "none";
  readonly path?: string;
  readonly domain?: string;
  readonly maxAge?: number;
  readonly expires?: Date;
}

/**
 * The session-cookie round-tripper. Construct once per process at
 * startup; the instance derives its keys lazily on first seal/unseal.
 *
 * Both keys (primary + optional fallback) are cached on the instance
 * after first derivation so warm Lambda invocations avoid re-paying
 * the PBKDF2 cost.
 */
export class SessionCookie {
  private readonly primarySecret: string;
  private readonly fallbackSecret: string | undefined;
  private readonly salt: string;
  private readonly iterations: number;
  // Cached derived keys. Populated on first use.
  private primaryKeyPromise: Promise<CryptoKey> | null = null;
  private fallbackKeyPromise: Promise<CryptoKey> | null = null;

  constructor(config: SessionCookieConfig) {
    if (
      typeof config.primarySecret !== "string" ||
      config.primarySecret.length < MIN_SECRET_LENGTH
    ) {
      throw new SessionCookieConfigError(
        `primarySecret must be a string of at least ${String(MIN_SECRET_LENGTH)} characters`,
      );
    }
    if (typeof config.salt !== "string" || config.salt.length < MIN_SALT_LENGTH) {
      throw new SessionCookieConfigError(
        `salt must be a string of at least ${String(MIN_SALT_LENGTH)} characters`,
      );
    }
    if (config.fallbackSecret !== undefined) {
      if (
        typeof config.fallbackSecret !== "string" ||
        config.fallbackSecret.length < MIN_SECRET_LENGTH
      ) {
        throw new SessionCookieConfigError(
          `fallbackSecret, if provided, must be a string of at least ${String(MIN_SECRET_LENGTH)} characters`,
        );
      }
    }
    if (config.iterations !== undefined) {
      if (!Number.isInteger(config.iterations) || config.iterations < DEFAULT_PBKDF2_ITERATIONS) {
        throw new SessionCookieConfigError(
          `iterations must be an integer ≥ ${String(DEFAULT_PBKDF2_ITERATIONS)} (OWASP 2023 minimum)`,
        );
      }
    }
    this.primarySecret = config.primarySecret;
    this.fallbackSecret = config.fallbackSecret;
    this.salt = config.salt;
    this.iterations = config.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  }

  /**
   * Encrypt `payload` (an opaque string) under the primary key.
   * Returns the base64-encoded envelope suitable for cookie storage.
   */
  async seal(payload: string): Promise<string> {
    try {
      const key = await this.getPrimaryKey();
      const payloadBytes = new TextEncoder().encode(payload);
      return await seal(payloadBytes, key);
    } catch (err) {
      if (err instanceof SealError) throw err;
      throw new SealError("Failed to seal session payload", err);
    }
  }

  /**
   * Decrypt the cookie value back to plaintext. Tries the primary key
   * first; if `fallbackSecret` is set and the primary returns null
   * (could be a v1 cookie during rotation), tries the fallback.
   *
   * Returns `null` on any decryption failure across both keys.
   */
  async unseal(token: string): Promise<string | null> {
    const primaryKey = await this.getPrimaryKey();
    const primaryResult = await unseal(token, primaryKey);
    if (primaryResult !== null) {
      return new TextDecoder().decode(primaryResult);
    }
    if (this.fallbackSecret === undefined) {
      return null;
    }
    const fallbackKey = await this.getFallbackKey();
    if (fallbackKey === null) {
      return null;
    }
    const fallbackResult = await unseal(token, fallbackKey);
    if (fallbackResult === null) {
      return null;
    }
    return new TextDecoder().decode(fallbackResult);
  }

  /**
   * Convenience: `JSON.stringify` the payload, then seal. The
   * consumer's `T` is the compile-time shape; foundation does not
   * validate it at seal time (sealing trusted, locally-constructed
   * objects).
   */
  async sealJson<T>(payload: T): Promise<string> {
    let serialized: string;
    try {
      serialized = JSON.stringify(payload);
    } catch (err) {
      throw new SealError("Failed to JSON-serialize session payload", err);
    }
    if (typeof serialized !== "string") {
      // JSON.stringify can return undefined for non-serialisable inputs.
      throw new SealError("Session payload is not JSON-serialisable");
    }
    return this.seal(serialized);
  }

  /**
   * Unseal and JSON-parse. The Zod `schema` parameter is REQUIRED
   * (review S-Sec3) — the schema is the runtime check at the seam
   * where untrusted bytes re-enter.
   *
   *   - Returns `T` on success.
   *   - Returns `null` if the cookie failed to decrypt (bad MAC,
   *     wrong key, malformed input) — indistinguishable from "no
   *     cookie."
   *   - Throws `UnsealError` if the cookie decrypted to bytes that
   *     parsed as JSON but FAILED the schema. This shape strongly
   *     suggests an attacker who obtained the session secret and
   *     minted a cookie of an unexpected shape; surfacing it as an
   *     error lets the caller alert / log / 4xx.
   */
  async unsealJson<T>(token: string, schema: ZodSchema<T>): Promise<T | null> {
    const plaintext = await this.unseal(token);
    if (plaintext === null) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch (err) {
      throw new UnsealError("Session payload decrypted but was not valid JSON", err);
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new UnsealError("Session payload decrypted but failed schema validation", result.error);
    }
    return result.data;
  }

  private getPrimaryKey(): Promise<CryptoKey> {
    if (this.primaryKeyPromise === null) {
      this.primaryKeyPromise = deriveKey(this.primarySecret, this.salt, this.iterations);
    }
    return this.primaryKeyPromise;
  }

  private getFallbackKey(): Promise<CryptoKey> | null {
    if (this.fallbackSecret === undefined) {
      return null;
    }
    if (this.fallbackKeyPromise === null) {
      this.fallbackKeyPromise = deriveKey(this.fallbackSecret, this.salt, this.iterations);
    }
    return this.fallbackKeyPromise;
  }
}

/**
 * Parse a `Cookie:` header string into a record. Delegates to the npm
 * `cookie` package (S-F11 — foundation does not hand-roll the parser).
 *
 * Accepts `null` and returns an empty record so callers can pipe
 * `request.headers.get('cookie')` directly without a null guard.
 */
export function parseCookieHeader(
  header: string | null | undefined,
): Readonly<Record<string, string>> {
  if (header === null || header === undefined || header.length === 0) {
    return Object.freeze({});
  }
  const parsed = cookieLib.parse(header);
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    // cookie@1.x marks values as possibly-undefined; copy only defined.
    if (typeof value === "string") {
      result[name] = value;
    }
  }
  return Object.freeze(result);
}

/**
 * Serialize a single cookie value into a `Set-Cookie` header string.
 * Defaults: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`.
 */
export function serializeSetCookie(
  name: string,
  value: string,
  attributes?: CookieAttributes,
): string {
  const httpOnly = attributes?.httpOnly ?? true;
  const secure = attributes?.secure ?? true;
  const sameSite = attributes?.sameSite ?? "lax";
  const path = attributes?.path ?? "/";
  const options: cookieLib.SerializeOptions = {
    httpOnly,
    secure,
    sameSite,
    path,
  };
  if (attributes?.domain !== undefined) {
    options.domain = attributes.domain;
  }
  if (attributes?.maxAge !== undefined) {
    options.maxAge = attributes.maxAge;
  }
  if (attributes?.expires !== undefined) {
    options.expires = attributes.expires;
  }
  return cookieLib.serialize(name, value, options);
}
