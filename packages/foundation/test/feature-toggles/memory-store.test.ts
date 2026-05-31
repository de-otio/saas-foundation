/**
 * Tests for `MemoryFeatureToggleStore`.
 *
 * No external dependencies; all in-memory.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { MemoryFeatureToggleStore } from "../../src/feature-toggles/memory-store.js";

const FROZEN_EPOCH_MS = 1_779_611_415_000;

describe("MemoryFeatureToggleStore — isEnabled", () => {
  it("returns false for an unknown key (safe default)", async () => {
    const store = new MemoryFeatureToggleStore();
    expect(await store.isEnabled("nonexistent")).toBe(false);
  });

  it("returns true for a seeded-enabled key", async () => {
    const store = new MemoryFeatureToggleStore({ "my-feature": true });
    expect(await store.isEnabled("my-feature")).toBe(true);
  });

  it("returns false for a seeded-disabled key", async () => {
    const store = new MemoryFeatureToggleStore({ "my-feature": false });
    expect(await store.isEnabled("my-feature")).toBe(false);
  });
});

describe("MemoryFeatureToggleStore — get", () => {
  it("returns null for an unknown key", async () => {
    const store = new MemoryFeatureToggleStore();
    expect(await store.get("nonexistent")).toBeNull();
  });

  it("returns the full record for a seeded key", async () => {
    const store = new MemoryFeatureToggleStore({ "feature-a": true });
    const toggle = await store.get("feature-a");
    expect(toggle).not.toBeNull();
    expect(toggle!.key).toBe("feature-a");
    expect(toggle!.enabled).toBe(true);
    expect(toggle!.changedBy).toBe("seed");
  });
});

describe("MemoryFeatureToggleStore — list", () => {
  it("returns empty array for an empty store", async () => {
    const store = new MemoryFeatureToggleStore();
    const list = await store.list();
    expect(list).toEqual([]);
  });

  it("returns all seeded toggles in alphabetical order", async () => {
    const store = new MemoryFeatureToggleStore({
      zebra: true,
      apple: false,
      mango: true,
    });
    const list = await store.list();
    expect(list.map((t) => t.key)).toEqual(["apple", "mango", "zebra"]);
  });
});

describe("MemoryFeatureToggleStore — set", () => {
  let store: MemoryFeatureToggleStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
    store = new MemoryFeatureToggleStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a new toggle and returns previous=null", async () => {
    const { previous, current } = await store.set({
      key: "new-feature",
      enabled: true,
      changedBy: "admin@example.com",
    });
    expect(previous).toBeNull();
    expect(current.key).toBe("new-feature");
    expect(current.enabled).toBe(true);
    expect(current.changedBy).toBe("admin@example.com");
  });

  it("updates an existing toggle and returns the previous state", async () => {
    await store.set({ key: "feature", enabled: false, changedBy: "user-a" });
    const { previous, current } = await store.set({
      key: "feature",
      enabled: true,
      changedBy: "user-b",
    });
    expect(previous).not.toBeNull();
    expect(previous!.enabled).toBe(false);
    expect(current.enabled).toBe(true);
    expect(current.changedBy).toBe("user-b");
  });

  it("preserves description across updates that omit it", async () => {
    await store.set({
      key: "feature",
      enabled: true,
      changedBy: "user-a",
      description: "my description",
    });
    const { current } = await store.set({
      key: "feature",
      enabled: false,
      changedBy: "user-b",
      // no description provided
    });
    expect(current.description).toBe("my description");
  });

  it("overrides description when provided in update", async () => {
    await store.set({
      key: "feature",
      enabled: true,
      changedBy: "user-a",
      description: "old",
    });
    const { current } = await store.set({
      key: "feature",
      enabled: true,
      changedBy: "user-b",
      description: "new",
    });
    expect(current.description).toBe("new");
  });

  it("isEnabled reflects the latest state after set", async () => {
    await store.set({ key: "feat", enabled: false, changedBy: "user" });
    expect(await store.isEnabled("feat")).toBe(false);
    await store.set({ key: "feat", enabled: true, changedBy: "user" });
    expect(await store.isEnabled("feat")).toBe(true);
  });
});

describe("MemoryFeatureToggleStore — delete", () => {
  it("deletes an existing toggle", async () => {
    const store = new MemoryFeatureToggleStore({ feature: true });
    await store.delete("feature");
    expect(await store.get("feature")).toBeNull();
    expect(await store.isEnabled("feature")).toBe(false);
  });

  it("no-ops when the key does not exist", async () => {
    const store = new MemoryFeatureToggleStore();
    await expect(store.delete("nonexistent")).resolves.toBeUndefined();
  });
});
