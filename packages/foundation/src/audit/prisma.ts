/**
 * `PostgresAuditStore` — the Prisma-backed `AuditStore`.
 *
 * IMPORTANT: The `src/audit/` quarantine keeps `@prisma/client` an OPTIONAL
 * peer dependency in practice — only this file is permitted to reference
 * `@prisma/client` at all, and it does so purely through the structural
 * `PrismaAuditClient` interface (no value-import; Prisma 7's bare package
 * exports nothing without a generated client). See
 * `doc/foundation/01-package-api.md § Prisma sub-paths`.
 *
 * Consumers reach this file ONLY via the sub-path:
 *
 *   import { PostgresAuditStore } from "@de-otio/saas-foundation/audit/prisma";
 *
 * It is NOT re-exported from `@de-otio/saas-foundation/audit` or the
 * top-level barrel. An ESLint rule under `.eslintrc.cjs` forbids
 * `@prisma/client` imports in any other file under `src/audit/`.
 *
 * Append-only posture (mirrors `DynamoAuditStore`):
 *
 *   - This file MUST NOT call `prisma.<model>.update`,
 *     `.delete`, `.deleteMany`, or `.updateMany` on the
 *     `audit_event` model. Only `create` / `createMany` are
 *     permitted.
 *   - The application's DB role must have `INSERT` on `audit_event`
 *     only — no `UPDATE` or `DELETE`. A separate sweeper role
 *     (running on a schedule) has `DELETE` scoped to rows where
 *     `retention_until < now()` via a row-level-security policy.
 *
 * Postgres has no built-in TTL; the `retention_until` column is the
 * foundation-side primitive. Enforcement requires a periodic sweeper
 * (`DELETE FROM audit_event WHERE retention_until < now()`). See the
 * design note for the recommended sweeper Lambda shape.
 */

// This store operates purely against the structural `PrismaAuditClient`
// interface below — it does NOT value-import `@prisma/client`. Under Prisma 7
// the bare `@prisma/client` exports nothing until a client is generated, and
// foundation has no schema of its own; consumers pass their own generated
// `PrismaClient` (or a mock), which is structurally assignable. The ESLint
// rule in `.eslintrc.cjs` still keeps `@prisma/client` quarantined out of the
// rest of `src/audit/`.
import type { AuditEvent, AuditSeverity } from "../types/frozen/audit.js";
import { AuditStoreError } from "./errors.js";
import type { AuditStore } from "./store.js";

/**
 * Subset of the Prisma client that this store actually uses. Stated
 * as a structural interface so tests can pass a mock without
 * constructing a full `PrismaClient`.
 *
 * The real `PrismaClient`'s `auditEvent.create` is also assignable to
 * this shape, so production callers pass `new PrismaClient()` directly.
 */
export interface PrismaAuditClient {
  readonly auditEvent: {
    create(args: {
      data: {
        id: string;
        timestamp: Date;
        tenantId: string | null;
        actorKind: string;
        actorId: string;
        action: string;
        resourceKind: string | null;
        resourceId: string | null;
        outcome: string;
        failureReason: string | null;
        severity: string;
        requestId: string | null;
        traceId: string | null;
        ipAddress: string | null;
        userAgent: string | null;
        metadata: unknown;
        retentionUntil: Date;
      };
    }): Promise<unknown>;
  };
}

export interface PostgresAuditStoreOptions {
  /**
   * Partial override of per-severity retention in DAYS. Accepted for
   * API symmetry with `DynamoAuditStore`; the actual retention seconds
   * are resolved by `AuditLog` before reaching `put`.
   */
  readonly retentionDays?: Partial<Readonly<Record<AuditSeverity, number>>>;

  /**
   * Clock source — returns epoch milliseconds. Defaults to `Date.now`.
   */
  readonly clock?: () => number;
}

/**
 * Map an `AuditActor` to the `(actorKind, actorId)` columns. Pure.
 */
function actorColumns(actor: AuditEvent["actor"]): { kind: string; id: string } {
  switch (actor.kind) {
    case "user":
      return { kind: "user", id: actor.userSub };
    case "service":
      return { kind: "service", id: actor.serviceName };
    case "system":
      return { kind: "system", id: actor.component };
    case "anonymous":
      return { kind: "anonymous", id: "_anonymous" };
  }
}

export class PostgresAuditStore implements AuditStore {
  private readonly prisma: PrismaAuditClient;
  private readonly clock: () => number;

  /**
   * @param prisma  A `PrismaClient` (or any object that implements
   *                the `auditEvent.create` shape).
   *
   * The class accepts the structural interface so consumers can pass
   * either a real client or a mock. In production code the consumer
   * passes `new PrismaClient()`.
   */
  /**
   * @param prisma  Any object that implements the `PrismaAuditClient`
   *                structural shape. The real `PrismaClient` is
   *                structurally assignable, so production callers
   *                pass `new PrismaClient()` directly:
   *
   *                  new PostgresAuditStore(new PrismaClient());
   */
  public constructor(prisma: PrismaAuditClient, options: PostgresAuditStoreOptions = {}) {
    this.prisma = prisma;
    this.clock = options.clock ?? Date.now;
  }

  public async put(event: AuditEvent, retentionSeconds: number): Promise<void> {
    const retentionMs = Math.floor(retentionSeconds) * 1000;
    const retentionUntil = new Date(this.clock() + retentionMs);
    const actor = actorColumns(event.actor);

    try {
      // INSERT only. Do NOT add `.update`, `.delete`, `.upsert`,
      // `.updateMany`, or `.deleteMany` against the audit_event model
      // in this file — they break the append-only contract.
      await this.prisma.auditEvent.create({
        data: {
          id: event.id,
          timestamp: new Date(event.timestamp),
          tenantId: event.tenantId ?? null,
          actorKind: actor.kind,
          actorId: actor.id,
          action: event.action,
          resourceKind: event.resource?.kind ?? null,
          resourceId: event.resource?.id ?? null,
          outcome: event.outcome,
          failureReason: event.failureReason ?? null,
          severity: event.severity,
          requestId: event.requestId ?? null,
          traceId: event.traceId ?? null,
          ipAddress: event.ipAddress ?? null,
          userAgent: event.userAgent ?? null,
          metadata: event.metadata ?? null,
          retentionUntil,
        },
      });
    } catch (err) {
      throw new AuditStoreError(
        `PostgresAuditStore put failed for event ${event.id}: ${describeError(err)}`,
        { cause: err },
      );
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
