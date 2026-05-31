/**
 * `MultiAuditStore` — dual-store recipe per S-F15.
 *
 * Writes an event to two-or-more stores in parallel. Two modes:
 *
 *   - `'all-or-any'` (RECOMMENDED for security-critical writes):
 *     initiate writes to all stores in parallel; succeed if AT LEAST
 *     ONE resolves. Failed-store errors are logged via the injected
 *     logger but do NOT propagate to the caller. This is what makes
 *     audit-write integrity robust against a single-store outage.
 *
 *   - `'all'`: every store must succeed for the write to succeed.
 *     Stricter — useful when both stores are equally trusted and any
 *     divergence is itself a signal worth surfacing.
 *
 * Typical production recipe:
 *
 *   const primary   = new DynamoAuditStore(ddbClient, "app-audit");
 *   const secondary = new SomeOtherStore(...); // e.g., S3 + Object Lock
 *   const store = new MultiAuditStore([primary, secondary], { mode: "all-or-any" });
 *   const audit = new AuditLog(store);
 *
 * The S3-with-Object-Lock secondary is the canonical tamper-evident
 * sink; foundation does not ship a built-in S3 audit store because
 * Object Lock setup is consumer-side CDK. The DynamoDB Streams ->
 * Lambda -> S3 wiring is sketched in `doc/foundation/06-audit-log.md`.
 */

import { createLogger, type Logger } from "../logger/logger.js";
import type { AuditEvent } from "../types/frozen/audit.js";

import { AuditStoreError } from "./errors.js";
import type { AuditStore } from "./store.js";

export type MultiAuditStoreMode = "all-or-any" | "all";

export interface MultiAuditStoreOptions {
  /** Default `'all-or-any'`. See file header. */
  readonly mode?: MultiAuditStoreMode;

  /**
   * Logger used to report per-store failures. Required for the
   * `all-or-any` mode where errors do not propagate; the logger is the
   * only forensic signal that a write went to fewer than all stores.
   */
  readonly logger?: Logger;
}

export class MultiAuditStore implements AuditStore {
  private readonly stores: ReadonlyArray<AuditStore>;
  private readonly mode: MultiAuditStoreMode;
  private readonly logger: Logger;

  public constructor(stores: ReadonlyArray<AuditStore>, options: MultiAuditStoreOptions = {}) {
    if (stores.length === 0) {
      throw new Error("MultiAuditStore: at least one store is required");
    }
    this.stores = stores;
    this.mode = options.mode ?? "all-or-any";
    this.logger = options.logger ?? createLogger({ component: "multi-audit-store" });
  }

  public async put(event: AuditEvent, retentionSeconds: number): Promise<void> {
    const settled = await Promise.allSettled(
      this.stores.map(async (s, idx) => {
        try {
          await s.put(event, retentionSeconds);
        } catch (err) {
          // Rethrow with store-index context so the per-store log line
          // tells the operator which backend failed.
          throw new AuditStoreError(
            `MultiAuditStore[${String(idx)}] write failed: ${describeError(err)}`,
            { cause: err },
          );
        }
      }),
    );

    const failures = settled.flatMap((r, idx) =>
      r.status === "rejected" ? [{ idx, reason: r.reason as unknown }] : [],
    );
    const successes = settled.length - failures.length;

    // Surface every failure to the logger regardless of mode — the
    // forensic trail is the same whether the caller sees the error or
    // not.
    for (const f of failures) {
      this.logger.error(
        { err: f.reason, store_index: f.idx, audit_event_id: event.id },
        "MultiAuditStore: backing store write failed",
      );
    }

    if (this.mode === "all" && failures.length > 0) {
      const first = failures[0];
      throw new AuditStoreError(
        `MultiAuditStore in 'all' mode: ${String(failures.length)}/${String(settled.length)} stores failed`,
        first !== undefined ? { cause: first.reason } : undefined,
      );
    }

    if (this.mode === "all-or-any" && successes === 0) {
      const first = failures[0];
      throw new AuditStoreError(
        `MultiAuditStore in 'all-or-any' mode: all ${String(settled.length)} stores failed`,
        first !== undefined ? { cause: first.reason } : undefined,
      );
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
