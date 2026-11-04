/**
 * Per-address daily cap on challenges (`signin_attempts_bounded`, I10: at most
 * 20 per UTC day).
 *
 * It bounds guessing of the typed 8-digit code: each session allows one answer
 * and costs a mail to the victim, so the cap turns 10^8 codes into about
 * 7·10⁻⁵ a year per address. Enforced in Create (`signin_caps_enforced_in_trigger`),
 * alongside the per-window cap in `rate-limit.ts`, with the same conditional,
 * race-safe `UpdateItem` against the rate-limit table.
 *
 * The partition key is `HMAC-SHA-256(secret, "daily-cap:" + address + "#" +
 * UTC date)`: the address never sits in a key, a table snapshot cannot be
 * brute-forced for addresses without the secret, and keying on the date resets
 * the bucket at UTC midnight without a TTL daemon. The row's `expires_at` is
 * one hour past the end of that UTC day (cleanup only; the date in the key is
 * what resets the counter).
 */

import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { createHmac } from "crypto";

import { TTL_ATTRIBUTE } from "../../shared/signin.js";

/** Default challenges per address per UTC day. */
export const DEFAULT_SENDS_PER_DAY = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DailyCapOptions {
  readonly client: DynamoDBClient;
  readonly tableName: string;
  /** The normalised address (or, for a phantom, its made-up username). */
  readonly address: string;
  /** The shared secret that keys the bucket id. */
  readonly hmacKey: string;
  readonly limit: number;
  readonly nowMs: number;
}

/** `YYYY-MM-DD` of the UTC day containing `nowMs`. */
export function utcDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Atomically counts one challenge against the address's cap for the current UTC
 * day. Returns `true` while the count is within `limit`, `false` once the
 * address already used its `limit` challenges today. Any other error propagates
 * (the caller fails closed).
 */
export async function tryConsumeDailyCap(opts: DailyCapOptions): Promise<boolean> {
  const bucketId = createHmac("sha256", opts.hmacKey)
    .update(`daily-cap:${opts.address.toLowerCase()}#${utcDate(opts.nowMs)}`)
    .digest("hex");
  const dayStartMs = Math.floor(opts.nowMs / DAY_MS) * DAY_MS;
  const expiresAt = Math.floor((dayStartMs + DAY_MS) / 1000) + 3600;

  try {
    await opts.client.send(
      new UpdateItemCommand({
        TableName: opts.tableName,
        Key: { bucket_id: { S: bucketId } },
        UpdateExpression: "SET #c = if_not_exists(#c, :zero) + :one, #ttl = :ttl",
        // Either the first challenge of the day, or still under the limit. Atomic:
        // concurrent requests cannot both step the counter past it.
        ConditionExpression: "attribute_not_exists(#c) OR #c < :limit",
        ExpressionAttributeNames: { "#c": "count", "#ttl": TTL_ATTRIBUTE },
        ExpressionAttributeValues: {
          ":zero": { N: "0" },
          ":one": { N: "1" },
          ":limit": { N: String(opts.limit) },
          ":ttl": { N: String(expiresAt) },
        },
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}
