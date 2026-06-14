/**
 * Tests for `configureRootLogger({ level: "silent" })` hardening.
 *
 * Contract covered:
 * - A silent root produces zero observable output.
 * - A `.child()` of a silent root produces zero observable output.
 * - A logger derived inside `runWithRequestContext` (the per-request child)
 *   produces zero observable output when the root is silent.
 * - A re-bound `.child().child()` chain remains silent.
 * - A child created with an EXPLICIT non-silent level override on a silent
 *   root still produces zero observable output. This is the load-bearing
 *   case: stock pino would honor the override, but the configureRootLogger
 *   hardening pins the destination to a no-op sink.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  configureRootLogger,
  getLogger,
  createLogger,
  _resetRootLoggerForTesting,
} from "../../src/logger/logger.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../src/request-context/index.js";

/**
 * Intercepts process.stdout.write for the duration of `fn` and returns the
 * collected chunks. This is the most conservative way to verify "zero
 * observable output" — pino's default destination is stdout, so anything
 * that bypassed the silent short-circuit would surface here.
 */
function captureStdout(fn: () => void): string[] {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown): boolean => {
    if (typeof chunk === "string") {
      chunks.push(chunk);
    } else if (chunk instanceof Uint8Array) {
      chunks.push(Buffer.from(chunk).toString("utf8"));
    }
    return true;
  });
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks;
}

describe("configureRootLogger({ level: 'silent' })", () => {
  beforeEach(() => {
    _resetRootLoggerForTesting();
  });

  afterEach(() => {
    _resetRootLoggerForTesting();
  });

  it("root logger produces zero output", () => {
    configureRootLogger({ level: "silent" });

    const chunks = captureStdout(() => {
      const log = getLogger();
      log.info("should not appear");
      log.warn("should not appear");
      log.error("should not appear");
      log.fatal("should not appear");
    });

    expect(chunks.join("")).toBe("");
  });

  it("child logger of a silent root produces zero output", () => {
    configureRootLogger({ level: "silent" });

    const chunks = captureStdout(() => {
      const child = createLogger({ component: "x" });
      child.info("nope");
      child.error("nope");
    });

    expect(chunks.join("")).toBe("");
  });

  it("per-request child (runWithRequestContext) produces zero output", () => {
    configureRootLogger({ level: "silent" });

    const chunks = captureStdout(() => {
      const ctx = createRequestContext({ requestId: "req-silent-001" });
      runWithRequestContext(ctx, () => {
        getLogger().info("nope");
        getLogger().error("nope");
      });
    });

    expect(chunks.join("")).toBe("");
  });

  it("re-bound child chains (.child().child()) remain silent", () => {
    configureRootLogger({ level: "silent" });

    const chunks = captureStdout(() => {
      const a = createLogger({ tier: 1 });
      const b = a.child({ tier: 2 });
      const c = b.child({ tier: 3 });
      c.info("nope");
      c.fatal("nope");
    });

    expect(chunks.join("")).toBe("");
  });

  it("a child with an explicit non-silent level override still emits nothing", () => {
    // This is the hardening case the configureRootLogger silent branch
    // exists to cover. Stock pino would honor the child's level override
    // and write to the destination; the pinned no-op destination drops it.
    configureRootLogger({ level: "silent" });

    const chunks = captureStdout(() => {
      const child = createLogger({ component: "override" });
      // Mutate the child level directly — pino allows this and would
      // otherwise let the child emit through the inherited destination.
      (child as { level: string }).level = "info";
      child.info("would-leak-without-hardening");
      child.error("would-leak-without-hardening");
    });

    expect(chunks.join("")).toBe("");
  });
});

describe("configureRootLogger — non-silent and duplicate-call paths", () => {
  beforeEach(() => {
    _resetRootLoggerForTesting();
  });

  afterEach(() => {
    _resetRootLoggerForTesting();
  });

  it("non-silent level is honored without the no-op destination hardening", () => {
    // Exercises the non-silent branch of configureRootLogger. A "warn"-level
    // root must still emit "warn" and above to stdout.
    configureRootLogger({ level: "warn" });

    const chunks = captureStdout(() => {
      getLogger().info("dropped by level filter");
      getLogger().warn("kept");
    });

    const joined = chunks.join("");
    expect(joined).not.toContain("dropped by level filter");
    expect(joined).toContain("kept");
  });

  it("a second call to configureRootLogger is ignored and emits a warning", () => {
    configureRootLogger({ level: "warn" });

    const chunks = captureStdout(() => {
      // Second call: should NOT replace the logger; should warn instead.
      configureRootLogger({ level: "error" });
      // Root remains at "warn" — a warn emit must still appear.
      getLogger().warn("still-warning");
    });

    const joined = chunks.join("");
    expect(joined).toContain("configureRootLogger called more than once");
    expect(joined).toContain("still-warning");
  });
});
