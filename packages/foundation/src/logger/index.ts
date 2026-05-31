/**
 * `@de-otio/saas-foundation/logger` barrel.
 *
 * Exports:
 * - `Logger` — the pino-compatible logger interface
 * - `LogLevel` — six-level union (fatal | error | warn | info | debug | trace)
 * - `createLogger(bindings)` — create a detached child logger
 * - `getLogger()` — ALS-bound per-request logger (or root outside a request)
 * - `configureRootLogger(options)` — one-time root-logger configuration
 * - `createTestLogCapture()` — test helper that records emitted log lines
 * - `LoggerConfigError` — thrown on misconfiguration
 */

export type { Logger } from "./logger.js";
export type { LogLevel } from "./levels.js";
export { LOG_LEVELS, LOG_LEVEL_SEVERITY, isLogLevel, compareLogLevelSeverity } from "./levels.js";
export { configureRootLogger, getLogger, createLogger, LOGGER_KEY } from "./logger.js";
export type { WithLoggerKey } from "./logger.js";
export { DEFAULT_REDACT_PATHS, DEFAULT_REDACT_CONFIG } from "./redact.js";
export { LoggerConfigError } from "./errors.js";
export { createTestLogCapture } from "./test-capture.js";
export type {
  LogRecord,
  TestLogCapture,
  CreateTestLogCaptureOptions,
} from "./test-capture.js";
