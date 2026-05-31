/**
 * Tests for `PrismaFeatureToggleStore`.
 *
 * Uses a structural mock of `PrismaFeatureToggleClient` — no real
 * Prisma or DB connection required.
 *
 * Coverage:
 *   - isEnabled: cache hit, cache miss, unknown key, DB error → false
 *   - get: returns mapped toggle, null for missing
 *   - list: returns sorted list, empty on table-missing
 *   - set: upsert, returns previous state, invalidates cache
 *   - delete: no-op on P2025
 *   - Prisma P2021 table-missing error → false / [] (not throw)
 *   - Schema: verifies the structural interface matches expected fields
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PrismaFeatureToggleStore,
  type PrismaFeatureToggleClient,
} from "../../src/feature-toggles/prisma.js";

const FROZEN_EPOCH_MS = 1_779_611_415_000;
/** Frozen Date instance for mock row values. */
// eslint-disable-next-line no-restricted-globals
const FROZEN_DATE = new globalThis.Date(FROZEN_EPOCH_MS);

/** Build a minimal mock row. */
function row(key: string, enabled: boolean) {
  return {
    key,
    enabled,
    changedAt: FROZEN_DATE,
    changedBy: "admin",
    description: null,
  };
}

function makeMockPrisma(
  overrides: Partial<PrismaFeatureToggleClient["featureToggle"]> = {},
): PrismaFeatureToggleClient {
  return {
    featureToggle: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue(row("default", true)),
      delete: vi.fn().mockResolvedValue({}),
      ...overrides,
    },
  };
}

describe("PrismaFeatureToggleStore — isEnabled", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false for a missing key", async () => {
    const prisma = makeMockPrisma({ findUnique: vi.fn().mockResolvedValue(null) });
    const store = new PrismaFeatureToggleStore(prisma);
    expect(await store.isEnabled("missing")).toBe(false);
  });

  it("returns true for an enabled toggle", async () => {
    const prisma = makeMockPrisma({ findUnique: vi.fn().mockResolvedValue(row("feat", true)) });
    const store = new PrismaFeatureToggleStore(prisma);
    expect(await store.isEnabled("feat")).toBe(true);
  });

  it("returns false on DB error (fail-safe)", async () => {
    const prisma = makeMockPrisma({
      findUnique: vi.fn().mockRejectedValue(new Error("connection refused")),
    });
    const store = new PrismaFeatureToggleStore(prisma);
    expect(await store.isEnabled("feat")).toBe(false);
  });

  it("returns false on P2021 table-missing error", async () => {
    const err = Object.assign(new Error("table missing"), { code: "P2021" });
    const prisma = makeMockPrisma({ findUnique: vi.fn().mockRejectedValue(err) });
    const store = new PrismaFeatureToggleStore(prisma);
    expect(await store.isEnabled("feat")).toBe(false);
  });

  it("caches the result and skips the DB on second call", async () => {
    const findUnique = vi.fn().mockResolvedValue(row("feat", true));
    const prisma = makeMockPrisma({ findUnique });
    const store = new PrismaFeatureToggleStore(prisma, { cacheTtlMs: 60_000 });
    await store.isEnabled("feat");
    await store.isEnabled("feat");
    // Only one DB call — second hit the cache.
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("bypasses cache when cacheDisabled=true", async () => {
    const findUnique = vi.fn().mockResolvedValue(row("feat", false));
    const prisma = makeMockPrisma({ findUnique });
    const store = new PrismaFeatureToggleStore(prisma, { cacheDisabled: true });
    await store.isEnabled("feat");
    await store.isEnabled("feat");
    expect(findUnique).toHaveBeenCalledTimes(2);
  });
});

describe("PrismaFeatureToggleStore — get", () => {
  it("returns null for missing key", async () => {
    const prisma = makeMockPrisma({ findUnique: vi.fn().mockResolvedValue(null) });
    const store = new PrismaFeatureToggleStore(prisma);
    expect(await store.get("missing")).toBeNull();
  });

  it("returns mapped toggle record", async () => {
    const mockRow = {
      key: "my-feat",
      enabled: true,
      changedAt: FROZEN_DATE,
      changedBy: "alice",
      description: "a feature",
    };
    const prisma = makeMockPrisma({ findUnique: vi.fn().mockResolvedValue(mockRow) });
    const store = new PrismaFeatureToggleStore(prisma);
    const toggle = await store.get("my-feat");
    expect(toggle).not.toBeNull();
    expect(toggle!.key).toBe("my-feat");
    expect(toggle!.enabled).toBe(true);
    expect(toggle!.changedBy).toBe("alice");
    expect(toggle!.description).toBe("a feature");
    expect(toggle!.changedAt).toEqual(FROZEN_DATE);
  });

  it("converts null changedBy to undefined", async () => {
    const mockRow = { ...row("feat", false), changedBy: null };
    const prisma = makeMockPrisma({ findUnique: vi.fn().mockResolvedValue(mockRow) });
    const store = new PrismaFeatureToggleStore(prisma);
    const toggle = await store.get("feat");
    expect(toggle!.changedBy).toBeUndefined();
  });
});

