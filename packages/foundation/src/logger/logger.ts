/**
 * pino-backed logger implementation.
 *
 * Key invariants:
 * 1. The root logger is process-global state (one documented exception to the
 *    no-singletons rule). `configureRootLogger` may only be called once;
 *    subsequent calls are no-ops with a warning.
 * 2. `getLogger()` returns the per-request child from the current
 *    `RequestContext` if inside `runWithRequestContext`, otherwise the root.
 * 3. The `LOGGER_KEY` symbol is private to this module. The child logger is
 *    attached via `Object.defineProperty` BEFORE `Object.freeze` on the
 *    `RequestContext` (per S-F9 and the spec). Consumers cannot reach it
 *    without the symbol.
 * 4. `configureRootLogger` is pure side-channel: it replaces the module-level
 *    variable. All other functions are impure only through the ALS read or
 *    pino emit.
 */

import pino, { type Logger as PinoLogger } from "pino";
import { isLogLevel } from "./levels.js";
import { DEFAULT_REDACT_CONFIG } from "./redact.js";

// ---------------------------------------------------------------------------
// Logger type (thin alias of pino's Logger, re-exported with our LogLevel)
// ---------------------------------------------------------------------------

export interface Logger {
  fatal(obj: object, msg?: string): void;
  fatal(msg: string): void;
  error(obj: object, msg?: string): void;
  error(msg: string): void;
  warn(obj: object, msg?: string): void;
  warn(msg: string): void;
  info(obj: object, msg?: string): void;
  info(msg: string): void;
  debug(obj: object, msg?: string): void;
  debug(msg: string): void;
  trace(obj: object, msg?: string): void;
  trace(msg: string): void;
  child(bindings: Record<string, unknown>): Logger;
  readonly level: string;
}

// ---------------------------------------------------------------------------
// Root logger — the ONE process-global singleton.
// ---------------------------------------------------------------------------

/** Lazily initialised on first access if `configureRootLogger` is never called. */
let _rootLogger: PinoLogger | null = null;
let _configured = false;

