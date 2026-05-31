/**
 * Zod schemas for the session module's boundary types.
 *
 * Only `SessionCookieConfig` has a public schema; the payload itself
 * is consumer-defined and validated via the schema parameter passed
 * into `unsealJson` (review S-Sec3).
 */

import { z } from "zod";

import { MIN_SALT_LENGTH, MIN_SECRET_LENGTH } from "./cookie.js";
import { DEFAULT_PBKDF2_ITERATIONS } from "./key-derivation.js";

export const SessionCookieConfigSchema = z.object({
  primarySecret: z.string().min(MIN_SECRET_LENGTH),
  fallbackSecret: z.string().min(MIN_SECRET_LENGTH).optional(),
  salt: z.string().min(MIN_SALT_LENGTH),
  iterations: z.number().int().min(DEFAULT_PBKDF2_ITERATIONS).optional(),
});
