/**
 * LogLevel union and ordering utilities.
 *
 * Design doc (07-logger-and-request-context.md) mandates six levels:
 * fatal, error, warn, info, debug, trace. This matches pino's own level
 * set. Trellis's five-level shape (no fatal) does NOT graduate here.
 *
 * Per S-F12: the six-vs-five inconsistency in the earlier draft is
 * resolved by the design doc's canonical six-level list.
 */

/** Six log levels, low-to-high severity. Matches pino's level names. */
export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

/** All six levels in order of descending severity (fatal first). */
export const LOG_LEVELS: ReadonlyArray<LogLevel> = Object.freeze([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
]);

/**
 * Numeric severity for each level (higher = more severe).
 * Matches pino's conventional values.
 */
export const LOG_LEVEL_SEVERITY: Readonly<Record<LogLevel, number>> = Object.freeze({
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
});

/**
 * Returns true if `candidate` is a valid `LogLevel`.
 * Pure, no side effects.
 */
export function isLogLevel(candidate: unknown): candidate is LogLevel {
  return typeof candidate === "string" && (LOG_LEVELS as ReadonlyArray<string>).includes(candidate);
}

/**
 * Compares two levels: positive if a is more severe, negative if b is,
 * 0 if equal. Pure, no side effects.
 */
export function compareLogLevelSeverity(a: LogLevel, b: LogLevel): number {
  return LOG_LEVEL_SEVERITY[a] - LOG_LEVEL_SEVERITY[b];
}
