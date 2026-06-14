import { describe, it, expect } from "vitest";
import { DEFAULT_REDACT_PATHS, DEFAULT_REDACT_CONFIG } from "../../src/logger/redact.js";

describe("DEFAULT_REDACT_PATHS", () => {
  it("is a non-empty frozen array", () => {
    expect(Array.isArray(DEFAULT_REDACT_PATHS)).toBe(true);
    expect(DEFAULT_REDACT_PATHS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(DEFAULT_REDACT_PATHS)).toBe(true);
  });

  const documentedPaths = [
    "*.password",
    "*.token",
    "*.secret",
    "*.access_token",
    "*.refresh_token",
    "*.authorization",
    "*.cookie",
    "*.session",
    "*.api_key",
    "req.headers.authorization",
    "req.headers.cookie",
  ];

  for (const path of documentedPaths) {
    it(`contains the documented path: ${path}`, () => {
      expect(DEFAULT_REDACT_PATHS).toContain(path);
    });
  }
});

describe("DEFAULT_REDACT_CONFIG", () => {
  it("has paths array pointing to DEFAULT_REDACT_PATHS entries", () => {
    expect(DEFAULT_REDACT_CONFIG.paths).toEqual(expect.arrayContaining(["*.password", "*.token"]));
  });

  it("has a censor string", () => {
    expect(typeof DEFAULT_REDACT_CONFIG.censor).toBe("string");
    expect(DEFAULT_REDACT_CONFIG.censor.length).toBeGreaterThan(0);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(DEFAULT_REDACT_CONFIG)).toBe(true);
  });
});
