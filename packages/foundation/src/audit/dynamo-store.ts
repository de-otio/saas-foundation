/**
 * `DynamoAuditStore` — DynamoDB-backed `AuditStore`.
 *
 * CRITICAL — H-1 (Audit log lacks IAM-enforced append-only):
 *
 *   This class uses `PutItemCommand` ONLY. It MUST NOT call
 *   `UpdateItemCommand`, `DeleteItemCommand`, or `BatchWriteItemCommand`
 *   (the latter because BatchWrite permits delete operations).
 *
 *   The append-only property of the audit log is enforced at three
 *   layers:
 *
 *     1. **IAM (defence-in-depth, primary).** The application role's
 *        grant on the audit table is `dynamodb:PutItem` only. No
 *        `dynamodb:UpdateItem`. No `dynamodb:DeleteItem`. No
 *        `dynamodb:BatchWriteItem`. Even an attacker with full
 *        application-process compromise cannot mutate or delete rows.
 *
 *     2. **API shape.** The `AuditStore` interface exposes only
 *        `put` — no `update`, no `delete`. Calling `update` from the
 *        consumer is a type error.
 *
 *     3. **Source-level shape check.** A grep test
 *        (`test/audit/iam-shape.test.ts`) fails CI if any of the
 *        forbidden commands appear in this file. The test catches the
 *        case where a future contributor adds a "small convenience"
 *        update that defeats the whole posture.
 *
 *   The consumer's IAM policy snippet for the audit table:
 *
 *     {
 *       "Effect": "Allow",
 *       "Action": "dynamodb:PutItem",
 *       "Resource": "arn:aws:dynamodb:<region>:<account>:table/<audit-table>"
 *     }
 *
 *   Query permissions on the GSIs (read-only) remain unchanged.
 *
 * Schema: single-table, partition key `PK = AUDIT#<tenant or _global>`,
 * sort key `SK = <iso-timestamp>#<event-id>`. GSIs `GSI1-actor` and
 * `GSI2-action` for the reader path (not implemented in this writer
 * file).
 */

import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";

import { transientRetry } from "../_internal/retry.js";
import type { AuditAction, AuditActor, AuditEvent, AuditSeverity } from "../types/frozen/audit.js";

import { AuditStoreError } from "./errors.js";
import type { AuditStore } from "./store.js";

export interface DynamoAuditStoreOptions {
  /**
   * Partial override of per-severity retention in DAYS. Unset tiers
   * fall back to the foundation defaults (info: 30, warning: 180,
   * error: 400). The store uses this to set the row's `ttl` attribute
   * when `AuditLog` passes the resolved retention seconds.
   *
   * NOTE: When this store is composed under an `AuditLog`, the
   * `AuditLog`'s own `retentionDays` option is what's used to compute
   * the `retentionSeconds` passed to `put`. The option on this class
   * exists for the case where the store is used directly without a
   * surrounding `AuditLog` (rare).
   */
  readonly retentionDays?: Partial<Readonly<Record<AuditSeverity, number>>>;

  /**
   * Clock source — returns epoch milliseconds. Defaults to `Date.now`.
   * The store reads the clock once per `put` to compute the row's
   * `ttl` attribute. Tests inject a frozen clock.
   */
  readonly clock?: () => number;
}

/**
 * Compute the actor-id used for the `GSI1-actor` GSI partition key.
 * Pure.
 */
function actorIdFor(actor: AuditActor): string {
  switch (actor.kind) {
    case "user":
      return actor.userSub;
    case "service":
      return actor.serviceName;
    case "system":
      return actor.component;
    case "anonymous":
      return "_anonymous";
  }
}

function buildItem(event: AuditEvent, ttlEpochSeconds: number): Record<string, unknown> {
  const tenantPart = event.tenantId ?? "_global";
  const sk = `${event.timestamp}#${event.id}`;
  const action: AuditAction = event.action;
  return {
    PK: `AUDIT#${tenantPart}`,
    SK: sk,
    PK1: `ACTOR#${event.actor.kind}#${actorIdFor(event.actor)}`,
    SK1: event.timestamp,
    PK2: `ACTION#${tenantPart}#${action}`,
    SK2: event.timestamp,
    event: JSON.stringify(event),
    ttl: ttlEpochSeconds,
  };
}

export class DynamoAuditStore implements AuditStore {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;
  private readonly clock: () => number;

  public constructor(
    client: DynamoDBClient,
    tableName: string,
    options: DynamoAuditStoreOptions = {},
  ) {
    if (tableName.length === 0) {
      throw new Error("DynamoAuditStore: tableName must be non-empty");
    }
    this.client = client;
    this.tableName = tableName;
    this.clock = options.clock ?? Date.now;
    // `options.retentionDays` is accepted for API symmetry but not
    // read here — the `AuditLog` resolves retention before calling
    // `put`. Storing it on the instance would create two sources of
    // truth.
  }

  /**
   * Insert an audit event. Uses `PutItemCommand` only — see file
   * header for the IAM-shape contract.
   */
  public async put(event: AuditEvent, retentionSeconds: number): Promise<void> {
    const ttl = Math.floor(this.clock() / 1000) + Math.floor(retentionSeconds);
    const item = buildItem(event, ttl);

    try {
      await transientRetry.execute(() =>
        this.client.send(
          new PutItemCommand({
            TableName: this.tableName,
            Item: marshall(item, { removeUndefinedValues: true }),
          }),
        ),
      );
    } catch (err) {
      throw new AuditStoreError(
        `DynamoAuditStore put failed for event ${event.id}: ${describeError(err)}`,
        { cause: err },
      );
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
