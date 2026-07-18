/**
 * MemoryKvStore — in-memory `KvStore` for tests and local development.
 *
 * @beta-test-only Do not use in production. No cross-process visibility, no
 * persistence. Because it is single-threaded its "concurrency" is simulated:
 * it is the fast, deterministic lane of the adapter-contract suite and the
 * default unit-test mock, but it CANNOT catch a real lost-update/lock bug — the
 * required real-concurrency cases run against DynamoKvStore/PostgresKvStore.
 *
 * The injected `now` clock (epoch ms, default `Date.now`) is MANDATORY for
 * deterministic frozen-clock expiry tests (this plan's TTL tests + WS-2's
 * scheduler test). Every expiry decision routes through it.
 *
 * ## Version rules (mirrored byte-for-byte by DynamoKvStore)
 * - `put` / `putIfAbsent`(create) / `compareAndSet`(create) start a fresh key
 *   at version 1; every overwrite of a physically-present row bumps the row's
 *   version by exactly 1 (so a crashed lock-holder's stale version-guarded
 *   `delete` fails after an expired-takeover).
 * - `putIfFresher` is the claims-cache freshness primitive: it is NOT mixed
 *   with version-CAS on the same key, so its applied write resets version to 1
 *   (matching a single conditional PutItem with an additive `_v`). Do not rely
 *   on version monotonicity for a `putIfFresher`-only key.
 * - `increment` MERGES one field on the physically-present row (matching
 *   DynamoDB `ADD`): it operates on the stored counter even if TTL-expired but
 *   unswept, and refreshes TTL only when the row had none (set-once).
 */

import type { KvStore, KvRecord, KvWriteOptions, KvCasResult } from "./store-types.js";
import { KV_FIELD_PATTERN } from "./store-types.js";

interface MemoryEntry {
  value: unknown;
  version: number;
  expiresAt?: number; // epoch seconds
  indexedKey?: string;
}

export interface MemoryKvStoreOptions {
  /** Injected clock, epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export class MemoryKvStore implements KvStore {
  private readonly store = new Map<string, MemoryEntry>();
  private readonly now: () => number;

  constructor(options: MemoryKvStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // Pure helpers
  // -------------------------------------------------------------------------

  private nowSeconds(): number {
    return Math.floor(this.now() / 1000);
  }

  /** Absolute expiry (epoch seconds) resolved from write options, or undefined. */
  private resolveExpiry(opts?: KvWriteOptions): number | undefined {
    if (opts?.expiresAt !== undefined) return opts.expiresAt;
    if (opts?.ttlSeconds !== undefined) return this.nowSeconds() + opts.ttlSeconds;
    return undefined;
  }

  private isExpired(entry: MemoryEntry): boolean {
    return entry.expiresAt !== undefined && entry.expiresAt < this.nowSeconds();
  }

  private toRecord<T>(entry: MemoryEntry): KvRecord<T> {
    const value = structuredClone(entry.value) as T;
    return entry.expiresAt !== undefined
      ? { value, version: entry.version, expiresAt: entry.expiresAt }
      : { value, version: entry.version };
  }

  /** Build a stored entry, cloning the value to defeat external aliasing. */
  private makeEntry(
    value: unknown,
    version: number,
    expiresAt: number | undefined,
    indexedKey: string | undefined,
  ): MemoryEntry {
    const entry: MemoryEntry = { value: structuredClone(value), version };
    if (expiresAt !== undefined) entry.expiresAt = expiresAt;
    if (indexedKey !== undefined) entry.indexedKey = indexedKey;
    return entry;
  }

  // -------------------------------------------------------------------------
  // get
  // -------------------------------------------------------------------------

  get<T>(key: string, _opts?: { readonly consistent?: boolean }): Promise<KvRecord<T> | null> {
    const entry = this.store.get(key);
    if (entry === undefined || this.isExpired(entry)) return Promise.resolve(null);
    return Promise.resolve(this.toRecord<T>(entry));
  }

  // -------------------------------------------------------------------------
  // put — unconditional overwrite
  // -------------------------------------------------------------------------

  put<T>(key: string, value: T, opts?: KvWriteOptions): Promise<KvRecord<T>> {
    const existing = this.store.get(key);
    const version = (existing?.version ?? 0) + 1;
    const entry = this.makeEntry(value, version, this.resolveExpiry(opts), opts?.indexedKey);
    this.store.set(key, entry);
    return Promise.resolve(this.toRecord<T>(entry));
  }

  // -------------------------------------------------------------------------
  // putIfAbsent — create-once, expired-as-absent (F1)
  // -------------------------------------------------------------------------

