/**
 * Zod schemas for the storage module boundary validation.
 */

import { z } from "zod";

export const StoragePutOptionsSchema = z.object({
  httpMetadata: z.object({ contentType: z.string().optional() }).optional(),
  customMetadata: z.record(z.string(), z.string()).optional(),
});

export const StorageListOptionsSchema = z.object({
  prefix: z.string().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  cursor: z.string().optional(),
});
