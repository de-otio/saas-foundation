/**
 * Tests for `PostgresTokenBucketLimiter`.
 *
 * Two lanes:
 *   (a) an in-memory fake `SqlExecutor` (a Map) that exercises the full API —
 *       consume allow→deny across capacity, peek, reset, the unknown-key
 *       strategies, and — crucially — F5: bounded-retry fail-OPEN on write
 *       conflicts / serialization failures. This lane needs no container.
 *   (b) an OPTIONAL real-Postgres lane, guarded by a reachability probe to
 *       `KV_TEST_DATABASE_URL` / `DATABASE_URL`, that self-skips when unreachable
 *       (mirrors store-contract.postgres.test.ts).
 *
 * All timing is via an injected frozen clock; no real `Date` global is used.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import { PostgresTokenBucketLimiter } from "../../src/rate-limit/postgres-limiter.js";
import type { SqlExecutor } from "../../src/rate-limit/postgres-limiter.js";
import { RateLimitConfigError } from "../../src/rate-limit/errors.js";
import type { TokenBucketConfig } from "../../src/rate-limit/types.js";
import { createTestLogCapture } from "../../src/logger/index.js";

const FROZEN_EPOCH_MS = 1_779_611_415_000;
const TABLE = "rate_limit_buckets";
const NS = "ratelimit";
const CONFIG: TokenBucketConfig = { capacity: 5, refillRate: 1 };

/** Fixed injected clock — no real `Date` in the token math or expiries. */
const frozenClock = (): number => FROZEN_EPOCH_MS;

interface BucketRow {
  tokens: number;
  last_refill_ms: number;
  // Opaque here — the fake stores the `timestamptz` bind value without inspecting
  // it. Typed `unknown` to avoid referencing the banned real `Date` global.
  expires_at: unknown;
}

/** A Postgres error carries a SQLSTATE `code`; model one for the retry lane. */
function pgError(code: string): Error & { code: string } {
  const err = new Error(`pg error ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

/**
 * In-memory fake that implements just enough of the four statements the limiter
 * issues (SELECT / INSERT…ON CONFLICT DO NOTHING / UPDATE…WHERE last_refill_ms /
 * DELETE) over a `Map`, with an injectable write fault for the F5 lane.
 */
class FakeSql implements SqlExecutor {
  public readonly store = new Map<string, BucketRow>();
  public writeCount = 0;
  public selectCount = 0;
  /** Return an error to throw for this write attempt, or `undefined` to proceed. */
  public writeFault: (() => Error | undefined) | null = null;

  public query<R = Record<string, unknown>>(
    text: string,
    params: readonly unknown[],
  ): Promise<{ readonly rows: R[] }> {
    const sql = text.trim();
    const key = params[0] as string;

    if (sql.startsWith("SELECT")) {
      this.selectCount += 1;
      const row = this.store.get(key);
      const rows =
        row === undefined
          ? []
          : [{ tokens: row.tokens, last_refill_ms: row.last_refill_ms }];
      return Promise.resolve({ rows: rows as R[] });
    }

    if (sql.startsWith("DELETE")) {
      this.store.delete(key);
      return Promise.resolve({ rows: [] as R[] });
    }

    // INSERT or UPDATE — a write.
    this.writeCount += 1;
    if (this.writeFault !== null) {
      const fault = this.writeFault();
      if (fault !== undefined) return Promise.reject(fault);
    }

    const tokens = params[1] as number;
    const lastRefillMs = params[2] as number;
    const expiresAt = params[3];

    if (sql.startsWith("INSERT")) {
      if (this.store.has(key)) {
        // ON CONFLICT DO NOTHING → 0 rows.
        return Promise.resolve({ rows: [] as R[] });
      }
      this.store.set(key, { tokens, last_refill_ms: lastRefillMs, expires_at: expiresAt });
      return Promise.resolve({ rows: [{ bucket_key: key }] as R[] });
    }

    // UPDATE … WHERE bucket_key = $1 AND last_refill_ms = $5
    const prevLastRefillMs = params[4] as number;
    const existing = this.store.get(key);
    if (existing === undefined || existing.last_refill_ms !== prevLastRefillMs) {
      return Promise.resolve({ rows: [] as R[] });
    }
    this.store.set(key, { tokens, last_refill_ms: lastRefillMs, expires_at: expiresAt });
    return Promise.resolve({ rows: [{ bucket_key: key }] as R[] });
  }
}

function makeLimiter(
  executor: SqlExecutor,
  opts?: Partial<ConstructorParameters<typeof PostgresTokenBucketLimiter>[1]>,
): PostgresTokenBucketLimiter {
  return new PostgresTokenBucketLimiter(executor, {
    tableName: TABLE,
    namespace: NS,
    defaultConfig: CONFIG,
    now: frozenClock,
    ...opts,
  });
}

describe("PostgresTokenBucketLimiter — construction", () => {
  it("throws RateLimitConfigError on empty tableName", () => {
    expect(
      () => new PostgresTokenBucketLimiter(new FakeSql(), { tableName: "", namespace: NS }),
    ).toThrow(RateLimitConfigError);
  });

  it("throws RateLimitConfigError on empty namespace", () => {
    expect(
      () => new PostgresTokenBucketLimiter(new FakeSql(), { tableName: TABLE, namespace: "" }),
    ).toThrow(RateLimitConfigError);
  });

  it("throws RateLimitConfigError on invalid defaultConfig", () => {
    expect(
      () =>
        new PostgresTokenBucketLimiter(new FakeSql(), {
          tableName: TABLE,
          namespace: NS,
          defaultConfig: { capacity: 0, refillRate: 1 },
        }),
    ).toThrow(RateLimitConfigError);
  });
});

describe("PostgresTokenBucketLimiter — consume across capacity", () => {
  it("allows up to capacity then denies (frozen clock, no refill)", async () => {
    const sql = new FakeSql();
    const limiter = makeLimiter(sql);

    const remainings: number[] = [];
    for (let i = 0; i < CONFIG.capacity; i += 1) {
      const r = await limiter.consume("key", 1);
      expect(r.allowed).toBe(true);
      remainings.push(r.remaining);
    }
    expect(remainings).toEqual([4, 3, 2, 1, 0]);

    const denied = await limiter.consume("key", 1);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("first call creates the row via INSERT; later calls UPDATE the same row", async () => {
    const sql = new FakeSql();
    const limiter = makeLimiter(sql);

    await limiter.consume("key", 1);
    expect(sql.store.size).toBe(1);
    const stored = sql.store.get(`${NS}#key`);
    expect(stored?.tokens).toBeCloseTo(4);

    await limiter.consume("key", 2);
    expect(sql.store.get(`${NS}#key`)?.tokens).toBeCloseTo(2);
  });
});

