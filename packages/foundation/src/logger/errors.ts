/**
 * Named error types for the logger module.
 */

export class LoggerConfigError extends Error {
  override readonly name = "LoggerConfigError" as const;
}
