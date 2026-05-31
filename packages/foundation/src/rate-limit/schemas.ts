/**
 * Zod schemas for the rate-limit module.
 *
 * Used for boundary validation of `TokenBucketConfig` values supplied
 * by external callers. Internal token-bucket state is kept as plain
 * TypeScript interfaces — Zod is for the public API surface.
 *
 * Pure module.
 */

import { z } from "zod";

/**
 * Schema for `TokenBucketConfig`. Validates that capacity and refillRate
 * are positive finite numbers.
 */
export const TokenBucketConfigSchema = z.object({
  capacity: z.number().positive().finite(),
  refillRate: z.number().positive().finite(),
});

export type TokenBucketConfigSchemaInput = z.input<typeof TokenBucketConfigSchema>;
