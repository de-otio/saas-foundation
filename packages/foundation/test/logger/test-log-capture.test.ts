/**
 * Tests for `createTestLogCapture()` — the public test helper for asserting
 * on logger output without `vi.mock` blocks.
 *
 * Contract covered:
 * - Captures info/warn/error/debug records with the correct level.
 * - `level` option filters out records below the threshold.
 * - `clear()` resets the buffer; later writes go into a fresh array.
 * - Independent capture instances do not share state.
 * - Captures records emitted through a `withRequestId`-derived child logger
 *   (wired via `_replaceRootLoggerForTesting` + `runWithRequestContext`).
 * - Error objects serialize correctly (pino's default error serializer).
 */

import { describe, it, expect } from "vitest";
import { createTestLogCapture } from "../../src/logger/test-capture.js";
import {
  _replaceRootLoggerForTesting,
  getLogger,
} from "../../src/logger/logger.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../src/request-context/index.js";
import type { Logger } from "../../src/logger/logger.js";

// Pino exposes its internal Logger type but createTestLogCapture returns the
// foundation `Logger`. For tests that need to hand the capture's logger to
// `_replaceRootLoggerForTesting`, we cast through `unknown` to satisfy the
// pino-only signature without a re-export shuffle.
import type { Logger as PinoLogger } from "pino";

function asPinoLogger(logger: Logger): PinoLogger {
  return logger as unknown as PinoLogger;
}

