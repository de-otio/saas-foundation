/**
 * MemoryKv — in-memory KVNamespace for tests and local development.
 *
 * @beta-test-only Do not use in production. This implementation has no
 * cross-process visibility, no persistence, and no concurrency primitives.
 * It exists as a convenience for downstream module tests that need a KV
 * without LocalStack or DynamoDB.
 */

import type { KVNamespace, KvPutOptions, KvListOptions, KvListResult } from "./cloudflare-types.js";

interface MemoryEntry {
  value: string;
  metadata?: string;
  expiration?: number; // epoch seconds
}

export class MemoryKv implements KVNamespace {
  private readonly store = new Map<string, MemoryEntry>();

  private isExpired(entry: MemoryEntry): boolean {
    return entry.expiration !== undefined && entry.expiration < Math.floor(Date.now() / 1000);
  }

  get(key: string, type?: "text"): Promise<string | null>;
  get<T = unknown>(key: string, type: "json"): Promise<T | null>;
  get<T = unknown>(key: string, type?: "text" | "json"): Promise<string | T | null> {
    const entry = this.store.get(key);
    if (entry === undefined || this.isExpired(entry)) return Promise.resolve(null);

    if (type === "json") {
      try {
        return Promise.resolve(JSON.parse(entry.value) as T);
      } catch {
        return Promise.resolve(null);
      }
    }
    return Promise.resolve(entry.value);
  }

  getWithMetadata<T>(
    key: string,
  ): Promise<{ readonly value: string | null; readonly metadata: T | null }> {
    const entry = this.store.get(key);
    if (entry === undefined || this.isExpired(entry)) {
      return Promise.resolve({ value: null, metadata: null });
    }

    const metadata: T | null =
      entry.metadata !== undefined ? (JSON.parse(entry.metadata) as T) : null;

    return Promise.resolve({ value: entry.value, metadata });
  }

  put(key: string, value: string | ArrayBuffer, options?: KvPutOptions): Promise<void> {
    const strValue = typeof value === "string" ? value : Buffer.from(value).toString("utf-8");

    let expiration: number | undefined;
    if (options?.expiration !== undefined) {
      expiration = options.expiration;
    } else if (options?.expirationTtl !== undefined) {
      expiration = Math.floor(Date.now() / 1000) + options.expirationTtl;
    }

    const entry: MemoryEntry = { value: strValue };
    if (options?.metadata !== undefined) entry.metadata = JSON.stringify(options.metadata);
    if (expiration !== undefined) entry.expiration = expiration;
    this.store.set(key, entry);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }

  list(options?: KvListOptions): Promise<KvListResult> {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;

    // TTL filtering is applied via isExpired() inside the filter predicate.
    const all = [...this.store.entries()]
      .filter(([k, entry]) => k.startsWith(prefix) && !this.isExpired(entry))
      .map(([k, entry]) =>
        entry.expiration !== undefined ? { name: k, expiration: entry.expiration } : { name: k },
      );

    // Simple cursor: treat cursor as an index string
    let startIdx = 0;
    if (options?.cursor !== undefined) {
      const idx = parseInt(options.cursor, 10);
      if (!isNaN(idx)) startIdx = idx;
    }

    const page = all.slice(startIdx, startIdx + limit);
    const nextStart = startIdx + page.length;
    const list_complete = nextStart >= all.length;

    return Promise.resolve({
      keys: page,
      list_complete,
      ...(list_complete ? {} : { cursor: String(nextStart) }),
    });
  }
}
