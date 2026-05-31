/**
 * `AuditLog` — the writer side of the audit module.
 *
 * Persists `AuditEvent` rows to a pluggable `AuditStore` after:
 *   - Zod validation against `EmitInputSchema`
 *   - PII scrub of `metadata` via the configured `PiiFilter`
 *   - Metadata-size enforcement (32 KB default per S-Sec2)
 *   - ulid mint for `id`; ISO 8601 mint for `timestamp`
 *   - severity -> retention-seconds lookup per S-F2 defaults
 *
 * Two emission shapes per S-F15:
 *
 *   - `emitAwait(input)` — RECOMMENDED. Resolves with the persisted
 *     event after the store write succeeds, throws `AuditWriteError`
 *     on failure. Pair with `MultiAuditStore` for durability against
 *     primary-store outage.
 *
 *   - `emit(input)` — fire-and-forget variant for hot paths. Initiates
 *     the store write and returns once the call has been started, NOT
 *     after it has resolved. Failures are routed to the injected
 *     `logger` rather than swallowed silently (the bug S-F15
 *     called out).
 *
 * Constructor-injected. No singletons, no module-level clients.
 */

import { ulid } from "./ulid.js";
import type { Logger } from "../logger/logger.js";
import { createLogger } from "../logger/logger.js";
import type { AuditActor, AuditEvent, AuditSeverity, JsonValue } from "../types/frozen/audit.js";
import { AuditEventValidationError, AuditWriteError } from "./errors.js";
import { PiiFilter } from "./pii-filter.js";
import { retentionSecondsFor } from "./retention.js";
import { DEFAULT_METADATA_MAX_BYTES, EmitInputSchema, type EmitInput } from "./schemas.js";
import type { AuditStore } from "./store.js";

/**
 * Configuration for `AuditLog`.
 */
export interface AuditLogOptions {
  /** PII filter applied to `event.metadata` before persistence. */
  readonly piiFilter?: PiiFilter;

  /** Logger that receives `emit` failures. Defaults to a detached child. */
  readonly logger?: Logger;

  /**
   * Max JSON-encoded size of `metadata`, in bytes. Defaults to 32 768.
   * See `DEFAULT_METADATA_MAX_BYTES`.
   */
  readonly metadataMaxBytes?: number;

  /**
   * Oversize policy:
   *   `'reject'`   (default) — throw `AuditWriteError`. Surfaces
   *                            audit-evasion attempts that pad
   *                            metadata to hide significant entries.
   *   `'truncate'` — drop the largest metadata keys until the
   *                  payload fits; set a `metadata_truncated: true`
   *                  flag on the persisted event.
   */
  readonly metadataOversizePolicy?: "reject" | "truncate";

  /**
   * Partial override of the per-severity retention (in DAYS). Unset
   * tiers fall back to foundation defaults (info: 30, warning: 180,
   * error: 400).
   */
  readonly retentionDays?: Partial<Readonly<Record<AuditSeverity, number>>>;

  /**
   * Clock source — returns epoch milliseconds. Defaults to `Date.now`.
   * Tests inject a frozen clock; production code leaves it unset.
   */
  readonly clock?: () => number;
}

export class AuditLog {
  private readonly store: AuditStore;
  private readonly piiFilter: PiiFilter;
  private readonly logger: Logger;
  private readonly metadataMaxBytes: number;
  private readonly oversizePolicy: "reject" | "truncate";
  private readonly retentionDays: Partial<Readonly<Record<AuditSeverity, number>>> | undefined;
  private readonly clock: () => number;

  public constructor(store: AuditStore, options: AuditLogOptions = {}) {
    this.store = store;
    this.piiFilter = options.piiFilter ?? new PiiFilter();
    this.logger = options.logger ?? createLogger({ component: "audit-log" });
    this.metadataMaxBytes = options.metadataMaxBytes ?? DEFAULT_METADATA_MAX_BYTES;
    this.oversizePolicy = options.metadataOversizePolicy ?? "reject";
    this.retentionDays = options.retentionDays;
    this.clock = options.clock ?? Date.now;
  }

  /**
   * Synchronous-await emit. Validates, scrubs, mints, persists.
   * Resolves with the persisted event; throws `AuditWriteError` on
   * store failure.
   *
   * RECOMMENDED. Use `MultiAuditStore` if you need durability across a
   * primary-store outage.
   */
  public async emitAwait(input: EmitInput): Promise<AuditEvent> {
    const event = this.buildEvent(input);
    try {
      await this.store.put(event, retentionSecondsFor(event.severity, this.retentionDays));
    } catch (err) {
      throw new AuditWriteError(`Audit store write failed: ${describeError(err)}`, event, {
        cause: err,
      });
    }
    return event;
  }

  /**
   * Fire-and-forget emit. The store write is initiated; this function
   * returns once the call has been started (not after it has
   * resolved).
   *
   * Failures are routed to the injected logger as a structured
   * `audit-write-failed` event (NOT swallowed silently — S-F15). Use
   * sparingly: an audit log that drops events defeats its own purpose.
   * Pair with `MultiAuditStore` so a primary-store outage doesn't take
   * a whole event with it.
   */
  public emit(input: EmitInput): void {
    let event: AuditEvent;
    try {
      event = this.buildEvent(input);
    } catch (err) {
      // Validation failure: surface synchronously through the logger
      // so the caller's tests / dashboards see it. We do NOT throw
      // because the contract is fire-and-forget; callers who want
      // throwing semantics use `emitAwait`.
      this.logger.error({ err, audit_phase: "validate" }, "AuditLog.emit: validation failed");
      return;
    }

    // Promise is intentionally not awaited; failures route through
    // the logger. `void` keeps `@typescript-eslint/no-floating-promises`
    // satisfied.
    void this.store
      .put(event, retentionSecondsFor(event.severity, this.retentionDays))
      .catch((err: unknown) => {
        this.logger.error(
          { err, audit_event_id: event.id, audit_action: event.action },
          "AuditLog.emit: store write failed",
        );
      });
  }

