/**
 * PostgresKvStore — the Scaleway-target `KvStore` adapter (ws1-kv-port-plan §4.2).
 *
 * QUARANTINE: reached ONLY via the `@de-otio/saas-foundation/kv/postgres`
 * sub-path, never the core `kv` barrel — this keeps all SQL/`pg` surface out of
 * the core module, mirroring the `audit/prisma` precedent. The adapter depends
 * on a *structural* {@link SqlExecutor} (satisfied by both a `pg.Pool` and a thin
 * Prisma `$queryRawUnsafe` wrapper), so foundation takes on NO `pg` runtime
 * dependency.
 *
 * ## One table, all namespaces
 * Every row lives in `kv_entries (namespace, key, value jsonb, version bigint,
 * expires_at timestamptz?, indexed_key text?)` with a composite `(namespace,key)`
 * primary key. An instance is bound to one `namespace`; **every statement carries
 * the `namespace=$1` predicate — it is NEVER dropped (F8).** The composite PK and
 * `(namespace, indexed_key)` index make `(namespace,key)` / `(namespace,
 * indexed_key)` the only scoping, so cross-namespace collision is impossible by
 * construction (no pk-separator concern as on DynamoDB — F4 is a no-op here).
 *
 * ## Atomicity
 * Every primitive is a SINGLE statement, atomic under Postgres row locks — no
 * explicit `BEGIN`. `increment`'s `INSERT … ON CONFLICT` takes a row lock on
 * conflict, serialising concurrent adds correctly (real row-lock atomicity, the
 * F11 concurrency lane).
 *
 * ## Injected clock (frozen-clock default)
 * `$now` is the injected clock's value bound as a `timestamptz` param — NOT the
 * SQL `now()` function — so tests freeze it deterministically. `expires_at` is
 * stored as a `timestamptz`; the port's `expiresAt` is epoch SECONDS, so writes
 * convert seconds→`Date` and reads use `extract(epoch from expires_at)`.
 */

import type { KvStore, KvRecord, KvWriteOptions, KvCasResult } from "./store-types.js";
import { KV_FIELD_PATTERN } from "./store-types.js";

/**
 * Minimal parameterized-query surface the adapter depends on. Matches
 * `pg.Pool.query(text, params)` and a thin Prisma `$queryRawUnsafe` wrapper.
 * Trellis supplies a dedicated small `pg.Pool` (KV is global, NOT tenant-scoped,
 * so it must bypass the tenant-scoping Prisma extension).
 */
export interface SqlExecutor {
  query<R = Record<string, unknown>>(
    text: string,
    params: readonly unknown[],
  ): Promise<{ readonly rows: R[] }>;
}

export interface PostgresKvStoreOptions {
  /** The bound namespace (one of `KV_NAMESPACES`). */
  readonly namespace: string;
  /** Injected clock, epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Row shape returned by the read/write statements. */
interface KvRow {
  readonly value: unknown;
  readonly version: string | number | bigint;
  readonly exp: string | number | null;
  readonly key?: string;
}

export class PostgresKvStore implements KvStore {
  private readonly namespace: string;
  private readonly now: () => number;