describe("PrismaFeatureToggleStore — list", () => {
  it("returns empty array on table-missing error (P2021)", async () => {
    const err = Object.assign(new Error("table missing"), { code: "P2021" });
    const prisma = makeMockPrisma({ findMany: vi.fn().mockRejectedValue(err) });
    const store = new PrismaFeatureToggleStore(prisma);
    const list = await store.list();
    expect(list).toEqual([]);
  });

  it("maps and returns rows", async () => {
    const rows = [row("alpha", true), row("beta", false)];
    const prisma = makeMockPrisma({ findMany: vi.fn().mockResolvedValue(rows) });
    const store = new PrismaFeatureToggleStore(prisma);
    const list = await store.list();
    expect(list).toHaveLength(2);
    expect(list[0]!.key).toBe("alpha");
    expect(list[1]!.key).toBe("beta");
  });
});

describe("PrismaFeatureToggleStore — set", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns previous=null when key did not exist", async () => {
    const upsertResult = row("feat", true);
    const prisma = makeMockPrisma({
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(upsertResult),
    });
    const store = new PrismaFeatureToggleStore(prisma);
    const { previous, current } = await store.set({
      key: "feat",
      enabled: true,
      changedBy: "admin",
    });
    expect(previous).toBeNull();
    expect(current.key).toBe("feat");
    expect(current.enabled).toBe(true);
  });

  it("returns previous state when key existed", async () => {
    const existing = row("feat", false);
    const updated = row("feat", true);
    const prisma = makeMockPrisma({
      findUnique: vi.fn().mockResolvedValue(existing),
      upsert: vi.fn().mockResolvedValue(updated),
    });
    const store = new PrismaFeatureToggleStore(prisma);
    const { previous, current } = await store.set({
      key: "feat",
      enabled: true,
      changedBy: "admin",
    });
    expect(previous!.enabled).toBe(false);
    expect(current.enabled).toBe(true);
  });

  it("invalidates the cache after set", async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(row("feat", false))
      .mockResolvedValue(row("feat", true));
    const prisma = makeMockPrisma({
      findUnique,
      upsert: vi.fn().mockResolvedValue(row("feat", true)),
    });
    const store = new PrismaFeatureToggleStore(prisma, { cacheTtlMs: 60_000 });

    // First isEnabled — caches false.
    expect(await store.isEnabled("feat")).toBe(false);
    expect(findUnique).toHaveBeenCalledTimes(1);

    // set — should invalidate cache.
    await store.set({ key: "feat", enabled: true, changedBy: "admin" });

    // Next isEnabled — cache miss, hits DB again.
    expect(await store.isEnabled("feat")).toBe(true);
    // findUnique called once for original isEnabled, once for the get() inside set, once for new isEnabled.
    expect(findUnique.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("PrismaFeatureToggleStore — delete", () => {
  it("calls prisma.featureToggle.delete", async () => {
    const deleteFn = vi.fn().mockResolvedValue({});
    const prisma = makeMockPrisma({ delete: deleteFn });
    const store = new PrismaFeatureToggleStore(prisma);
    await store.delete("feat");
    expect(deleteFn).toHaveBeenCalledWith({ where: { key: "feat" } });
  });

  it("no-ops on P2025 (record not found)", async () => {
    const err = Object.assign(new Error("record not found"), { code: "P2025" });
    const prisma = makeMockPrisma({ delete: vi.fn().mockRejectedValue(err) });
    const store = new PrismaFeatureToggleStore(prisma);
    await expect(store.delete("missing")).resolves.toBeUndefined();
  });

  it("re-throws on other errors", async () => {
    const err = new Error("connection error");
    const prisma = makeMockPrisma({ delete: vi.fn().mockRejectedValue(err) });
    const store = new PrismaFeatureToggleStore(prisma);
    await expect(store.delete("feat")).rejects.toThrow("connection error");
  });
});

describe("PrismaFeatureToggleStore — schema shape", () => {
  it("findUnique is called with the expected select shape", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const prisma = makeMockPrisma({ findUnique });
    const store = new PrismaFeatureToggleStore(prisma);
    await store.isEnabled("feat");
    const callArgs = (
      findUnique.mock.calls[0] as [
        Parameters<PrismaFeatureToggleClient["featureToggle"]["findUnique"]>[0],
      ]
    )[0];
    expect(callArgs.select).toEqual({
      key: true,
      enabled: true,
      changedAt: true,
      changedBy: true,
      description: true,
    });
  });
});
