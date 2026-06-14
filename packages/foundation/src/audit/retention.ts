/**
 * Audit retention tier helpers.
 *
 * Per `doc/foundation/06-audit-log.md` (and S-F2 in the initial design
 * review), defaults are GDPR-storage-minimisation-friendly: foundation
 * targets DACH/EU SaaS workloads, so the defaults do not chase the
 * industry maximum (SOX 7y, HIPAA 6y) — those frames are vertical-
 * specific and the foundation default should not bake them in.
 * Consumers in regulated verticals lengthen via the `retentionDays`
 * option on the store constructor.
 *
 * Default retention per severity:
 *   info     -> 30 days
 *   warning  -> 180 days
 *   error    -> 400 days   (just past a typical annual audit cycle)
 *
 * Per S-F3: the override shape exports `AuditSeverity` (re-exported
 * from the audit barrel) and handles partial overrides — unset tiers
 * fall back to the foundation defaults.
 *
 * Pure module — no I/O, no time-source reads.
 */

import type { AuditSeverity } from "../types/frozen/audit.js";

/**
 * Default retention in DAYS keyed by severity. Frozen so consumers
 * cannot mutate the shared object.
 */
export const DEFAULT_RETENTION_DAYS: Readonly<Record<AuditSeverity, number>> = Object.freeze({
  info: 30,
  warning: 180,
  error: 400,
});

const SECONDS_PER_DAY = 86_400;

/**
 * Resolve the retention period (in days) for a given severity, given
 * an optional partial override map. Unset tiers fall back to the
 * foundation defaults.
 *
 * Pure.
 */
export function retentionDaysFor(
  severity: AuditSeverity,
  override?: Partial<Readonly<Record<AuditSeverity, number>>>,
): number {
  const overridden = override?.[severity];
  if (typeof overridden === "number" && Number.isFinite(overridden) && overridden > 0) {
    return Math.floor(overridden);
  }
  return DEFAULT_RETENTION_DAYS[severity];
}

/**
 * Resolve the retention period (in seconds) for a given severity. The
 * DynamoDB TTL attribute is an epoch-seconds Unix timestamp, so this
 * helper exists to keep the unit conversion in one place.
 *
 * Pure.
 */
export function retentionSecondsFor(
  severity: AuditSeverity,
  override?: Partial<Readonly<Record<AuditSeverity, number>>>,
): number {
  return retentionDaysFor(severity, override) * SECONDS_PER_DAY;
}

/**
 * Compute a TTL epoch-seconds value for a row whose severity is
 * `severity`, written at the given clock instant. Pure (the clock
 * read is the caller's concern).
 */
export function ttlFor(
  severity: AuditSeverity,
  nowEpochSeconds: number,
  override?: Partial<Readonly<Record<AuditSeverity, number>>>,
): number {
  return nowEpochSeconds + retentionSecondsFor(severity, override);
}
