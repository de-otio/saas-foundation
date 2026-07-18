/**
 * `PostgresTokenBucketLimiter` — Postgres-backed token-bucket limiter
 * (ws1-kv-port-plan §3.10 / §4.2, security fix F5).
 *
 * The Scaleway-target sibling of {@link DynamoTokenBucketLimiter}. It wraps the
 * exact same pure token-bucket math (`computeConsumeResult` / `computePeekResult`
 * / `computeBucketTtlSeconds`) and mirrors the Dynamo limiter's public API,
 * unknown-key strategy, and bounded-retry **fail-OPEN** behaviour — the only
 * difference is the storage seam: a `rate_limit_buckets` row updated with
 * optimistic concurrency over the structural {@link SqlExecutor} (satisfied by a
 * `pg.Pool` or a thin Prisma `$queryRawUnsafe` wrapper), so foundation takes on
 * NO `pg` runtime dependency.
 *
 * ## Optimistic concurrency
 * A write conditions on the previously-read `last_refill_ms` (the Postgres analogue
 * of Dynamo's `ConditionExpression` on `lastRefillMs`): a new row INSERTs with
 * `ON CONFLICT DO NOTHING` (0 rows affected ⇒ someone else won ⇒ CONFLICT), and an
 * existing row UPDATEs `WHERE last_refill_ms = <prev>` (0 rows affected ⇒ the row
 * moved under us ⇒ CONFLICT). Two concurrent consumers of one key can therefore
 * never both commit off the same token count.
 *
 * ## F5 — bounded retry, then fail OPEN
 * A CONFLICT (rowcount 0) **or** a Postgres serialization failure (`40001`) /
 * deadlock (`40P01`) is retried up to MAX_RETRIES=3 with 10 → 20 → 40 ms backoff
 * (identical tunables to the Dynamo limiter — deliberately not exposed, to prevent
 * under-tuning into false-negative rate-limits). On retry EXHAUSTION or a
 * non-retryable error the limiter does NOT throw and does NOT fail closed: it logs
 * a warning and RETURNS the already-computed result (best-effort ALLOW). A distinct
 * `contention: true` warning is emitted on exhaustion so the contention ceiling is
 * observable. The design accepts a small false-negative window under sustained
 * contention rather than turning a storage hiccup into a request-path outage.
 *
 * ## Injected clock (frozen-clock default)
 * `now()` defaults to `Date.now` but is injected so tests are deterministic. The
 * SAME `nowMs` drives the token math AND the `expires_at` computation — the SQL
 * `now()` function is never used.
 *
 * ## S-Sec5 — unknown-key strategy
 * Identical to the Dynamo limiter: `'shared-bucket'` (default), `'reject'`, or
 * `'allow'`. See {@link DynamoTokenBucketLimiter} for the rationale.
 */

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

/**
 * Minimal parameterized-query surface the limiter depends on. Matches
 * `pg.Pool.query(text, params)` and a thin Prisma `$queryRawUnsafe` wrapper.
 * Redeclared here (rather than imported from the `kv/postgres` sub-path) so the
 * rate-limit module carries no dependency on the KV module.
 */
export interface SqlExecutor {
  query<R = Record<string, unknown>>(
    text: string,
    params: readonly unknown[],
  ): Promise<{ readonly rows: R[] }>;
}

