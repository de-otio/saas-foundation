import { describe, it, expect } from "vitest";
import {
  LOG_LEVELS,
  LOG_LEVEL_SEVERITY,
  isLogLevel,
  compareLogLevelSeverity,
} from "../../src/logger/levels.js";
import type { LogLevel } from "../../src/logger/levels.js";

describe("LOG_LEVELS", () => {
  it("contains exactly six levels", () => {
    expect(LOG_LEVELS).toHaveLength(6);
  });

  it("contains all expected levels", () => {
    const expected: ReadonlyArray<LogLevel> = ["fatal", "error", "warn", "info", "debug", "trace"];
    for (const level of expected) {
      expect(LOG_LEVELS).toContain(level);
    }
  });

  it("is ordered from most to least severe", () => {
    for (let i = 0; i < LOG_LEVELS.length - 1; i++) {
      const a = LOG_LEVELS[i] as LogLevel;
      const b = LOG_LEVELS[i + 1] as LogLevel;
      expect(LOG_LEVEL_SEVERITY[a]).toBeGreaterThan(LOG_LEVEL_SEVERITY[b]);
    }
  });
});

describe("isLogLevel", () => {
  it("returns true for every valid level", () => {
    for (const level of LOG_LEVELS) {
      expect(isLogLevel(level)).toBe(true);
    }
  });

  it("returns false for unknown strings", () => {
    expect(isLogLevel("verbose")).toBe(false);
    expect(isLogLevel("WARNING")).toBe(false);
    expect(isLogLevel("INFO")).toBe(false);
    expect(isLogLevel("")).toBe(false);
  });

  it("returns false for non-string values", () => {
    expect(isLogLevel(42)).toBe(false);
    expect(isLogLevel(null)).toBe(false);
    expect(isLogLevel(undefined)).toBe(false);
    expect(isLogLevel({})).toBe(false);
  });
});

describe("compareLogLevelSeverity", () => {
  it("fatal is more severe than error", () => {
    expect(compareLogLevelSeverity("fatal", "error")).toBeGreaterThan(0);
  });

  it("trace is less severe than debug", () => {
    expect(compareLogLevelSeverity("trace", "debug")).toBeLessThan(0);
  });

  it("equal levels return 0", () => {
    for (const level of LOG_LEVELS) {
      expect(compareLogLevelSeverity(level, level)).toBe(0);
    }
  });

  it("every level is reachable by severity comparison", () => {
    const sorted = [...LOG_LEVELS].sort((a, b) => compareLogLevelSeverity(a, b));
    // After ascending sort (least severe first), trace should be first, fatal last
    expect(sorted[0]).toBe("trace");
    expect(sorted[sorted.length - 1]).toBe("fatal");
  });
});