  /**
   * Build the fully-formed `AuditEvent` from emit input. Pure-ish
   * (reads the clock; mints a ulid).
   */
  private buildEvent(input: EmitInput): AuditEvent {
    // 1. Zod validation. The schema catches missing required fields
    //    and basic shape violations.
    const parsed = EmitInputSchema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      throw new AuditEventValidationError(
        `AuditEvent input failed validation: ${issues.join("; ")}`,
        issues,
      );
    }
    const validated = parsed.data;

    // 2. Scrub metadata through the PII filter.
    let metadata: Readonly<Record<string, JsonValue>> | undefined;
    let metadataTruncated = false;
    if (validated.metadata !== undefined) {
      const scrubbed = this.piiFilter.apply(validated.metadata as Record<string, JsonValue>);
      const sizeCheck = this.enforceMetadataSize(scrubbed);
      metadata = sizeCheck.metadata;
      metadataTruncated = sizeCheck.truncated;
    }

    // 3. Mint id + timestamp.
    const nowMs = this.clock();
    const id = ulid(nowMs);
    const timestamp = new Date(nowMs).toISOString();

    // 4. Compose the event. The frozen-set discipline says
    //    `Object.freeze` the result so callers cannot mutate it.
    //    The actor narrowing strips the `idp: undefined` shape that
    //    Zod's optional() admits but the frozen type rejects under
    //    `exactOptionalPropertyTypes`.
    const actor = narrowActor(validated.actor);
    const event = {
      id,
      timestamp,
      ...(validated.tenantId !== undefined && { tenantId: validated.tenantId }),
      actor,
      action: validated.action,
      ...(validated.resource !== undefined && { resource: validated.resource }),
      outcome: validated.outcome,
      ...(validated.failureReason !== undefined && { failureReason: validated.failureReason }),
      severity: validated.severity,
      ...(validated.requestId !== undefined && { requestId: validated.requestId }),
      ...(validated.traceId !== undefined && { traceId: validated.traceId }),
      ...(validated.ipAddress !== undefined && { ipAddress: validated.ipAddress }),
      ...(validated.userAgent !== undefined && { userAgent: validated.userAgent }),
      ...(metadata !== undefined && {
        metadata: metadataTruncated ? { ...metadata, metadata_truncated: true } : metadata,
      }),
    } satisfies AuditEvent;

    return Object.freeze(event);
  }

  /**
   * Enforce the metadata-size cap. Returns the (possibly truncated)
   * metadata along with a flag indicating whether truncation occurred.
   * Throws `AuditEventValidationError` under the `reject` policy.
   */
  private enforceMetadataSize(metadata: Readonly<Record<string, JsonValue>>): {
    metadata: Readonly<Record<string, JsonValue>>;
    truncated: boolean;
  } {
    const encoded = JSON.stringify(metadata);
    const size = Buffer.byteLength(encoded, "utf-8");
    if (size <= this.metadataMaxBytes) {
      return { metadata, truncated: false };
    }

    if (this.oversizePolicy === "reject") {
      throw new AuditEventValidationError(
        `AuditEvent metadata exceeds ${String(this.metadataMaxBytes)} bytes (was ${String(size)})`,
        [`metadata: encoded size ${String(size)} > ${String(this.metadataMaxBytes)}`],
      );
    }

    // Truncate: drop the largest keys (by JSON-encoded size) until
    // the encoded payload fits.
    const entries = Object.entries(metadata).map(([k, v]) => ({
      key: k,
      value: v,
      size: Buffer.byteLength(JSON.stringify({ [k]: v }), "utf-8"),
    }));
    entries.sort((a, b) => b.size - a.size); // largest first

    // We re-encode each step to honour the actual JSON overhead
    // (commas, brackets) rather than approximating from entry sizes.
    // We build by REMOVAL (`Set` of dropped keys) rather than `delete`
    // so we avoid `no-dynamic-delete` lint and rebuild a fresh object
    // for the final return.
    const dropped = new Set<string>();
    const rebuild = (): Record<string, JsonValue> => {
      const acc: Record<string, JsonValue> = {};
      for (const e of entries) {
        if (!dropped.has(e.key)) acc[e.key] = e.value;
      }
      return acc;
    };

    for (const e of entries) {
      const current = JSON.stringify(rebuild());
      if (Buffer.byteLength(current, "utf-8") <= this.metadataMaxBytes) break;
      dropped.add(e.key);
    }

    return { metadata: rebuild(), truncated: true };
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Strip `idp: undefined` from a `user` actor (Zod admits `optional()`
 * with `undefined`; the frozen type with `exactOptionalPropertyTypes`
 * requires the key absent rather than present-and-undefined).
 */
function narrowActor(actor: EmitInput["actor"]): AuditActor {
  if (actor.kind === "user") {
    if (actor.idp === undefined) {
      return { kind: "user", userSub: actor.userSub };
    }
    return {
      kind: "user",
      userSub: actor.userSub,
      idp: { providerName: actor.idp.providerName, providerType: actor.idp.providerType },
    };
  }
  return actor;
}