export interface PostgresTokenBucketLimiterOptions {
  /** Postgres table name (e.g. `rate_limit_buckets`). */
  readonly tableName: string;
  /**
   * Key namespace prefix. Added before every bucket key to prevent
   * collisions with other table users: `<namespace>#<key>` → `bucket_key`.
   */
  readonly namespace: string;
  /** Default bucket configuration when `consume` / `peek` omit the config arg. */
  readonly defaultConfig?: TokenBucketConfig;
  /**
   * Behaviour when the key is or ends with `:unknown` (typically: IP
   * derivation failed and the caller passed `'unknown'`).
   *
   * - `'shared-bucket'` (default): all unknown-key callers share one row.
   * - `'reject'`: every unknown-key call returns `{ allowed: false }` without a
   *   round-trip.
   * - `'allow'`: pass-through. Only for dev/debug.
   *
   * @default 'shared-bucket'
   */
  readonly unknownKeyStrategy?: "shared-bucket" | "reject" | "allow";
  /** Injected clock, epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_CONFIG: TokenBucketConfig = {
  capacity: 60,
  refillRate: 1,
};

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 10;

/** Postgres serialization-failure / deadlock SQLSTATE codes (retryable). */
const PG_SERIALIZATION_FAILURE = "40001";
const PG_DEADLOCK_DETECTED = "40P01";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sentinel raised when a conditional write matched no row (optimistic-concurrency
 * conflict). Signalled the same way a Postgres serialization failure is, so the
 * retry loop treats both uniformly.
 */
class WriteConflictError extends Error {
  public override readonly name = "WriteConflictError" as const;
}

function pgSqlState(err: unknown): string | undefined {
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** A write conflict, serialization failure, or deadlock — all retryable. */
function isRetryable(err: unknown): boolean {
  if (err instanceof WriteConflictError) return true;
  const code = pgSqlState(err);
  return code === PG_SERIALIZATION_FAILURE || code === PG_DEADLOCK_DETECTED;
}

export class PostgresTokenBucketLimiter {
  private readonly tableName: string;
  private readonly namespace: string;
  private readonly defaultConfig: TokenBucketConfig;
  private readonly unknownKeyStrategy: "shared-bucket" | "reject" | "allow";
  private readonly now: () => number;

  public constructor(
    private readonly executor: SqlExecutor,
    options: PostgresTokenBucketLimiterOptions,
  ) {
    if (options.tableName.length === 0) {
      throw new RateLimitConfigError("PostgresTokenBucketLimiter: tableName must be non-empty");
    }
    if (options.namespace.length === 0) {
      throw new RateLimitConfigError("PostgresTokenBucketLimiter: namespace must be non-empty");
    }
    const rawConfig = options.defaultConfig ?? DEFAULT_CONFIG;
    const parsed = TokenBucketConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      throw new RateLimitConfigError(`Invalid defaultConfig: ${parsed.error.message}`);
    }
    this.tableName = options.tableName;
    this.namespace = options.namespace;
    this.defaultConfig = rawConfig;
    this.unknownKeyStrategy = options.unknownKeyStrategy ?? "shared-bucket";
    this.now = options.now ?? Date.now;
  }

  /**
   * Attempt to consume `cost` tokens for `key`.
   *
   * Returns the result; does not throw on rate-limit-exceeded — the caller
   * decides whether to 429 / queue / fail. Under storage contention it fails
   * OPEN (returns the computed best-effort result), never throws (F5).
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
        resetAt: this.now(),
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
    const nowMs = this.now();
    const state = await this.readState(resolvedKey);
    return computePeekResult(state, nowMs, effectiveConfig);
  }

  /**
   * Reset a bucket (admin tool / test). Removes the row.
   *
   * Dangerous in production — removing the row lets a rate-limited caller resume
   * immediately. Gate at the consumer level.
   */
  public async reset(key: string): Promise<void> {
    const bucketKey = this.bucketKey(key);
    await this.executor.query(
      `DELETE FROM ${this.tableName} WHERE bucket_key = $1`,
      [bucketKey],
    );
  }

  private async consumeWithRetry(
    key: string,
    cost: number,
    config: TokenBucketConfig,
    attempt: number,
  ): Promise<RateLimitResult> {
    const nowMs = this.now();
    const state = await this.readState(key);
    const { newState, result } = computeConsumeResult(state, nowMs, cost, config);

    try {
      await this.writeState(key, newState, state, config, nowMs);
    } catch (err) {
      if (isRetryable(err) && attempt < MAX_RETRIES - 1) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        await sleep(delay);
        return this.consumeWithRetry(key, cost, config, attempt + 1);
      }
      // F5: on exhausted retries or a non-retryable error, surface the result we
      // computed (best-effort ALLOW). Never throw; never fail closed. The design
      // accepts a small false-negative window under sustained high contention.
      const logger = getLogger();
      logger.warn(
        { key, attempt, err: err instanceof Error ? err.message : String(err) },
        "rate-limit: postgres write failed; returning computed result",
      );
      if (isRetryable(err)) {
        // Distinct contention signal so the retry ceiling is observable/alertable.
        logger.warn(
          { key, attempt, contention: true },
          "rate-limit: postgres write contention ceiling reached; failing open",
        );
      }
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
    const bucketKey = this.bucketKey(key);
    const { rows } = await this.executor.query<{
      tokens: number | string;
      last_refill_ms: number | string;
    }>(
      `SELECT tokens, last_refill_ms FROM ${this.tableName} WHERE bucket_key = $1`,
      [bucketKey],
    );
    const row = rows[0];
    if (row === undefined) return null;
    const tokens = Number(row.tokens);
    const lastRefillMs = Number(row.last_refill_ms);
    if (!Number.isFinite(tokens) || !Number.isFinite(lastRefillMs)) return null;
    return { tokens, lastRefillMs };
  }

  private async writeState(
    key: string,
    newState: BucketState,
    prevState: BucketState | null,
    config: TokenBucketConfig,
    nowMs: number,
  ): Promise<void> {
    const bucketKey = this.bucketKey(key);
    const ttlSeconds = computeBucketTtlSeconds(newState, nowMs, config);
    const expiresAt = new Date((Math.floor(nowMs / 1000) + ttlSeconds) * 1000);

    if (prevState === null) {
      // New row: ON CONFLICT DO NOTHING — 0 rows returned means a concurrent
      // writer inserted first (CONFLICT).
      const { rows } = await this.executor.query<{ bucket_key: string }>(
        `INSERT INTO ${this.tableName} (bucket_key, tokens, last_refill_ms, expires_at)
              VALUES ($1, $2, $3, $4)
         ON CONFLICT (bucket_key) DO NOTHING
          RETURNING bucket_key`,
        [bucketKey, newState.tokens, newState.lastRefillMs, expiresAt],
      );
      if (rows.length === 0) {
        throw new WriteConflictError("rate-limit: insert lost the race");
      }
    } else {
      // Existing row: match on last_refill_ms for optimistic concurrency — 0 rows
      // returned means the row moved under us (CONFLICT).
      const { rows } = await this.executor.query<{ bucket_key: string }>(
        `UPDATE ${this.tableName}
            SET tokens = $2, last_refill_ms = $3, expires_at = $4
          WHERE bucket_key = $1 AND last_refill_ms = $5
        RETURNING bucket_key`,
        [bucketKey, newState.tokens, newState.lastRefillMs, expiresAt, prevState.lastRefillMs],
      );
      if (rows.length === 0) {
        throw new WriteConflictError("rate-limit: update lost the race");
      }
    }
  }

  private bucketKey(key: string): string {
    return `${this.namespace}#${key}`;
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