describe("PostgresTokenBucketLimiter — peek", () => {
  it("does not write and reports the full bucket for a new key", async () => {
    const sql = new FakeSql();
    const limiter = makeLimiter(sql);

    const r = await limiter.peek("key");
    expect(r.remaining).toBe(CONFIG.capacity);
    expect(r.allowed).toBe(true);
    expect(sql.writeCount).toBe(0);
    expect(sql.store.size).toBe(0);
  });
});

describe("PostgresTokenBucketLimiter — reset", () => {
  it("deletes the bucket row so the caller gets a fresh full bucket", async () => {
    const sql = new FakeSql();
    const limiter = makeLimiter(sql);

    await limiter.consume("key", 3);
    expect(sql.store.size).toBe(1);

    await limiter.reset("key");
    expect(sql.store.has(`${NS}#key`)).toBe(false);

    const r = await limiter.peek("key");
    expect(r.remaining).toBe(CONFIG.capacity);
  });
});

describe("PostgresTokenBucketLimiter — unknownKeyStrategy", () => {
  it("reject: denies without a round-trip", async () => {
    const sql = new FakeSql();
    const limiter = makeLimiter(sql, { unknownKeyStrategy: "reject" });

    const r = await limiter.consume("ip:unknown", 1);
    expect(r.allowed).toBe(false);
    expect(sql.selectCount).toBe(0);
    expect(sql.writeCount).toBe(0);
    expect(sql.store.size).toBe(0);
  });

  it("shared-bucket: unknown-key calls hit the shared row", async () => {
    const sql = new FakeSql();
    const limiter = makeLimiter(sql, { unknownKeyStrategy: "shared-bucket" });

    const r = await limiter.consume("ip:unknown", 1);
    expect(r.allowed).toBe(true);
    expect(sql.store.size).toBe(1);
  });

  it("allow: unknown-key calls pass through the bucket (used as-is)", async () => {
    const sql = new FakeSql();
    const limiter = makeLimiter(sql, { unknownKeyStrategy: "allow" });

    const r = await limiter.consume("ip:unknown", 1);
    expect(r.allowed).toBe(true);
    expect(sql.store.size).toBe(1);
  });
});

