/**
 * Zod schemas for the queue module boundary validation.
 */

import { z } from "zod";

export const SqsSendOptionsSchema = z.object({
  delaySeconds: z.number().int().min(0).max(900).optional(),
});

export const SqsBatchEntrySchema = z.object({
  body: z.unknown(),
  delaySeconds: z.number().int().min(0).max(900).optional(),
});

/** Maximum SQS batch size per AWS API limits. */
export const SQS_MAX_BATCH_SIZE = 10;
