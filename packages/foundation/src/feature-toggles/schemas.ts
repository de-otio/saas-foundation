/**
 * Zod schemas for the feature-toggles module.
 *
 * Used for boundary validation of `SetToggleInput` values from external
 * callers.
 *
 * Pure module.
 */

import { z } from "zod";

export const SetToggleInputSchema = z.object({
  key: z.string().min(1).max(256),
  enabled: z.boolean(),
  changedBy: z.string().min(1),
  description: z.string().optional(),
});

export type SetToggleInputSchema = z.infer<typeof SetToggleInputSchema>;

export const FeatureToggleStoreOptionsSchema = z.object({
  cacheTtlMs: z.number().positive().finite().optional(),
  cacheDisabled: z.boolean().optional(),
});
