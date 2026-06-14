/**
 * Tests for `MultiAuditStore`.
 *
 * Coverage:
 *   - parallel write: all stores are called
 *   - all-or-any mode: succeeds if at least one store resolves
 *   - all-or-any mode: throws when ALL stores fail
 *   - all mode: throws on partial failure
 *   - all mode: succeeds when all stores resolve
 *   - failures are routed to the injected logger regardless of mode
 *   - empty store array throws on construction
 */

import { describe, it, expect } from "vitest";

import { MultiAuditStore } from "../../src/audit/multi-store.js";
import { AuditStoreError } from "../../src/audit/errors.js";
import type { AuditStore } from "../../src/audit/store.js";
import type { AuditEvent } from "../../src/types/frozen/audit.js";
import { tenantId } from "../../src/types/frozen/tenant.js";

function makeEvent(): AuditEvent {
  return Object.freeze({
    id: "01J0000000000000000000000",
    timestamp: "2026-05-24T08:30:15.000Z",
    tenantId: tenantId("acme"),
    actor: { kind: "anonymous" },
    action: "auth.login",
    outcome: "success",
    severity: "info",
  } as AuditEvent);
}

function makeStore(opts: { fail?: Error; calls?: AuditEvent[] } = {}): AuditStore {
  return {
    put: (event, _retentionSeconds) => {
      opts.calls?.push(event);
      if (opts.fail) return Promise.reject(opts.fail);
      return Promise.resolve();
    },
  };
}

import type { Logger } from "../../src/logger/logger.js";

interface FakeLogger extends Logger {
  errors: Array<{ obj: unknown; msg: unknown }>;
}

function makeLogger(): FakeLogger {
  const errors: Array<{ obj: unknown; msg: unknown }> = [];
  function err(obj: object, msg?: string): void;
  function err(msg: string): void;
  function err(objOrMsg: object | string, msg?: string): void {
    errors.push({ obj: objOrMsg, msg });
  }
  const noop: ((obj: object, msg?: string) => void) & ((msg: string) => void) = ((
    _: unknown,
    __?: unknown,
  ) => {
    /* noop */
  });
  const logger = {
    errors,
    error: err,
    warn: noop,
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

describe("MultiAuditStore — parallel write", () => {
  it("invokes every constituent store", async () => {
    const a: AuditEvent[] = [];
    const b: AuditEvent[] = [];
    const m = new MultiAuditStore([makeStore({ calls: a }), makeStore({ calls: b })]);
    await m.put(makeEvent(), 3600);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});

describe("MultiAuditStore — all-or-any mode (default)", () => {
  it("succeeds if at least one store resolves", async () => {
    const ok: AuditEvent[] = [];
    const m = new MultiAuditStore(
      [makeStore({ fail: new Error("primary down") }), makeStore({ calls: ok })],
      { mode: "all-or-any", logger: makeLogger() },
    );
    await expect(m.put(makeEvent(), 3600)).resolves.toBeUndefined();
    expect(ok).toHaveLength(1);
  });

  it("throws when ALL stores fail", async () => {
    const m = new MultiAuditStore(
      [
        makeStore({ fail: new Error("primary down") }),
        makeStore({ fail: new Error("secondary down") }),
      ],
      { mode: "all-or-any", logger: makeLogger() },
    );
    await expect(m.put(makeEvent(), 3600)).rejects.toBeInstanceOf(AuditStoreError);
  });

  it("logs each backing-store failure", async () => {
    const logger = makeLogger();
    const m = new MultiAuditStore([makeStore({ fail: new Error("primary down") }), makeStore()], {
      mode: "all-or-any",
      logger,
    });
    await m.put(makeEvent(), 3600);
    expect(logger.errors).toHaveLength(1);
  });
});

describe("MultiAuditStore — all mode", () => {
  it("succeeds when every store resolves", async () => {
    const m = new MultiAuditStore([makeStore(), makeStore()], { mode: "all" });
    await expect(m.put(makeEvent(), 3600)).resolves.toBeUndefined();
  });

  it("throws on partial failure (one store fails)", async () => {
    const m = new MultiAuditStore([makeStore(), makeStore({ fail: new Error("secondary down") })], {
      mode: "all",
      logger: makeLogger(),
    });
    await expect(m.put(makeEvent(), 3600)).rejects.toBeInstanceOf(AuditStoreError);
  });

  it("throws on all failure", async () => {
    const m = new MultiAuditStore(
      [
        makeStore({ fail: new Error("primary down") }),
        makeStore({ fail: new Error("secondary down") }),
      ],
      { mode: "all", logger: makeLogger() },
    );
    await expect(m.put(makeEvent(), 3600)).rejects.toBeInstanceOf(AuditStoreError);
  });
});

describe("MultiAuditStore — construction", () => {
  it("throws on an empty stores array", () => {
    expect(() => new MultiAuditStore([])).toThrow();
  });
});