function buildDefaultRootLogger(): PinoLogger {
  const rawLevel = process.env["LOG_LEVEL"] ?? "info";
  const level: string = isLogLevel(rawLevel) ? rawLevel : "info";

  const opts: pino.LoggerOptions = {
    level,
    base: { service: process.env["SERVICE_NAME"] ?? "unknown" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: DEFAULT_REDACT_CONFIG,
  };
  return pino(opts);
}

/**
 * Returns the root pino logger, creating a default one on first access.
 * Impure: reads process.env on first call.
 */
function getRootLogger(): PinoLogger {
  if (_rootLogger === null) {
    _rootLogger = buildDefaultRootLogger();
  }
  return _rootLogger;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Configure the root logger. May only be called ONCE; subsequent calls
 * emit a warning on the existing logger and are otherwise ignored.
 *
 * Silent-level hardening: when `level: "silent"` is requested, pino's
 * stock behavior propagates correctly to children created *after* the
 * root is configured (descendants inherit "silent"). We also pin the
 * destination to a no-op sink so any defensive caller that bypassed
 * level filtering (e.g. constructed a `.child()` with an explicit level
 * override) still produces zero output. This is the contract the
 * trellis 0.2.3 silent-test asserts.
 *
 * Impure: writes module-level state.
 */
export function configureRootLogger(options: pino.LoggerOptions): void {
  if (_configured) {
    getRootLogger().warn("configureRootLogger called more than once — subsequent call ignored");
    return;
  }
  _configured = true;
  const merged: pino.LoggerOptions = {
    redact: DEFAULT_REDACT_CONFIG,
    ...options,
  };

  if (merged.level === "silent") {
    // Pino guarantees that children inheriting silent will short-circuit,
    // but a child with an explicit non-silent level override would still
    // attempt to write. Pin the destination to a sink that throws away
    // every byte so that path also produces zero observable output.
    _rootLogger = pino(merged, { write: noopWrite });
    return;
  }

  _rootLogger = pino(merged);
}

/** Destination sink used for the silent root. Discards all bytes. */
function noopWrite(_chunk: string): void {
  void _chunk;
}

/**
 * Symbol key used to attach the per-request logger on the RequestContext.
 *
 * Non-exported: this is deliberately private. `getLogger()` is the only
 * consumer-facing entry point. The symbol lives in this module so that
 * `createRequestContext` (in the request-context module) can import it.
 */
export const LOGGER_KEY: unique symbol = Symbol("foundation.logger");

/**
 * Type augmentation helper — attaches the logger symbol to any object.
 * Used by `createRequestContext` after building the context draft.
 */
export type WithLoggerKey = {
  readonly [LOGGER_KEY]?: Logger;
};

/**
 * Retrieve the `Logger` attached to `obj` via `LOGGER_KEY`, or `null`.
 * Pure (no side effects beyond the property read).
 */
export function getAttachedLogger(obj: object): Logger | null {
  const candidate = (obj as WithLoggerKey)[LOGGER_KEY];
  return candidate ?? null;
}

/**
 * Attach the root-logger child for the given bindings to a draft object
 * (via non-enumerable `defineProperty`) BEFORE the caller freezes it.
 *
 * This is the S-F9 pattern: `defineProperty`-before-`freeze`.
 *
 * Impure: mutates `draft`.
 */
export function attachLoggerToContext(draft: object, bindings: Record<string, unknown>): void {
  const child = getRootLogger().child(bindings);
  Object.defineProperty(draft, LOGGER_KEY, {
    value: child as unknown as Logger,
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

// ---------------------------------------------------------------------------
// ALS-aware getLogger / createLogger
//
// The ALS dependency is injected via a callback to keep this file free of a
// direct import of the ALS singleton (which lives in request-context/als.ts).
// The request-context module calls `setAlsProvider` at module load time.
// ---------------------------------------------------------------------------

type AlsProvider = () => object | undefined;

let _alsProvider: AlsProvider | null = null;

/**
 * Register the ALS provider. Called once by the request-context module
 * at module initialisation. Not part of the public API.
 */
export function setAlsProvider(provider: AlsProvider): void {
  _alsProvider = provider;
}

/**
 * Returns the per-request child logger from the current `RequestContext` if
 * inside `runWithRequestContext`, otherwise returns the root logger.
 *
 * Impure: reads ALS store.
 */
export function getLogger(): Logger {
  if (_alsProvider !== null) {
    const ctx = _alsProvider();
    if (ctx !== undefined) {
      const attached = getAttachedLogger(ctx);
      if (attached !== null) {
        return attached;
      }
    }
  }
  return getRootLogger() as unknown as Logger;
}

/**
 * Create a detached child logger with the given bindings.
 * Useful for components that do not run inside a request context.
 *
 * Impure: reads root logger state.
 */
export function createLogger(bindings: Record<string, unknown>): Logger {
  return getRootLogger().child(bindings) as unknown as Logger;
}

// ---------------------------------------------------------------------------
// Test helpers (not exported from the barrel — internal use only)
// ---------------------------------------------------------------------------

/**
 * Replace the root logger with a test double. Returns a restore function.
 * ONLY for use in tests.
 */
export function _replaceRootLoggerForTesting(replacement: PinoLogger): () => void {
  const prev = _rootLogger;
  const prevConfigured = _configured;
  _rootLogger = replacement;
  _configured = true;
  return () => {
    _rootLogger = prev;
    _configured = prevConfigured;
  };
}

/**
 * Reset the root-logger module state so a subsequent `configureRootLogger`
 * call is honored as the first configuration. ONLY for use in tests that
 * exercise the public `configureRootLogger` API (e.g. the silent-level
 * hardening contract). Production code MUST NOT touch this.
 */
export function _resetRootLoggerForTesting(): void {
  _rootLogger = null;
  _configured = false;
}

/** Exported only for tests: validates the LoggerConfigError type. */
export { LoggerConfigError } from "./errors.js";
