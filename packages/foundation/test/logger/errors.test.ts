import { describe, it, expect } from "vitest";
import { LoggerConfigError } from "../../src/logger/errors.js";

describe("LoggerConfigError", () => {
  it("has the expected name and is an Error subclass", () => {
    const err = new LoggerConfigError("bad config");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("LoggerConfigError");
    expect(err.message).toBe("bad config");
  });
});