describe("createTestLogCapture()", () => {
  it("captures info/warn/error/debug at default trace level", () => {
    const cap = createTestLogCapture();
    cap.logger.debug("dbg msg");
    cap.logger.info("info msg");
    cap.logger.warn("warn msg");
    cap.logger.error("err msg");

    const entries = cap.entries();
    expect(entries).toHaveLength(4);
    expect(entries[0]?.level).toBe("debug");
    expect(entries[0]?.msg).toBe("dbg msg");
    expect(entries[1]?.level).toBe("info");
    expect(entries[2]?.level).toBe("warn");
    expect(entries[3]?.level).toBe("error");
  });

  it("captures trace and fatal levels too", () => {
    const cap = createTestLogCapture();
    cap.logger.trace("trace msg");
    cap.logger.fatal("fatal msg");

    const entries = cap.entries();
    expect(entries.map((e) => e.level)).toEqual(["trace", "fatal"]);
  });

  it("respects an explicit `level` option (filters lower-severity records)", () => {
    const cap = createTestLogCapture({ level: "warn" });
    cap.logger.trace("trace dropped");
    cap.logger.debug("debug dropped");
    cap.logger.info("info dropped");
    cap.logger.warn("warn kept");
    cap.logger.error("error kept");

    const levels = cap.entries().map((e) => e.level);
    expect(levels).toEqual(["warn", "error"]);
  });

  it("clear() resets the buffer; later writes start at index 0", () => {
    const cap = createTestLogCapture();
    cap.logger.info("first");
    cap.logger.info("second");
    expect(cap.entries()).toHaveLength(2);

    cap.clear();
    expect(cap.entries()).toHaveLength(0);

    cap.logger.info("third");
    const entries = cap.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.msg).toBe("third");
  });

  it("returns a defensive copy from entries() — internal buffer is not mutable", () => {
    const cap = createTestLogCapture();
    cap.logger.info("one");
    const snapshot = cap.entries();
    // Cast to a mutable shape to attempt mutation; if entries() returned the
    // backing array, this push would leak into subsequent snapshots.
    (snapshot as unknown as Array<unknown>).push({ bogus: true });

    cap.logger.info("two");
    const next = cap.entries();
    expect(next).toHaveLength(2);
    expect(next[0]?.msg).toBe("one");
    expect(next[1]?.msg).toBe("two");
  });

  it("independent captures do not share state", () => {
    const capA = createTestLogCapture();
    const capB = createTestLogCapture();

    capA.logger.info("only-in-a");
    capB.logger.info("only-in-b-1");
    capB.logger.info("only-in-b-2");

    expect(capA.entries()).toHaveLength(1);
    expect(capA.entries()[0]?.msg).toBe("only-in-a");
    expect(capB.entries()).toHaveLength(2);
    expect(capB.entries().map((e) => e.msg)).toEqual([
      "only-in-b-1",
      "only-in-b-2",
    ]);
  });

  it("strips pid and hostname noise from captured records", () => {
    const cap = createTestLogCapture();
    cap.logger.info("hello");
    const entry = cap.entries()[0];
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("pid");
    expect(entry).not.toHaveProperty("hostname");
  });

  it("populates a numeric `time` field on each record", () => {
    const cap = createTestLogCapture();
    cap.logger.info("with-time");
    const entry = cap.entries()[0];
    expect(entry).toBeDefined();
    expect(typeof entry?.time).toBe("number");
    expect(entry?.time).toBeGreaterThan(0);
  });

  it("captures arbitrary structured fields passed alongside a message", () => {
    const cap = createTestLogCapture();
    cap.logger.info({ requestId: "r-1", count: 42 }, "structured");
    const entry = cap.entries()[0];
    expect(entry?.msg).toBe("structured");
    expect(entry?.["requestId"]).toBe("r-1");
    expect(entry?.["count"]).toBe(42);
  });

  it("captures a structured-only call (no message) with empty msg string", () => {
    // Exercises the no-msg branch of the parser: pino emits no `msg` key
    // when the caller passes only an object. The capture normalizes to "".
    const cap = createTestLogCapture();
    cap.logger.info({ event: "noop" });
    const entry = cap.entries()[0];
    expect(entry?.msg).toBe("");
    expect(entry?.["event"]).toBe("noop");
  });

  it("works with the request-context-bound child logger", () => {
    const cap = createTestLogCapture();
    const restore = _replaceRootLoggerForTesting(asPinoLogger(cap.logger));

    const ctx = createRequestContext({ requestId: "req-cap-001" });
    runWithRequestContext(ctx, () => {
      getLogger().info("inside request");
    });

    restore();

    const entries = cap.entries();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.msg).toBe("inside request");
    expect(entry?.["requestId"]).toBe("req-cap-001");
  });

  it("installAsRoot() routes getLogger() output into the capture", () => {
    const cap = createTestLogCapture();
    cap.installAsRoot();
    try {
      getLogger().info("via-root");
    } finally {
      cap.restore();
    }

    const entries = cap.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.msg).toBe("via-root");
  });

  it("installAsRoot() is idempotent — double-install does not duplicate state", () => {
    const cap = createTestLogCapture();
    cap.installAsRoot();
    cap.installAsRoot();
    try {
      getLogger().info("once");
    } finally {
      cap.restore();
    }
    expect(cap.entries()).toHaveLength(1);
  });

  it("restore() undoes installAsRoot(); subsequent getLogger() does NOT go to the capture", () => {
    const cap = createTestLogCapture();
    cap.installAsRoot();
    getLogger().info("captured");
    cap.restore();

    // After restore, the root logger is back to whatever it was. Use a fresh
    // capture installed via the lower-level helper to confirm post-restore
    // emissions don't leak into the first capture.
    const cap2 = createTestLogCapture();
    const restore2 = _replaceRootLoggerForTesting(asPinoLogger(cap2.logger));
    getLogger().info("post-restore");
    restore2();

    expect(cap.entries()).toHaveLength(1);
    expect(cap.entries()[0]?.msg).toBe("captured");
    expect(cap2.entries()).toHaveLength(1);
    expect(cap2.entries()[0]?.msg).toBe("post-restore");
  });

  it("restore() is idempotent when called without a prior install", () => {
    const cap = createTestLogCapture();
    expect(() => cap.restore()).not.toThrow();
    expect(() => cap.restore()).not.toThrow();
  });

  it("install/restore composes safely in beforeEach/afterEach style", () => {
    // Mimics the trellis test pattern: each iteration gets a fresh capture,
    // installs it, exercises code, then restores. No state leaks between
    // iterations.
    for (let i = 0; i < 3; i++) {
      const cap = createTestLogCapture();
      cap.installAsRoot();
      try {
        getLogger().info({ iter: i }, "iteration");
      } finally {
        cap.restore();
      }
      expect(cap.entries()).toHaveLength(1);
      expect(cap.entries()[0]?.["iter"]).toBe(i);
    }
  });

  it("serializes Error objects via pino's default serializer (err key)", () => {
    const cap = createTestLogCapture();
    const err = new Error("boom");
    cap.logger.error({ err }, "operation failed");

    const entry = cap.entries()[0];
    expect(entry?.msg).toBe("operation failed");
    expect(entry?.level).toBe("error");

    const serialized = entry?.["err"];
    expect(serialized).toBeDefined();
    // pino's std serializer emits { type, message, stack } at minimum.
    expect(serialized).toMatchObject({
      type: "Error",
      message: "boom",
    });
    expect(typeof (serialized as { stack?: unknown })?.stack).toBe("string");
  });
});
