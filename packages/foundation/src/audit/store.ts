/**
 * The `AuditStore` interface — pluggable persistence shape for the
 * audit writer.
 *
 * Per `doc/foundation/06-audit-log.md` § Append-only integrity, the
 * interface is deliberately minimal: only `put` mutates state. This
 * shape lets the store be implemented on top of a least-privilege IAM
 * grant — e.g., `dynamodb:PutItem` only, no `UpdateItem` /
 * `DeleteItem`. The grep test in `iam-shape.test.ts` enforces that
 * the bundled `DynamoAuditStore` honours the contract.
 *
 * The reader half (`AuditQuery`) and its accompanying `query*`
 * methods are intentionally NOT defined here. P3 ships the writer
 * path only; the reader API will land when the first consumer wires
 * an audit dashboard.
 */

import type { AuditEvent } from "../types/frozen/audit.js";

export interface AuditStore {
  /**
   * Insert a new event. MUST be implementable on top of an
   * append-only IAM grant — no update or delete paths.
   *
   * @param event             The fully-built `AuditEvent` with `id`
   *                          and `timestamp` already minted.
   * @param retentionSeconds  Time-to-live for this row in seconds
   *                          from now. The store converts this to
   *                          whatever its backend uses (DynamoDB
   *                          TTL attribute; Postgres `retention_until`
   *                          column).
   */
  put(event: AuditEvent, retentionSeconds: number): Promise<void>;
}
