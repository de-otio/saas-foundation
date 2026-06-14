/**
 * Zod schemas for the kv module boundary validation.
 */

import { z } from "zod";

/**
 * Validates the shape of a decoded pagination cursor.
 * Only `pk` and `sk` keys are allowed — anything else indicates a tampered or
 * malformed cursor.
 */
const DynamoAttributeValueSchema = z.union([
  z.string(),
  z.number(),
  z.object({ S: z.string() }).strict(),
  z.object({ N: z.string() }).strict(),
]);

export const CursorKeySchema = z
  .object({
    pk: DynamoAttributeValueSchema.optional(),
    sk: DynamoAttributeValueSchema.optional(),
  })
  .strict()
  .refine((obj) => Object.keys(obj).length >= 1, {
    message: "Cursor must have at least one key",
  });

export type CursorKey = z.infer<typeof CursorKeySchema>;
