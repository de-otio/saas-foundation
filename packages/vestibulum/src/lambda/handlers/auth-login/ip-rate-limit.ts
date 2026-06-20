/**
 * Per-client-IP login rate limiter for the auth-login Function URL.
 *
 * Default 10 attempts / 15 min / IP. Enforced via a conditional `UpdateItem`
 * against the shared rate-limit table — race-safe under parallel attempts. A
 * `ConditionalCheckFailedException` from DynamoDB is the signal that the caller
 * (the IP) is over the limit; we return `false` and the caller maps that to a
 * generic 429.
 *
 * The PK is `SHA-256("login-ip:" + ip#window_start_ms)`. The `login-ip:` prefix
 * fences this hashed keyspace off from the per-email limiter (which hashes
 * `email#window_start_ms` with no prefix) so the two limiters can share one
 * table without their buckets ever colliding — even theoretically — despite
 * keying on the same `bucket_id` PK attribute. Keying on the window start also
 * auto-resets the bucket every window without a TTL daemon.
 */

import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { createHash } from "crypto";

/** Default rate-limit window (15 minutes, in milliseconds). */
export const IP_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/** Default login attempts per window per client IP. */
export const DEFAULT_LOGINS_PER_WINDOW = 10;

export interface IpRateLimitOptions {
  readonly client: DynamoDBClient;
  readonly tableName: string;
  readonly ip: string;
  readonly limit: number;
  /** Override clock for tests. Defaults to Date.now(). */
  readonly nowMs?: number;
  /** Override window size for tests. Defaults to 15 min. */
  readonly windowMs?: number;
}

/**
 * Atomically increments the per-IP counter for the current window.
 *
 * Returns `true` on success (the login may proceed), `false` if the IP has
 * already hit its limit for the current window. Any other DynamoDB error
 * propagates.
 */
export async function tryConsumeIpRateLimit(opts: IpRateLimitOptions): Promise<boolean> {
  const windowMs = opts.windowMs ?? IP_RATE_LIMIT_WINDOW_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const windowStart = Math.floor(nowMs / windowMs) * windowMs;

  // The `login-ip:` prefix keeps this keyspace disjoint from the per-email
  // limiter's (which hashes `email#window_start` with no prefix).
  const ipHash = createHash("sha256")
    .update(`login-ip:${opts.ip}#${windowStart}`)
    .digest("hex");

  // TTL = window end + 1 min (epoch seconds). DynamoDB TTL is best-effort, so
  // we don't rely on it for correctness; the windowed key already self-resets.
  const ttlEpoch = Math.floor((windowStart + windowMs) / 1000) + 60;

  try {
    await opts.client.send(
      new UpdateItemCommand({
        TableName: opts.tableName,
        // PK attribute is `bucket_id` — must match the RateLimitTable schema.
        Key: { bucket_id: { S: ipHash } },
        // Either the row doesn't exist (first attempt in window) or the count is
        // strictly less than the limit. Atomic — concurrent attempts cannot both
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