describe("PostgresTokenBucketLimiter — F5 bounded retry + fail-open", () => {
  it("retries on a 40001 serialization failure and eventually succeeds", async () => {
    const sql = new FakeSql();
    let failures = 0;
    // Fail the first two write attempts, then let the third succeed.
    sql.writeFault = (): Error | undefined => {
      if (failures < 2) {
        failures += 1;
        return pgError("40001");
      }
      return undefined;
    };

    const limiter = makeLimiter(sql);
    const r = await limiter.consume("key", 1);

    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(4);
    // 3 write attempts total (2 failed + 1 success).
    expect(sql.writeCount).toBe(3);
    // The write eventually landed.
    expect(sql.store.size).toBe(1);
  });

  it("fails OPEN when every write throws 40001 — does not throw, returns computed ALLOW", async () => {
    const sql = new FakeSql();
    sql.writeFault = (): Error => pgError("40001");

    const capture = createTestLogCapture();
    capture.installAsRoot();
    try {
      const limiter = makeLimiter(sql);

      // Must NOT reject, even though the write never lands.
      const r = await limiter.consume("key", 1);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(4);

      // Exhausted the retry budget: MAX_RETRIES = 3 attempts.
      expect(sql.writeCount).toBe(3);
      // Nothing was persisted (all writes threw).
      expect(sql.store.size).toBe(0);

      const entries = capture.entries();
      // Best-effort fail-open warning.
      expect(
        entries.some((e) => e.msg.includes("returning computed result")),
      ).toBe(true);
      // Distinct contention-ceiling signal so the ceiling is observable.
      expect(
        entries.some((e) => e.contention === true),
      ).toBe(true);
    } finally {
      capture.restore();
    }
  });

  it("fails OPEN on a non-retryable write error without a contention signal", async () => {
    const sql = new FakeSql();
    sql.writeFault = (): Error => pgError("23505"); // some other, non-retryable error

    const capture = createTestLogCapture();
    capture.installAsRoot();
    try {
      const limiter = makeLimiter(sql);
      const r = await limiter.consume("key", 1);
      expect(r.allowed).toBe(true);

      // Non-retryable → no retries.
      expect(sql.writeCount).toBe(1);

      const entries = capture.entries();
      expect(entries.some((e) => e.msg.includes("returning computed result"))).toBe(true);
      // No contention signal for a non-retryable error.
      expect(entries.some((e) => e.contention === true)).toBe(false);
    } finally {
      capture.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// OPTIONAL real-Postgres lane — self-skips when the DB is unreachable.
// Exercises REAL row-lock contention against the actual retry path.
// ---------------------------------------------------------------------------

const CONNECTION_STRING =
  process.env["KV_TEST_DATABASE_URL"] ??
  process.env["DATABASE_URL"] ??
  "postgres://test:test@localhost:5433/kvtest";

function probe(url: string, timeoutMs = 750): Promise<boolean> {
  let hostname: string;
  let port: number;
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname;
    port = Number(parsed.port === "" ? "5432" : parsed.port);
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const sock = net.connect({ host: hostname, port });
    const done = (ok: boolean): void => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

const RL_DDL = `
  CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    bucket_key     text             PRIMARY KEY,
    tokens         double precision NOT NULL,
    last_refill_ms bigint           NOT NULL,
    expires_at     timestamptz
  );
`;

const reachable = await probe(CONNECTION_STRING);

if (!reachable) {
  describe.skip("PostgresTokenBucketLimiter — real Postgres (unavailable)", () => {
    it("skipped — start a Postgres container to run this lane", () => {
      /* skipped */
    });
  });
} else {
  const pool = new Pool({ connectionString: CONNECTION_STRING, max: 12 });
  const executor: SqlExecutor = {
    query: <R = Record<string, unknown>>(text: string, params: readonly unknown[]) =>
      pool.query(text, params as unknown[]) as Promise<{ rows: R[] }>,
  };

  beforeAll(async () => {
    await pool.query(RL_DDL, []);
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("PostgresTokenBucketLimiter — real Postgres", () => {
    it("consumes across capacity then denies, and reset restores the bucket", async () => {
      const namespace = `rl-${randomUUID().slice(0, 8)}`;
      const limiter = new PostgresTokenBucketLimiter(executor, {
        tableName: TABLE,
        namespace,
        defaultConfig: CONFIG,
        now: frozenClock,
      });

      for (let i = 0; i < CONFIG.capacity; i += 1) {
        const r = await limiter.consume("k", 1);
        expect(r.allowed).toBe(true);
      }
      const denied = await limiter.consume("k", 1);
      expect(denied.allowed).toBe(false);

      await limiter.reset("k");
      const afterReset = await limiter.peek("k");
      expect(afterReset.remaining).toBe(CONFIG.capacity);
    });

    it("survives real row-lock contention (concurrent consumes settle, fail-open)", async () => {
      const namespace = `rl-${randomUUID().slice(0, 8)}`;
      const limiter = new PostgresTokenBucketLimiter(executor, {
        tableName: TABLE,
        namespace,
        defaultConfig: CONFIG,
        now: frozenClock,
      });

      // Fire capacity concurrent cost-1 consumes at one fresh bucket. This drives
      // the REAL INSERT-race / UPDATE-CAS retry path against Postgres. Under a
      // frozen clock all writers share one `last_refill_ms`, so the CAS cannot
      // version-distinguish them (same limitation as the Dynamo limiter) — the
      // guarantee under contention is therefore fail-OPEN: every consume SETTLES
      // (never throws) and returns a decision, and the row is persisted.
      const results = await Promise.all(
        Array.from({ length: CONFIG.capacity }, () => limiter.consume("hot", 1)),
      );
      expect(results).toHaveLength(CONFIG.capacity);
      for (const r of results) {
        expect(typeof r.allowed).toBe("boolean");
      }
      // At least the uncontended winner was allowed and the bucket row exists.
      expect(results.some((r) => r.allowed)).toBe(true);
      const { rows } = await pool.query(
        `SELECT bucket_key FROM ${TABLE} WHERE bucket_key = $1`,
        [`${namespace}#hot`],
      );
      expect(rows).toHaveLength(1);
    });
  });
}