  constructor(
    private readonly executor: SqlExecutor,
    options: PostgresKvStoreOptions,
  ) {
    this.namespace = options.namespace;
    this.now = options.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // Pure helpers
  // -------------------------------------------------------------------------

  private nowDate(): Date {
    return new Date(this.now());
  }

  /** Absolute expiry (epoch seconds) resolved from write options, or undefined. */
  private resolveExpirySeconds(opts?: KvWriteOptions): number | undefined {
    if (opts?.expiresAt !== undefined) return opts.expiresAt;
    if (opts?.ttlSeconds !== undefined) return Math.floor(this.now() / 1000) + opts.ttlSeconds;
    return undefined;
  }

  /** Epoch-seconds expiry -> `timestamptz` bind value (`Date`), or null. */
  private expiryParam(seconds: number | undefined): Date | null {
    return seconds === undefined ? null : new Date(seconds * 1000);
  }

  private rowToRecord<T>(row: KvRow): KvRecord<T> {
    const version = Number(row.version);
    const value = row.value as T;
    if (row.exp === null || row.exp === undefined) return { value, version };
    return { value, version, expiresAt: Math.floor(Number(row.exp)) };
  }

  /**
   * Turn a `RETURNING version` write-row into an applied `KvCasResult`, or
   * `undefined` when the conditional write matched no row (caller then reports
   * `applied:false` with the current live record).
   */
  private appliedCas<T>(
    row: { readonly version: string | number } | undefined,
    value: T,
    expiry: number | undefined,
  ): KvCasResult<T> | undefined {
    if (row === undefined) return undefined;
    const version = Number(row.version);
    const record: KvRecord<T> =
      expiry === undefined ? { value, version } : { value, version, expiresAt: expiry };
    return { applied: true, record };
  }

  // -------------------------------------------------------------------------
  // get — TTL-expiry-aware point read
  // -------------------------------------------------------------------------

  async get<T>(
    key: string,
    opts?: { readonly consistent?: boolean; readonly includeExpired?: boolean },
  ): Promise<KvRecord<T> | null> {
    // Postgres is strongly consistent on a single primary; `consistent` is a
    // no-op (the read always reflects the latest committed write). With
    // `includeExpired`, drop the expiry predicate so an expired-but-unswept row
    // is returned (survives until the cleanup cron / next overwrite) — the
    // TTL-ignoring read for getActiveTenantPreference.
    const expiryClause = opts?.includeExpired === true ? "" : " AND (expires_at IS NULL OR expires_at > $3)";
    const params: unknown[] =
      opts?.includeExpired === true ? [this.namespace, key] : [this.namespace, key, this.nowDate()];
    const { rows } = await this.executor.query<KvRow>(
      `SELECT value, version, extract(epoch from expires_at) AS exp
         FROM kv_entries
        WHERE namespace = $1 AND key = $2${expiryClause}`,
      params,
    );
    const row = rows[0];
    return row === undefined ? null : this.rowToRecord<T>(row);
  }

  // -------------------------------------------------------------------------
  // put — unconditional overwrite (single atomic UPSERT)
  // -------------------------------------------------------------------------

  async put<T>(key: string, value: T, opts?: KvWriteOptions): Promise<KvRecord<T>> {
    const expiry = this.resolveExpirySeconds(opts);
    const { rows } = await this.executor.query<{ version: string | number }>(
      `INSERT INTO kv_entries (namespace, key, value, version, expires_at, indexed_key)
            VALUES ($1, $2, $3::jsonb, 1, $4, $5)
       ON CONFLICT (namespace, key) DO UPDATE
            SET value = $3::jsonb,
                version = kv_entries.version + 1,
                expires_at = $4,
                indexed_key = $5
        RETURNING version`,
      [this.namespace, key, JSON.stringify(value), this.expiryParam(expiry), opts?.indexedKey ?? null],
    );
    const version = Number(rows[0]?.version ?? 1);
    return expiry === undefined
      ? { value, version }
      : { value, version, expiresAt: expiry };
  }

  // -------------------------------------------------------------------------
  // putIfAbsent — create-once, expired-as-absent (F1)
  // -------------------------------------------------------------------------

  async putIfAbsent<T>(
    key: string,
    value: T,
    opts?: KvWriteOptions & { readonly overwriteExpired?: boolean },
  ): Promise<KvCasResult<T>> {
    const expiry = this.resolveExpirySeconds(opts);
    // absent -> INSERT (applied); conflict + expired -> overwrite (applied);
    // conflict + live -> 0 rows (applied:false). `overwriteExpired` does not
    // change the SQL — expired-as-absent is uniform (F1), the flag is an intent
    // marker only. Version bumps on takeover (lock-token uniqueness).
    const { rows } = await this.executor.query<{ version: string | number }>(
      `INSERT INTO kv_entries (namespace, key, value, version, expires_at, indexed_key)
            VALUES ($1, $2, $3::jsonb, 1, $4, $5)
       ON CONFLICT (namespace, key) DO UPDATE
            SET value = $3::jsonb,
                version = kv_entries.version + 1,
                expires_at = $4,
                indexed_key = $5
          WHERE kv_entries.expires_at IS NOT NULL AND kv_entries.expires_at < $6
        RETURNING version`,
      [
        this.namespace,
        key,
        JSON.stringify(value),
        this.expiryParam(expiry),
        opts?.indexedKey ?? null,
        this.nowDate(),
      ],
    );
    const applied = this.appliedCas(rows[0], value, expiry);
    if (applied !== undefined) return applied;
    // Live row already present — return the winner's record.
    return { applied: false, record: await this.get<T>(key) };
  }

  // -------------------------------------------------------------------------
  // compareAndSet — optimistic write on version
  // -------------------------------------------------------------------------

  async compareAndSet<T>(
    key: string,
    expectedVersion: number,
    value: T,
    opts?: KvWriteOptions,
  ): Promise<KvCasResult<T>> {
    const expiry = this.resolveExpirySeconds(opts);
    if (expectedVersion === 0) {
      // Require absence (or an expired-but-unswept row) — same expired-as-absent
      // semantics as putIfAbsent, so a CAS-create matches the memory adapter.
      const { rows } = await this.executor.query<{ version: string | number }>(
        `INSERT INTO kv_entries (namespace, key, value, version, expires_at, indexed_key)
              VALUES ($1, $2, $3::jsonb, 1, $4, $5)
         ON CONFLICT (namespace, key) DO UPDATE
              SET value = $3::jsonb,
                  version = kv_entries.version + 1,
                  expires_at = $4,
                  indexed_key = $5
            WHERE kv_entries.expires_at IS NOT NULL AND kv_entries.expires_at < $6
          RETURNING version`,
        [
          this.namespace,
          key,
          JSON.stringify(value),
          this.expiryParam(expiry),
          opts?.indexedKey ?? null,
          this.nowDate(),
        ],
      );
      const applied = this.appliedCas(rows[0], value, expiry);
      if (applied !== undefined) return applied;
      return { applied: false, record: await this.get<T>(key) };
    }

    const { rows } = await this.executor.query<{ version: string | number }>(
      `UPDATE kv_entries
          SET value = $3::jsonb,
              version = version + 1,
              expires_at = $4,
              indexed_key = $5
        WHERE namespace = $1 AND key = $2 AND version = $6
          AND (expires_at IS NULL OR expires_at > $7)
      RETURNING version`,
      [
        this.namespace,
        key,
        JSON.stringify(value),
        this.expiryParam(expiry),
        opts?.indexedKey ?? null,
        expectedVersion,
        this.nowDate(),
      ],
    );
    const applied = this.appliedCas(rows[0], value, expiry);
    if (applied !== undefined) return applied;
    return { applied: false, record: await this.get<T>(key) };
  }

  // -------------------------------------------------------------------------
  // putIfFresher — TTL-monotonic conditional put (F2)
  // -------------------------------------------------------------------------

  async putIfFresher<T>(
    key: string,
    value: T,
    opts: KvWriteOptions & { readonly expiresAt: number },
  ): Promise<KvCasResult<T>> {
    const incoming = opts.expiresAt;
    const incomingDate = new Date(incoming * 1000);
    // absent -> insert; incoming strictly newer -> overwrite; older-or-equal ->
    // 0 rows (applied:false). Monotonic freshness in one atomic statement — a
    // stale (older-expiry) write can never win, even if higher-privilege (F2).
    const { rows } = await this.executor.query<{ version: string | number }>(
      `INSERT INTO kv_entries (namespace, key, value, version, expires_at, indexed_key)
            VALUES ($1, $2, $3::jsonb, 1, $4, $5)
       ON CONFLICT (namespace, key) DO UPDATE
            SET value = $3::jsonb,
                version = kv_entries.version + 1,
                expires_at = $4,
                indexed_key = $5
          WHERE kv_entries.expires_at IS NULL OR kv_entries.expires_at < $4
        RETURNING version`,
      [this.namespace, key, JSON.stringify(value), incomingDate, opts.indexedKey ?? null],
    );
    const applied = this.appliedCas(rows[0], value, incoming);
    if (applied !== undefined) return applied;
    return { applied: false, record: await this.get<T>(key) };
  }

  // -------------------------------------------------------------------------
  // increment — atomic numeric add on a top-level jsonb field, set-once TTL (F3)
  // -------------------------------------------------------------------------

  async increment(
    key: string,
    field: string,
    delta: number,
    opts?: KvWriteOptions,
  ): Promise<number> {
    if (!KV_FIELD_PATTERN.test(field)) {
      // Guards the `jsonb_set` path against document corruption via path
      // segments / `__proto__`. No key or value bytes in the message (F12).
      throw new TypeError(`increment: invalid field identifier (op=increment)`);
    }
    const expiry = this.resolveExpirySeconds(opts);
    // `$4` (field) is safe: validated against KV_FIELD_PATTERN above, and still
    // passed as a bind param (never interpolated). Set-once TTL via COALESCE;
    // version bumped so a concurrent compareAndSet observes the add.
    const { rows } = await this.executor.query<{ result: string | number }>(
      `INSERT INTO kv_entries (namespace, key, value, version, expires_at)
            VALUES ($1, $2, jsonb_build_object($3::text, to_jsonb($4::numeric)), 1, $5)
       ON CONFLICT (namespace, key) DO UPDATE
            SET value = jsonb_set(
                  kv_entries.value,
                  ARRAY[$3::text],
                  to_jsonb(COALESCE((kv_entries.value ->> $3)::numeric, 0) + $4::numeric)
                ),
                version = kv_entries.version + 1,
                expires_at = COALESCE(kv_entries.expires_at, $5)
        RETURNING (value ->> $3) AS result`,
      [this.namespace, key, field, delta, this.expiryParam(expiry)],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new TypeError(`increment: no row returned (op=increment)`);
    }
    return Number(row.result);
  }

  // -------------------------------------------------------------------------
  // delete — unconditional or version-guarded
  // -------------------------------------------------------------------------

  async delete(key: string, expectedVersion?: number): Promise<boolean> {
    // Operates on the physical row regardless of TTL-expiry (matches DynamoDB
    // DeleteItem). `RETURNING` gives an accurate applied count via row length.
    const guard = expectedVersion !== undefined ? " AND version = $3" : "";
    const params: unknown[] =
      expectedVersion !== undefined
        ? [this.namespace, key, expectedVersion]
        : [this.namespace, key];
    const { rows } = await this.executor.query<{ key: string }>(
      `DELETE FROM kv_entries WHERE namespace = $1 AND key = $2${guard} RETURNING key`,
      params,
    );
    return rows.length > 0;
  }

  // -------------------------------------------------------------------------
  // queryByIndex — single named secondary-index lookup
  // -------------------------------------------------------------------------

  async queryByIndex<T>(
    indexValue: string,
  ): Promise<ReadonlyArray<KvRecord<T> & { readonly key: string }>> {
    const { rows } = await this.executor.query<KvRow>(
      `SELECT key, value, version, extract(epoch from expires_at) AS exp
         FROM kv_entries
        WHERE namespace = $1 AND indexed_key = $2
          AND (expires_at IS NULL OR expires_at > $3)`,
      [this.namespace, indexValue, this.nowDate()],
    );
    return rows.map((row) => ({ ...this.rowToRecord<T>(row), key: row.key ?? "" }));
  }
}

/**
 * Reclaim space held by expired rows (Postgres has no native TTL; `get` /
 * `queryByIndex` already filter expired rows, so correctness never depends on
 * this running). WS-1 ships the function; WS-2 schedules it as the 6th cron
 * `kv-entries-cleanup` (Scaleway-profile only — X5).
 *
 * **F10 — the `expires_at IS NOT NULL` guard is mandatory.** The durable,
 * no-TTL namespaces (`discexposure` monthly counters, `agent-refresh` sessions)
 * store `expires_at = NULL` and MUST NEVER be swept. `$1` is the injected clock
 * as a `timestamptz` param, not `now()`, so the sweep is testable.
 *
 * @returns the number of rows deleted.
 */
export async function sweepExpiredKvEntries(
  executor: SqlExecutor,
  now: () => number,
): Promise<number> {
  const { rows } = await executor.query<{ key: string }>(
    `DELETE FROM kv_entries
      WHERE expires_at IS NOT NULL AND expires_at < $1
    RETURNING key`,
    [new Date(now())],
  );
  return rows.length;
}
