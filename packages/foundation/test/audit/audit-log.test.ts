/**
 * Tests for `AuditLog`.
 *
 * Coverage:
 *   - emitAwait: validates, scrubs, mints id/timestamp, persists, returns
 *   - emitAwait: throws AuditWriteError when the store throws
 *   - emit: fire-and-forget; routes failures to injected logger (S-F15)
 *   - emit: validation errors go to the logger, not thrown
 *   - PII filter is applied to metadata before persistence
 *   - Metadata size cap: reject policy throws
 *   - Metadata size cap: truncate policy drops largest keys + sets marker
 *   - Severity drives retention via retentionSecondsFor
 *   - id is a ulid (26 chars Crockford Base32)
 *   - timestamp is ISO 8601 reflecting the injected clock
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { AuditLog } from "../../src/audit/audit-log.js";
import { PiiFilter } from "../../src/audit/pii-filter.js";
import type { AuditStore } from "../../src/audit/store.js";
import type { AuditEvent } from "../../src/types/frozen/audit.js";
import { AuditWriteError, AuditEventValidationError } from "../../src/audit/errors.js";
import { tenantId } from "../../src/types/frozen/tenant.js";

/** Deterministic frozen time: 2026-05-24T08:30:15.000Z */
const FROZEN_EPOCH_MS = 1_779_611_415_000;

interface FakeStore extends AuditStore {
  readonly calls: ReadonlyArray<{ event: AuditEvent; retentionSeconds: number }>;
}

function makeStore(opts: { fail?: Error } = {}): FakeStore {
  const calls: Array<{ event: AuditEvent; retentionSeconds: number }> = [];
  const store: AuditStore = {
    put: (event, retentionSeconds) => {
      if (opts.fail) return Promise.reject(opts.fail);
      calls.push({ event, retentionSeconds });
      return Promise.resolve();
    },
  };
  return Object.assign(store, { calls }) as FakeStore;
}

import type { Logger } from "../../src/logger/logger.js";

interface FakeLogger extends Logger {
  readonly errors: Array<unknown>;
  readonly warnings: Array<unknown>;
}

