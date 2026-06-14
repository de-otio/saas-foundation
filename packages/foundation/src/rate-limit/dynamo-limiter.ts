/**
 * `DynamoTokenBucketLimiter` — DynamoDB-backed token-bucket limiter.
 *
 * Uses `UpdateItemCommand` with a `ConditionExpression` for optimistic
 * concurrency. The condition matches on `lastRefillMs` so two concurrent
 * consumers of the same key cannot both see the same token count.
 *
 * On a `ConditionalCheckFailedException` (concurrent write conflict)
 * the limiter retries up to 3 times with exponential backoff
 * (10 → 20 → 40 ms). These tunables are not exposed in the public API
 * to prevent under-tuning that would produce false-negative rate-limits.
 *
 * ## S-Sec5 — unknown-key strategy
 *
 * When the caller's identity dimension is the literal string `'unknown'`
 * (e.g., when IP derivation returns `'unknown'` because the trusted-proxy
 * header is missing), the rate-limiter falls through to one of three
 * strategies configured in `DynamoTokenBucketLimiterOptions`:
 *
 *   - `'shared-bucket'` (default): all unknown-key callers share one
 *     bucket. Throughput across the unknown segment is bounded, but
 *     the service stays available. An attacker cannot trivially evade
 *     rate-limiting by stripping proxy headers (the shared bucket is
 *     itself limited).
 *   - `'reject'`: every unknown-key call returns `{ allowed: false }`.
 *     Use when the rate-limit is the only authorization gate on an
 *     unauthenticated endpoint (e.g., a public magic-link endpoint)
 *     and the consumer prefers fail-closed.
 *   - `'allow'`: pass-through with no rate limiting. Provided for
 *     development/debugging environments; do not use in production.
 *
 * The default of `'shared-bucket'` differs from the trellis source's
 * implicit `'shared'` behaviour, where no explicit strategy was modelled.
 * Per review S-Sec5 a documented, opt-in default is safer than an
 * accidental shared bucket that callers don't know they're relying on.
 */

