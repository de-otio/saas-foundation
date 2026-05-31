/**
 * `createTestLogCapture()` — a uniform, dependency-free test helper for
 * asserting on logger output without `vi.mock` blocks.
 *
 * Typical use:
 *
 *   const capture = createTestLogCapture();
 *   capture.installAsRoot();          // route getLogger() calls here
 *   // …exercise code…
 *   expect(capture.entries()).toContainEqual(…);
 *   capture.restore();                // restore the prior root logger
 *
 * Captured records are parsed JSON lines with `pid` and `hostname` stripped
 * (they are noise in test assertions). The buffer is local to each capture
 * — calls do not share state.
 */

import pino, { type Level as PinoLevel, type DestinationStream, type Logger as PinoLogger } from "pino";
import type { Logger } from "./logger.js";
import { _replaceRootLoggerForTesting } from "./logger.js";

export interface LogRecord {
  readonly level: PinoLevel;
  readonly msg: string;
  readonly time: number;
  readonly [key: string]: unknown;
}

export interface TestLogCapture {
  /** Pino-compatible logger that records every emitted line. */
  readonly logger: Logger;
  /** Captured records, oldest first. Returns a defensive copy. */
  entries(): readonly LogRecord[];
  /** Reset the internal buffer. */
  clear(): void;
  /**
   * Install this capture as the process-wide root logger. Idempotent —
   * calling twice on the same capture is a no-op. Use `restore()` to
   * undo. Bypasses the one-shot `configureRootLogger` lock; safe to call
   * inside `beforeEach`.
   */
  installAsRoot(): void;
  /**
   * Restore the root logger to whatever it was before `installAsRoot()`.
   * Idempotent — calling on a non-installed capture is a no-op.
   */
  restore(): void;
}

export interface CreateTestLogCaptureOptions {
  /** Minimum level to capture. Defaults to `"trace"` (capture everything). */
  readonly level?: PinoLevel;
}

/**
 * pino emits numeric level codes, not names. Map them back so consumers
 * can assert on `entry.level === "info"` instead of `entry.level === 30`.
 */
const LEVEL_BY_CODE: Readonly<Record<number, PinoLevel>> = Object.freeze({
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
});

/**
 * Create a fresh log capture. No shared state across invocations — each
 * call gets its own buffer, destination, and pino instance.
 */
export function createTestLogCapture(
  opts: CreateTestLogCaptureOptions = {},
): TestLogCapture {
  const level: PinoLevel = opts.level ?? "trace";
  const buffer: LogRecord[] = [];

  const destination: DestinationStream = {
    write(chunk: string): void {
      // pino always emits one trailing newline per record; trim it.
      buffer.push(parseLine(chunk.trim()));
    },
  };

  const pinoLogger = pino(
    {
      level,
      // Strip pid/hostname noise: pino normally injects them via the base
      // bindings. Setting base to `{}` removes both without affecting
      // user-provided bindings on .child() calls.
      base: {},
      timestamp: pino.stdTimeFunctions.epochTime,
    },
    destination,
  );

  let restoreFn: (() => void) | null = null;

  return {
    logger: pinoLogger as unknown as Logger,
    entries(): readonly LogRecord[] {
      // Defensive copy: callers cannot mutate the internal buffer.
      return buffer.slice();
    },
    clear(): void {
      buffer.length = 0;
    },
    installAsRoot(): void {
      if (restoreFn !== null) return;
      restoreFn = _replaceRootLoggerForTesting(pinoLogger as unknown as PinoLogger);
    },
    restore(): void {
      if (restoreFn === null) return;
      restoreFn();
      restoreFn = null;
    },
  };
}

/**
 * Parse a single pino-emitted JSON line into a `LogRecord`. pino always
 * produces a JSON object with `level` (numeric), `msg` (string), and
 * `time` (number) — defensive guards beyond that are unreachable through
 * this module's public API. If pino's contract changes, the existing
 * tests will fail loudly.
 */
function parseLine(line: string): LogRecord {
  const obj = JSON.parse(line) as Record<string, unknown>;
  // pino always emits one of the canonical numeric level codes (10..60).
  // Cast through `number` then look up the name; the indexed access is
  // type-asserted because pino's contract guarantees it.
  const levelCode = obj["level"] as number;
  const levelName = LEVEL_BY_CODE[levelCode] as PinoLevel;
  const msg = obj["msg"];
  const time = obj["time"] as number;

  // Strip pid + hostname (pino noise) and the numeric `level` field, which
  // we replace with the level name above. Leading-underscore names mark
  // these as intentionally unused destructure targets.
  const { pid: _pid, hostname: _hostname, level: _level, ...rest } = obj;
  void _pid;
  void _hostname;
  void _level;

  return {
    ...rest,
    level: levelName,
    msg: typeof msg === "string" ? msg : "",
    time,
  };
}