function makeLogger(): FakeLogger {
  const errors: Array<unknown> = [];
  const warnings: Array<unknown> = [];
  function err(obj: object, _msg?: string): void;
  function err(msg: string): void;
  function err(objOrMsg: object | string, _msg?: string): void {
    errors.push(objOrMsg);
  }
  function warn(obj: object, _msg?: string): void;
  function warn(msg: string): void;
  function warn(objOrMsg: object | string, _msg?: string): void {
    warnings.push(objOrMsg);
  }
  const noop: ((obj: object, msg?: string) => void) & ((msg: string) => void) = ((
    _: unknown,
    __?: unknown,
  ) => {
    /* noop */
  }) as never;
  const logger = {
    errors,
    warnings,
    error: err,
    warn,
    info: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child(): FakeLogger {
      return logger;
    },
    level: "info",
  };
  return logger;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_EPOCH_MS);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AuditLog.emitAwait — happy path", () => {
  it("persists the event and returns it with id + timestamp filled", async () => {
    const store = makeStore();
    const audit = new AuditLog(store);

    const result = await audit.emitAwait({
      tenantId: tenantId("acme"),
      actor: { kind: "user", userSub: "u_123" },
      action: "auth.login",
      outcome: "success",
      severity: "info",
    });

    expect(result.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // Crockford Base32, 26 chars
    expect(result.timestamp).toBe("2026-05-24T08:30:15.000Z");
    expect(result.tenantId).toBe("acme");
    expect(result.actor.kind).toBe("user");
    expect(result.action).toBe("auth.login");
    expect(result.outcome).toBe("success");
    expect(result.severity).toBe("info");

    expect(store.calls).toHaveLength(1);
    const call = store.calls[0]!;
    expect(call.event).toEqual(result);
    // info severity -> 30 days -> 30*86_400 = 2_592_000 seconds
    expect(call.retentionSeconds).toBe(2_592_000);
  });

  it("severity -> retentionSeconds: warning is 180 days", async () => {
    const store = makeStore();
    const audit = new AuditLog(store);
    await audit.emitAwait({
      actor: { kind: "system", component: "auth" },
      action: "auth.login",
      outcome: "failure",
      failureReason: "invalid password",
      severity: "warning",
    });
    expect(store.calls[0]!.retentionSeconds).toBe(180 * 86_400);
  });

  it("severity -> retentionSeconds: error is 400 days", async () => {
    const store = makeStore();
    const audit = new AuditLog(store);
    await audit.emitAwait({
      actor: { kind: "system", component: "auth" },
      action: "intrusion.detected",
      outcome: "failure",
      severity: "error",
    });
    expect(store.calls[0]!.retentionSeconds).toBe(400 * 86_400);
  });

  it("the returned event is frozen", async () => {
    const store = makeStore();
    const audit = new AuditLog(store);
    const result = await audit.emitAwait({
      actor: { kind: "anonymous" },
      action: "auth.login",
      outcome: "success",
      severity: "info",
    });
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe("AuditLog.emitAwait — error paths", () => {
  it("throws AuditWriteError when the store throws", async () => {
    const store = makeStore({ fail: new Error("db down") });
    const audit = new AuditLog(store);
    await expect(
      audit.emitAwait({
        actor: { kind: "anonymous" },
        action: "auth.login",
        outcome: "success",
        severity: "info",
      }),
    ).rejects.toBeInstanceOf(AuditWriteError);
  });

  it("throws AuditEventValidationError on bad input", async () => {
    const store = makeStore();
    const audit = new AuditLog(store);
    await expect(
      audit.emitAwait({
        // missing actor
        action: "auth.login",
        outcome: "success",
        severity: "info",
      } as unknown as Parameters<typeof audit.emitAwait>[0]),
    ).rejects.toBeInstanceOf(AuditEventValidationError);
  });
});

describe("AuditLog.emit — fire-and-forget (S-F15)", () => {
  it("returns synchronously (no await)", () => {
    const store = makeStore();
    const audit = new AuditLog(store);
    const result = audit.emit({
      actor: { kind: "anonymous" },
      action: "auth.login",
      outcome: "success",
      severity: "info",
    });
    expect(result).toBeUndefined();
  });

  it("routes store failures to the injected logger (does NOT swallow)", async () => {
    const store = makeStore({ fail: new Error("db down") });
    const logger = makeLogger();
    const audit = new AuditLog(store, { logger });

    audit.emit({
      actor: { kind: "anonymous" },
      action: "auth.login",
      outcome: "success",
      severity: "info",
    });

    // Let the unawaited promise resolve.
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.errors.length).toBeGreaterThan(0);
    const first = logger.errors[0] as { err: unknown };
    expect((first.err as Error).message).toMatch(/db down/);
  });

  it("routes validation failures to the injected logger (not thrown)", () => {
    const store = makeStore();
    const logger = makeLogger();
    const audit = new AuditLog(store, { logger });

    expect(() =>
      audit.emit({
        // missing actor
        action: "auth.login",
        outcome: "success",
        severity: "info",
      } as unknown as Parameters<typeof audit.emit>[0]),
    ).not.toThrow();

    expect(logger.errors.length).toBeGreaterThan(0);
  });

  it("initiates the store call (verified by store seeing the put)", async () => {
    const store = makeStore();
    const audit = new AuditLog(store);
    audit.emit({
      actor: { kind: "anonymous" },
      action: "auth.login",
      outcome: "success",
      severity: "info",
    });

    // Let the unawaited promise resolve.
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(store.calls).toHaveLength(1);
  });
});

describe("AuditLog — PII filter", () => {
  it("applies the default PII filter to metadata", async () => {
    const store = makeStore();
    const audit = new AuditLog(store);
    const result = await audit.emitAwait({
      actor: { kind: "anonymous" },
      action: "auth.login",
      outcome: "success",
      severity: "info",
      metadata: {
        password: "hunter2",
        access_token: "abc",
        keep_me: "visible",
      },
    });
    expect(result.metadata?.["password"]).toBe("[REDACTED]");
    expect(result.metadata?.["access_token"]).toBe("[REDACTED]");
    expect(result.metadata?.["keep_me"]).toBe("visible");
  });

  it("uses a custom PiiFilter when supplied", async () => {
    const store = makeStore();
    const audit = new AuditLog(store, {
      piiFilter: new PiiFilter({ keys: ["custom_secret"], strategy: "drop" }),
    });
    const result = await audit.emitAwait({
      actor: { kind: "anonymous" },
      action: "auth.login",
      outcome: "success",
      severity: "info",
      metadata: {
        custom_secret: "should-be-gone",
        password: "should-survive-since-not-in-list",
        ok: "ok",
      },
    });
    expect(result.metadata).not.toHaveProperty("custom_secret");
    expect(result.metadata?.["password"]).toBe("should-survive-since-not-in-list");
    expect(result.metadata?.["ok"]).toBe("ok");
  });
});

describe("AuditLog — metadata size cap", () => {
  it("throws under the default 'reject' policy when metadata is too large", async () => {
    const store = makeStore();
    const audit = new AuditLog(store, { metadataMaxBytes: 100 });
    await expect(
      audit.emitAwait({
        actor: { kind: "anonymous" },
        action: "auth.login",
        outcome: "success",
        severity: "info",
        metadata: { x: "y".repeat(500) },
      }),
    ).rejects.toBeInstanceOf(AuditEventValidationError);
    expect(store.calls).toHaveLength(0);
  });

  it("under 'truncate' policy: drops largest keys and sets the marker", async () => {
    const store = makeStore();
    const audit = new AuditLog(store, {
      metadataMaxBytes: 100,
      metadataOversizePolicy: "truncate",
    });
    const result = await audit.emitAwait({
      actor: { kind: "anonymous" },
      action: "auth.login",
      outcome: "success",
      severity: "info",
      metadata: {
        huge: "y".repeat(500),
        small: "1",
        also_small: "2",
      },
    });
    expect(result.metadata).toHaveProperty("metadata_truncated", true);
    // The two small keys survive.
    expect(result.metadata?.["small"]).toBe("1");
    expect(result.metadata?.["also_small"]).toBe("2");
    // The huge key is gone.
    expect(result.metadata).not.toHaveProperty("huge");
  });
});

describe("AuditLog — retention override", () => {
  it("respects retentionDays overrides", async () => {
    const store = makeStore();
    const audit = new AuditLog(store, {
      retentionDays: { info: 14, error: 2555 }, // 7-year for regulated verticals
    });
    await audit.emitAwait({
      actor: { kind: "anonymous" },
      action: "auth.login",
      outcome: "success",
      severity: "info",
    });
    expect(store.calls[0]!.retentionSeconds).toBe(14 * 86_400);
  });

  it("falls back to defaults for unset tiers (S-F3)", async () => {
    const store = makeStore();
    const audit = new AuditLog(store, {
      retentionDays: { info: 14 }, // warning + error unset
    });
    await audit.emitAwait({
      actor: { kind: "anonymous" },
      action: "auth.failure",
      outcome: "failure",
      severity: "warning",
    });
    expect(store.calls[0]!.retentionSeconds).toBe(180 * 86_400);
  });
});

describe("AuditLog — id and timestamp", () => {
  it("id is a fresh ulid per emit", async () => {
    const store = makeStore();
    const audit = new AuditLog(store);
    const a = await audit.emitAwait({
      actor: { kind: "anonymous" },
      action: "auth.login",
      outcome: "success",
      severity: "info",
    });
    const b = await audit.emitAwait({
      actor: { kind: "anonymous" },
      action: "auth.login",
      outcome: "success",
      severity: "info",
    });
    expect(a.id).not.toBe(b.id);
  });

  it("timestamp reflects the injected clock", async () => {
    const store = makeStore();
    // 2023-11-14T22:13:20Z — chosen so the ISO string is stable
    // without invoking the Date global.
    const fixedMs = 1_700_000_000_000;
    const expectedIso = "2023-11-14T22:13:20.000Z";
    const audit = new AuditLog(store, { clock: () => fixedMs });
    const e = await audit.emitAwait({
      actor: { kind: "anonymous" },
      action: "auth.login",
      outcome: "success",
      severity: "info",
    });
    expect(e.timestamp).toBe(expectedIso);
  });
});
