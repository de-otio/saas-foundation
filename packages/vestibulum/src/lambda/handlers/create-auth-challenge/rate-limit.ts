/**
 * Per-email magic-link send rate limiter.
 *
 * Default 3 sends / 15 min / email. Enforced via a conditional `UpdateItem`
 * against a dedicated rate-limit table — race-safe under parallel sign-in
 * attempts. A `ConditionalCheckFailedException` from DynamoDB is the signal
 * that the caller is over the limit; we return `false` and the caller must
 * map that to the same generic challenge shape as a successful send (no
 * enumeration).
 *
 * The PK is `SHA-256(email#window_start_ms)` — both because raw addresses
 * never sit in PKs and because keying on the window start automatically
 * resets the bucket every window without a TTL daemon.
 */

import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { createHash } from "crypto";

/** Default rate-limit window (15 minutes, in milliseconds). */
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/** Default sends per window per email. */
export const DEFAULT_SENDS_PER_WINDOW = 3;

export interface RateLimitOptions {
  readonly client: DynamoDBClient;
  readonly tableName: string;
  readonly email: string;
  readonly limit: number;
  /** Override clock for tests. Defaults to Date.now(). */
  readonly nowMs?: number;
  /** Override window size for tests. Defaults to 15 min. */
  readonly windowMs?: number;
}

/**
 * Atomically increments the per-email counter for the current window.
 *
 * Returns `true` on success (the send may proceed), `false` if the email
 * has already hit its limit for the current window. Any other DynamoDB
 * error propagates.
 */
export async function tryConsumeRateLimit(opts: RateLimitOptions): Promise<boolean> {
  const windowMs = opts.windowMs ?? RATE_LIMIT_WINDOW_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const windowStart = Math.floor(nowMs / windowMs) * windowMs;

  const emailHash = createHash("sha256")
    .update(`${opts.email.toLowerCase()}#${windowStart}`)
    .digest("hex");

  // TTL = window end + 1 min (epoch seconds). DynamoDB TTL is best-effort, so
  // we don't rely on it for correctness; the windowed key already self-resets.
  const ttlEpoch = Math.floor((windowStart + windowMs) / 1000) + 60;

  try {
    await opts.client.send(
      new UpdateItemCommand({
        TableName: opts.tableName,
        // PK attribute is `bucket_id` — must match the RateLimitTable schema.
        Key: { bucket_id: { S: emailHash } },
        // Either the row doesn't exist (first send in window) or the count is
        // strictly less than the limit. Atomic — concurrent sends cannot both
        // step the counter past the limit.
        UpdateExpression: "SET #c = if_not_exists(#c, :zero) + :one, #ws = :ws, #ttl = :ttl",
        ConditionExpression: "attribute_not_exists(#c) OR (#c < :limit AND #ws = :ws)",
        ExpressionAttributeNames: {
          "#c": "count",
          "#ws": "window_start",
          "#ttl": "ttl",
        },
        ExpressionAttributeValues: {
          ":zero": { N: "0" },
          ":one": { N: "1" },
          ":limit": { N: String(opts.limit) },
          ":ws": { N: String(windowStart) },
          ":ttl": { N: String(ttlEpoch) },
        },
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return false;
    }
    throw err;
  }
}
