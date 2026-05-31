/**
 * Named error types for the audit module.
 *
 * Each carries a discriminant `name` field so call sites can use
 * `instanceof` checks or the `name` field for branching.
 */

import type { AuditEvent } from "../types/frozen/audit.js";

/**
 * Thrown when an `AuditStore` write fails. Carries the partially-built
 * event so the caller can decide whether to retry, drop, or escalate.
 *
 * Per S-F15: `AuditLog.emit` does NOT swallow store failures — they
 * are surfaced via this error. Best-effort emission is available via
 * `emitBestEffort`, which logs failures through the injected logger
 * and is named to make the trade-off visible at the call site.
 */
export class AuditWriteError extends Error {
  public override readonly name = "AuditWriteError" as const;
  public readonly event: AuditEvent;

  public constructor(message: string, event: AuditEvent, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.event = event;
  }
}

/**
 * Thrown when the input to `AuditLog.emit` fails the Zod schema check
 * (missing required field, wrong shape, metadata too large, ...).
 */
export class AuditEventValidationError extends Error {
  public override readonly name = "AuditEventValidationError" as const;
  public readonly issues: ReadonlyArray<string>;

  public constructor(message: string, issues: ReadonlyArray<string>) {
    super(message);
    this.issues = issues;
  }
}

/**
 * Thrown by store implementations to wrap underlying SDK errors. Used
 * for "store unavailable" (network, throttling, permission) — distinct
 * from `AuditEventValidationError` ("input was bad before we ever
 * tried").
 */
export class AuditStoreError extends Error {
  public override readonly name = "AuditStoreError" as const;

  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
  }
}