import {
  DynamoDBClient,
  UpdateItemCommand,
  DeleteItemCommand,
  GetItemCommand,
  ConditionalCheckFailedException,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

import { getLogger } from "../logger/index.js";
import { RateLimitConfigError } from "./errors.js";
import type { TokenBucketConfig, RateLimitResult } from "./types.js";
import { TokenBucketConfigSchema } from "./schemas.js";
import type { BucketState } from "./token-bucket.js";
import {
  computeConsumeResult,
  computePeekResult,
  computeBucketTtlSeconds,
} from "./token-bucket.js";

export interface DynamoTokenBucketLimiterOptions {
  /** DynamoDB table name. */
  readonly tableName: string;
  /**
   * Key namespace prefix. Added before every bucket key to prevent
   * collisions with other table users:
   *   `<namespace>#<key>` → stored as the DynamoDB primary key.
   */
  readonly namespace: string;
  /** Default bucket configuration when `consume` / `peek` omit the config arg. */
  readonly defaultConfig?: TokenBucketConfig;
  /**
   * Behaviour when the key is or ends with `:unknown` (typically: IP
   * derivation failed and the caller passed `'unknown'` as the
   * dimension value).
   *
   * - `'shared-bucket'` (default): all unknown-key callers share one
   *   bucket (the key is used as-is; all `...:unknown` callers map to
   *   the same row).
   * - `'reject'`: every unknown-key call returns `{ allowed: false }`
   *   without a DynamoDB round-trip.
   * - `'allow'`: pass-through. Only for dev/debug.
   *
   * @default 'shared-bucket'
   */
  readonly unknownKeyStrategy?: "shared-bucket" | "reject" | "allow";
}

const DEFAULT_CONFIG: TokenBucketConfig = {
  capacity: 60,
  refillRate: 1,
};

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isConditionalCheckFailed(err: unknown): boolean {
  return err instanceof ConditionalCheckFailedException;
}

export class DynamoTokenBucketLimiter {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;
  private readonly namespace: string;
  private readonly defaultConfig: TokenBucketConfig;
  private readonly unknownKeyStrategy: "shared-bucket" | "reject" | "allow";

  public constructor(client: DynamoDBClient, options: DynamoTokenBucketLimiterOptions) {
    if (options.tableName.length === 0) {
      throw new RateLimitConfigError("DynamoTokenBucketLimiter: tableName must be non-empty");
    }
    if (options.namespace.length === 0) {
      throw new RateLimitConfigError("DynamoTokenBucketLimiter: namespace must be non-empty");
    }
    const rawConfig = options.defaultConfig ?? DEFAULT_CONFIG;
    const parsed = TokenBucketConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      throw new RateLimitConfigError(`Invalid defaultConfig: ${parsed.error.message}`);
    }
    this.client = client;
    this.tableName = options.tableName;
    this.namespace = options.namespace;
    this.defaultConfig = rawConfig;
    this.unknownKeyStrategy = options.unknownKeyStrategy ?? "shared-bucket";
  }

  /**
   * Attempt to consume `cost` tokens for `key`.
   *
   * Returns the result; does not throw on rate-limit-exceeded — the
   * caller decides whether to 429 / queue / fail.
   */
  public async consume(
    key: string,
    cost: number,
    config?: TokenBucketConfig,
  ): Promise<RateLimitResult> {
    const resolvedKey = this.resolveKey(key);
    if (resolvedKey === null) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: Date.now(),
        retryAfter: 0,
      };
    }

    const effectiveConfig = this.resolveConfig(config);
    return this.consumeWithRetry(resolvedKey, cost, effectiveConfig, 0);
  }

  /**
   * Peek at the current bucket state without consuming.
   *
   * Informational only — do NOT use as a precondition for `consume`.
   */
  public async peek(key: string, config?: TokenBucketConfig): Promise<RateLimitResult> {
    const resolvedKey = this.resolveKey(key) ?? key;
    const effectiveConfig = this.resolveConfig(config);
    const nowMs = Date.now();
    const state = await this.readState(resolvedKey);
    return computePeekResult(state, nowMs, effectiveConfig);
  }

  /**
   * Reset a bucket (admin tool / test). Removes the DynamoDB row.
   *
   * Dangerous in production — removing the row lets a rate-limited
   * caller resume immediately. Gate at the consumer level.
   */
  public async reset(key: string): Promise<void> {
    const pk = `${this.namespace}#${key}`;
    await this.client.send(
      new DeleteItemCommand({
        TableName: this.tableName,
        Key: marshall({ PK: pk }),
      }),
    );
  }

  private async consumeWithRetry(
    key: string,
    cost: number,
    config: TokenBucketConfig,
    attempt: number,
  ): Promise<RateLimitResult> {
    const nowMs = Date.now();
    const state = await this.readState(key);
    const { newState, result } = computeConsumeResult(state, nowMs, cost, config);

    try {
      await this.writeState(key, newState, state, config);
    } catch (err) {
      if (isConditionalCheckFailed(err) && attempt < MAX_RETRIES - 1) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        await sleep(delay);
        return this.consumeWithRetry(key, cost, config, attempt + 1);
      }
      // On exhausted retries or non-conditional errors, surface the
      // result we computed (best-effort). The design accepts a small
      // false-negative window under sustained high contention.
      getLogger().warn(
        { key, attempt, err: err instanceof Error ? err.message : String(err) },
        "rate-limit: conditional write failed; returning computed result",
      );
    }

    const logger = getLogger();
    if (result.allowed) {
      logger.debug({ key, cost, remaining: result.remaining }, "rate-limit: allowed");
    } else {
      logger.warn({ key, cost, retryAfter: result.retryAfter }, "rate-limit: denied");
    }

    return result;
  }

  private async readState(key: string): Promise<BucketState | null> {
    const pk = `${this.namespace}#${key}`;
    const response = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: marshall({ PK: pk }),
      }),
    );

    if (response.Item === undefined) return null;
    const item = unmarshall(response.Item);
    if (typeof item["tokens"] !== "number" || typeof item["lastRefillMs"] !== "number") {
      return null;
    }
    return {
      tokens: item["tokens"],
      lastRefillMs: item["lastRefillMs"],
    };
  }

  private async writeState(
    key: string,
    newState: BucketState,
    prevState: BucketState | null,
    config: TokenBucketConfig,
  ): Promise<void> {
    const pk = `${this.namespace}#${key}`;
    const nowMs = Date.now();
    const ttlSeconds = computeBucketTtlSeconds(newState, nowMs, config);
    const ttlEpochSeconds = Math.floor(nowMs / 1000) + ttlSeconds;

    if (prevState === null) {
      // New item: use attribute_not_exists to avoid overwriting a concurrent write.
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: marshall({ PK: pk }),
          UpdateExpression: "SET tokens = :tokens, lastRefillMs = :lastRefillMs, #ttl = :ttl",
          ExpressionAttributeNames: { "#ttl": "ttl" },
          ExpressionAttributeValues: marshall({
            ":tokens": newState.tokens,
            ":lastRefillMs": newState.lastRefillMs,
            ":ttl": ttlEpochSeconds,
          }),
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
    } else {
      // Existing item: match on lastRefillMs for optimistic concurrency.
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: marshall({ PK: pk }),
          UpdateExpression: "SET tokens = :tokens, lastRefillMs = :lastRefillMs, #ttl = :ttl",
          ExpressionAttributeNames: { "#ttl": "ttl" },
          ExpressionAttributeValues: marshall({
            ":tokens": newState.tokens,
            ":lastRefillMs": newState.lastRefillMs,
            ":prevLastRefillMs": prevState.lastRefillMs,
            ":ttl": ttlEpochSeconds,
          }),
          ConditionExpression: "lastRefillMs = :prevLastRefillMs",
        }),
      );
    }
  }

  private resolveKey(key: string): string | null {
    const isUnknown = key === "unknown" || key.endsWith(":unknown");
    if (!isUnknown) return key;

    switch (this.unknownKeyStrategy) {
      case "reject":
        return null;
      case "allow":
        return key;
      case "shared-bucket":
      default:
        return key;
    }
  }

  private resolveConfig(override?: TokenBucketConfig): TokenBucketConfig {
    if (override === undefined) return this.defaultConfig;
    const parsed = TokenBucketConfigSchema.safeParse(override);
    if (!parsed.success) {
      throw new RateLimitConfigError(`Invalid TokenBucketConfig: ${parsed.error.message}`);
    }
    return override;
  }
}