  putIfAbsent<T>(
    key: string,
    value: T,
    opts?: KvWriteOptions & { readonly overwriteExpired?: boolean },
  ): Promise<KvCasResult<T>> {
    const existing = this.store.get(key);
    if (existing !== undefined && !this.isExpired(existing)) {
      // A live record already exists — reject and return the winner's record.
      return Promise.resolve({ applied: false, record: this.toRecord<T>(existing) });
    }
    // Absent, or expired-but-unswept -> treat as absent and write. An
    // expired-takeover bumps the prior version (lock-token uniqueness); a fresh
    // create starts at 1.
    const version = (existing?.version ?? 0) + 1;
    const entry = this.makeEntry(value, version, this.resolveExpiry(opts), opts?.indexedKey);
    this.store.set(key, entry);
    return Promise.resolve({ applied: true, record: this.toRecord<T>(entry) });
  }

  // -------------------------------------------------------------------------
  // compareAndSet — optimistic write on version
  // -------------------------------------------------------------------------

  compareAndSet<T>(
    key: string,
    expectedVersion: number,
    value: T,
    opts?: KvWriteOptions,
  ): Promise<KvCasResult<T>> {
    const existing = this.store.get(key);
    const live = existing !== undefined && !this.isExpired(existing);
    const currentVersion = live ? existing.version : 0;
    if (currentVersion !== expectedVersion) {
      return Promise.resolve({
        applied: false,
        record: live ? this.toRecord<T>(existing) : null,
      });
    }
    const entry = this.makeEntry(
      value,
      expectedVersion + 1,
      this.resolveExpiry(opts),
      opts?.indexedKey,
    );
    this.store.set(key, entry);
    return Promise.resolve({ applied: true, record: this.toRecord<T>(entry) });
  }

  // -------------------------------------------------------------------------
  // putIfFresher — TTL-monotonic conditional put (F2)
  // -------------------------------------------------------------------------

  putIfFresher<T>(
    key: string,
    value: T,
    opts: KvWriteOptions & { readonly expiresAt: number },
  ): Promise<KvCasResult<T>> {
    const incoming = opts.expiresAt;
    const existing = this.store.get(key);
    const live = existing !== undefined && !this.isExpired(existing);
    // Freshness guard: absent/expired -> write; live -> write iff no stored
    // expiry OR the incoming expiry is strictly newer (claims-cache
    // `attribute_not_exists(#ttl) OR #ttl < :incomingTtl`).
    const canWrite =
      !live || existing.expiresAt === undefined || existing.expiresAt < incoming;
    if (!canWrite) {
      return Promise.resolve({ applied: false, record: this.toRecord<T>(existing) });
    }
    // Version resets to 1 (single conditional PutItem, additive `_v`) — this
    // key is not mixed with version-CAS. See class docs.
    const entry = this.makeEntry(value, 1, incoming, opts.indexedKey);
    this.store.set(key, entry);
    return Promise.resolve({ applied: true, record: this.toRecord<T>(entry) });
  }

  // -------------------------------------------------------------------------
  // increment — atomic numeric add on a top-level field (merge; F3)
  // -------------------------------------------------------------------------

  increment(key: string, field: string, delta: number, opts?: KvWriteOptions): Promise<number> {
    if (!KV_FIELD_PATTERN.test(field)) {
      // Rejected promise (not a synchronous throw) so the async adapters and
      // this one present an identical failure surface to callers.
      return Promise.reject(new TypeError(`increment: invalid field identifier (op=increment)`));
    }
    // Operates on the physically-present row even if TTL-expired-but-unswept,
    // matching DynamoDB `ADD`. TTL is set-once (only when the row had none).
    const existing = this.store.get(key);
    const base =
      existing !== undefined && typeof existing.value === "object" && existing.value !== null
        ? (existing.value as Record<string, unknown>)
        : {};
    const current = Number(base[field] ?? 0);
    const next = current + delta;
    const newValue = { ...base, [field]: next };
    const version = (existing?.version ?? 0) + 1;
    const expiresAt = existing?.expiresAt ?? this.resolveExpiry(opts);
    const entry = this.makeEntry(newValue, version, expiresAt, existing?.indexedKey);
    this.store.set(key, entry);
    return Promise.resolve(next);
  }

  // -------------------------------------------------------------------------
  // delete — unconditional or version-guarded
  // -------------------------------------------------------------------------

  delete(key: string, expectedVersion?: number): Promise<boolean> {
    const existing = this.store.get(key);
    // Operates on the physical row (matching DynamoDB DeleteItem ALL_OLD /
    // `#_v = :ev`), regardless of TTL-expiry.
    if (existing === undefined) return Promise.resolve(false);
    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      return Promise.resolve(false);
    }
    this.store.delete(key);
    return Promise.resolve(true);
  }

  // -------------------------------------------------------------------------
  // queryByIndex — single named secondary-index lookup
  // -------------------------------------------------------------------------

  queryByIndex<T>(
    indexValue: string,
  ): Promise<ReadonlyArray<KvRecord<T> & { readonly key: string }>> {
    const results: Array<KvRecord<T> & { readonly key: string }> = [];
    for (const [key, entry] of this.store.entries()) {
      if (this.isExpired(entry)) continue;
      if (entry.indexedKey !== indexValue) continue;
      results.push({ ...this.toRecord<T>(entry), key });
    }
    return Promise.resolve(results);
  }
}
