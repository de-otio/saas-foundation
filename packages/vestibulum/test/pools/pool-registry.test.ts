/**
 * Tests for the `pools/` forward-compat namespace.
 *
 * Per doc/vestibulum/06-pool-topology.md, the registry is a small
 * read-mostly utility — no runtime add/remove, no concurrency,
 * just a tidy lookup surface. The tests cover the construction-
 * time guards and the byKind filter.
 */

import { describe, it, expect } from "vitest";

import type { PoolConfig } from "../../src/pools/pool-config.js";
import { createPoolRegistry } from "../../src/pools/pool-registry.js";

const B2C: PoolConfig = {
  poolKey: "b2c",
  userPoolId: "us-east-1_aaa",
  clientId: "client-b2c",
  region: "us-east-1",
  tokenUse: "access",
  kind: "B2C",
};

const B2B: PoolConfig = {
  poolKey: "b2b",
  userPoolId: "us-east-1_bbb",
  clientId: ["client-b2b-1", "client-b2b-2"],
  region: "us-east-1",
  tokenUse: "access",
  kind: "B2B",
};

describe("createPoolRegistry", () => {
  it("throws synchronously on empty pool list", () => {
    expect(() => createPoolRegistry([])).toThrow(/at least one PoolConfig/);
  });

  it("throws synchronously on duplicate poolKey", () => {
    expect(() => createPoolRegistry([B2C, { ...B2B, poolKey: "b2c" }])).toThrow(
      /duplicate poolKey/,
    );
  });

  it("returns a pool by key", () => {
    const reg = createPoolRegistry([B2C, B2B]);
    expect(reg.get("b2c")).toBe(B2C);
    expect(reg.get("b2b")).toBe(B2B);
  });

  it("returns undefined for unknown keys", () => {
    const reg = createPoolRegistry([B2C, B2B]);
    expect(reg.get("does-not-exist")).toBeUndefined();
  });

  it("lists pools in construction order", () => {
    const reg = createPoolRegistry([B2C, B2B]);
    expect(reg.list()).toEqual([B2C, B2B]);
  });

  it("filters by kind", () => {
    const reg = createPoolRegistry([B2C, B2B]);
    expect(reg.byKind("B2C")).toEqual([B2C]);
    expect(reg.byKind("B2B")).toEqual([B2B]);
  });

  it("byKind excludes pools without a kind annotation", () => {
    const noKind: PoolConfig = {
      poolKey: "legacy",
      userPoolId: "us-east-1_legacy",
      clientId: "client",
      region: "us-east-1",
      tokenUse: "access",
    };
    const reg = createPoolRegistry([B2C, noKind]);
    expect(reg.byKind("B2C")).toEqual([B2C]);
    // `legacy` does not appear under B2C or B2B.
    expect(reg.byKind("B2B")).toEqual([]);
  });

  it("list() returns a frozen view (no caller-side mutation)", () => {
    const reg = createPoolRegistry([B2C]);
    const list = reg.list() as PoolConfig[];
    expect(Object.isFrozen(list)).toBe(true);
  });
});
