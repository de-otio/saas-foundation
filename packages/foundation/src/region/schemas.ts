/**
 * Zod schemas for the region module.
 *
 * Pure module.
 */

import { z } from "zod";

/**
 * Format-only validator: 2–32 chars, `[A-Za-z0-9-]` only.
 * Matches both broad-region codes (`EU`, `US`, `CN`) and AWS
 * region codes (`eu-central-1`, `ap-southeast-2`).
 */
export const RegionFormatSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[A-Za-z0-9-]+$/, "Region must contain only [A-Za-z0-9-]");

export const RegionRegistryOptionsSchema = z.object({
  allowed: z.array(z.string()).min(1),
  default: z.string().min(1),
  countryMapping: z.record(z.string(), z.string()).optional(),
});
