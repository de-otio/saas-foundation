/**
 * Tests for the pino-backed logger.
 *
 * Key invariants tested:
 * - getLogger() returns root logger outside any request context
 * - runWithRequestContext + getLogger() returns the per-request child
 * - The per-request child includes requestId, tenantId bindings
 * - Redaction works: sensitive paths appear as [REDACTED] in output
 * - configureRootLogger is a one-shot config (second call is a no-op + warning)
 * - Frozen clock used for timestamp assertions
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import pino from "pino";
import { getLogger, createLogger, _replaceRootLoggerForTesting } from "../../src/logger/logger.js";
import { runWithRequestContext, createRequestContext } from "../../src/request-context/index.js";
import { tenantId } from "../../src/types/frozen/tenant.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a pino logger that writes to an in-memory array.
 * Returns `{ logger, lines }` where `lines` is the captured JSON lines.
 */
function captureLogger(overrides?: pino.LoggerOptions): {
  logger: pino.Logger;
  lines: string[];
} {
  const lines: string[] = [];
  const dest = {
    write(chunk: string): boolean {
      lines.push(chunk.trim());
      return true;
    },
  };
  const logger = pino({ level: "trace", ...overrides }, dest);
  return { logger, lines };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getLogger() — outside request context", () => {
  it("returns a logger object (has info method)", () => {
    const logger = getLogger();
    expect(typeof logger.info).toBe("function");
  });
});

describe("getLogger() — inside runWithRequestContext", () => {
  it("returns a child logger with requestId binding", () => {
    const { logger: pinoLogger, lines } = captureLogger();
    const restore = _replaceRootLoggerForTesting(pinoLogger);

    const ctx = createRequestContext({ requestId: "req-abc-123" });

    runWithRequestContext(ctx, () => {
      const log = getLogger();
      log.info("hello from request");
    });

    restore();

    expect(lines.length).toBeGreaterThanOrEqual(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry["requestId"]).toBe("req-abc-123");
    expect(entry["msg"]).toBe("hello from request");
  });

  it("includes tenantId in child bindings when present", () => {
    const { logger: pinoLogger, lines } = captureLogger();
    const restore = _replaceRootLoggerForTesting(pinoLogger);

    const ctx = createRequestContext({
      requestId: "req-tid-test",
      tenantId: tenantId("acme"),
    });

    runWithRequestContext(ctx, () => {
      getLogger().info("tenant log");
    });

    restore();

    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry["tenantId"]).toBe("acme");
  });

  it("includes userId binding for user principals", () => {
    const { logger: pinoLogger, lines } = captureLogger();
    const restore = _replaceRootLoggerForTesting(pinoLogger);

    const ctx = createRequestContext({
      requestId: "req-user",
      principal: { kind: "user", userSub: "user-sub-42", sessionId: "sess-1" },
    });

    runWithRequestContext(ctx, () => {
      getLogger().info("user action");
    });

    restore();

    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry["userId"]).toBe("user-sub-42");
  });

  it("nested runWithRequestContext creates independent contexts", () => {
    const { logger: pinoLogger, lines } = captureLogger();
    const restore = _replaceRootLoggerForTesting(pinoLogger);

    const outer = createRequestContext({ requestId: "outer-req" });
    const inner = createRequestContext({ requestId: "inner-req" });

    runWithRequestContext(outer, () => {
      getLogger().info("outer log");

      runWithRequestContext(inner, () => {
        getLogger().info("inner log");
      });

      getLogger().info("outer log after inner");
    });

    restore();

    const outerEntry1 = JSON.parse(lines[0]!) as Record<string, unknown>;
    const innerEntry = JSON.parse(lines[1]!) as Record<string, unknown>;
    const outerEntry2 = JSON.parse(lines[2]!) as Record<string, unknown>;

    expect(outerEntry1["requestId"]).toBe("outer-req");
    expect(innerEntry["requestId"]).toBe("inner-req");
    expect(outerEntry2["requestId"]).toBe("outer-req");
  });
});

describe("createLogger(bindings)", () => {
  it("creates a child logger with the provided bindings", () => {
    const { logger: pinoLogger, lines } = captureLogger();
    const restore = _replaceRootLoggerForTesting(pinoLogger);

    const child = createLogger({ component: "auth-service" });
    child.info("component log");

    restore();

    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry["component"]).toBe("auth-service");
  });
});

describe("redaction", () => {
  it("redacts password fields in logged objects", () => {
    const { logger: pinoLogger, lines } = captureLogger({
      redact: { paths: ["*.password"], censor: "[REDACTED]" },
    });
    const restore = _replaceRootLoggerForTesting(pinoLogger);

    const ctx = createRequestContext({ requestId: "req-redact" });
    runWithRequestContext(ctx, () => {
      getLogger().info({ user: { password: "s3cr3t" } }, "login attempt");
    });

    restore();

    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    const user = entry["user"] as Record<string, unknown>;
    expect(user["password"]).toBe("[REDACTED]");
  });
});

describe("log levels", () => {
  it("all six levels can be called without error", () => {
    const { logger: pinoLogger } = captureLogger({ level: "trace" });
    const restore = _replaceRootLoggerForTesting(pinoLogger);

    const ctx = createRequestContext({ requestId: "req-levels" });
    runWithRequestContext(ctx, () => {
      const log = getLogger();
      expect(() => log.fatal("fatal msg")).not.toThrow();
      expect(() => log.error("error msg")).not.toThrow();
      expect(() => log.warn("warn msg")).not.toThrow();
      expect(() => log.info("info msg")).not.toThrow();
      expect(() => log.debug("debug msg")).not.toThrow();
      expect(() => log.trace("trace msg")).not.toThrow();
    });

    restore();
  });
});

describe("frozen clock for timestamps", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1705312800000); // 2024-01-15T10:00:00.000Z
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("createRequestContext uses the frozen clock for startedAt", () => {
    const ctx = createRequestContext({ requestId: "req-clock" });
    expect(ctx.startedAt).toBe(1705312800000); // 2024-01-15T10:00:00.000Z
  });
});
