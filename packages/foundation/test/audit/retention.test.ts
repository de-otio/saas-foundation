/**
 * Tests for retention helpers.
 *
 * Coverage:
 *   - DEFAULT_RETENTION_DAYS: info 30, warning 180, error 400 (S-F2)
 *   - retentionDaysFor: returns documented tiers when no override
 *   - retentionDaysFor: override beats default
 *   - retentionDaysFor: partial override falls back to default (S-F3)
 *   - retentionDaysFor: invalid override values fall back to default
 *   - retentionSecondsFor: convert from days
 *   - ttlFor: epoch-seconds arithmetic is correct
 */

import { describe, it, expect } from "vitest";

import {
  DEFAULT_RETENTION_DAYS,
  retentionDaysFor,
  retentionSecondsFor,
  ttlFor,
} from "../../src/audit/retention.js";

describe("DEFAULT_RETENTION_DAYS", () => {
  it("info is 30 days", () => {
    expect(DEFAULT_RETENTION_DAYS.info).toBe(30);
  });

  it("warning is 180 days", () => {
    expect(DEFAULT_RETENTION_DAYS.warning).toBe(180);
  });

  it("error is 400 days (just past a typical annual audit cycle)", () => {
    expect(DEFAULT_RETENTION_DAYS.error).toBe(400);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(DEFAULT_RETENTION_DAYS)).toBe(true);
  });
});

describe("retentionDaysFor — defaults", () => {
  it("info -> 30", () => {
    expect(retentionDaysFor("info")).toBe(30);
  });

  it("warning -> 180", () => {
    expect(retentionDaysFor("warning")).toBe(180);
  });

  it("error -> 400", () => {
    expect(retentionDaysFor("error")).toBe(400);
  });
});

describe("retentionDaysFor — full override", () => {
  it("override wins for info", () => {
    expect(retentionDaysFor("info", { info: 14 })).toBe(14);
  });

  it("override wins for error (regulated-vertical 7-year retention)", () => {
    expect(retentionDaysFor("error", { error: 2555 })).toBe(2555);
  });
});

describe("retentionDaysFor — partial override (S-F3)", () => {
  it("an override map with only info set falls back for warning + error", () => {
    expect(retentionDaysFor("warning", { info: 14 })).toBe(180);
    expect(retentionDaysFor("error", { info: 14 })).toBe(400);
  });
});

describe("retentionDaysFor — invalid override values", () => {
  it("zero falls back to default", () => {
    expect(retentionDaysFor("info", { info: 0 })).toBe(30);
  });

  it("negative falls back to default", () => {
    expect(retentionDaysFor("info", { info: -1 })).toBe(30);
  });

  it("non-finite falls back to default", () => {
    expect(retentionDaysFor("info", { info: NaN })).toBe(30);
    expect(retentionDaysFor("info", { info: Infinity })).toBe(30);
  });

  it("floors a non-integer days value", () => {
    expect(retentionDaysFor("info", { info: 14.7 })).toBe(14);
  });
});

describe("retentionSecondsFor", () => {
  it("converts days to seconds", () => {
    expect(retentionSecondsFor("info")).toBe(30 * 86_400);
  });

  it("respects overrides", () => {
    expect(retentionSecondsFor("info", { info: 14 })).toBe(14 * 86_400);
  });
});

describe("ttlFor", () => {
  it("returns nowEpochSeconds + retentionSeconds", () => {
    const now = 1_779_950_215;
    expect(ttlFor("info", now)).toBe(now + 30 * 86_400);
  });

  it("respects overrides", () => {
    const now = 1_779_950_215;
    expect(ttlFor("info", now, { info: 14 })).toBe(now + 14 * 86_400);
  });
});
