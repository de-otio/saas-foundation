/**
 * Unit test for the peer-dep-ranges CI gate.
 *
 * The gate's pure logic (`evaluatePeerDepRanges`) is exercised here against
 * synthetic PackageInfo inputs. No filesystem or git access is needed.
 *
 * End-to-end (real-git) verification of the gate is covered by CI
 * running the CLI form against the real working tree.
 */

import { describe, expect, it } from "vitest";

import {
  WORKSPACE_PACKAGES,
  evaluatePeerDepRanges,
  parseMinor,
  parseMinorFromRange,
  type PackageInfo,
} from "./check-peerdep-ranges.js";

// ---------------------------------------------------------------------------
// Helper builders
// ---------------------------------------------------------------------------

function foundation(version: string): PackageInfo {
  return { name: "@de-otio/saas-foundation", version };
}

function vestibulum(version: string, peerRange?: string): PackageInfo {
  return {
    name: "@de-otio/vestibulum",
    version,
    ...(peerRange !== undefined
      ? { peerDependencies: { "@de-otio/saas-foundation": peerRange } }
      : {}),
  };
}

function vestibulumCdk(version: string, peerRange?: string): PackageInfo {
  return {
    name: "@de-otio/vestibulum-cdk",
    version,
    ...(peerRange !== undefined
      ? { peerDependencies: { "@de-otio/saas-foundation": peerRange } }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

describe("parseMinor", () => {
  it("extracts the minor segment from a semver string", () => {
    expect(parseMinor("0.2.0")).toBe(2);
    expect(parseMinor("0.3.1")).toBe(3);
    expect(parseMinor("1.10.5")).toBe(10);
  });
});

describe("parseMinorFromRange", () => {
  it("extracts the minor from a ^0.X.Y range", () => {
    expect(parseMinorFromRange("^0.2.0")).toBe(2);
    expect(parseMinorFromRange("^0.3.0")).toBe(3);
    expect(parseMinorFromRange("^0.10.0")).toBe(10);
  });

  it("returns -1 for ranges that do not match the expected pattern", () => {
    expect(parseMinorFromRange(">=1.0.0")).toBe(-1);
    expect(parseMinorFromRange("*")).toBe(-1);
    expect(parseMinorFromRange("")).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// evaluatePeerDepRanges — main gate logic
// ---------------------------------------------------------------------------

describe("check-peerdep-ranges: evaluatePeerDepRanges", () => {
  // (a) Satisfiable set: foundation bumped, peer ranges widened to match
  it("passes when foundation MINOR bumped and all peer ranges are widened", () => {
    const packages = [
      foundation("0.3.0"),
      vestibulum("0.3.0", "^0.3.0"),
      vestibulumCdk("0.3.0", "^0.3.0"),
    ];

    const result = evaluatePeerDepRanges(packages, "0.2.0");

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  // (b) UNsatisfiable: peer range still points at the OLD minor
  it("fails when vestibulum peer range is not widened after foundation MINOR bump", () => {
    const packages = [
      foundation("0.3.0"),
      vestibulum("0.2.0", "^0.2.0"), // not widened
      vestibulumCdk("0.3.0", "^0.3.0"),
    ];

    const result = evaluatePeerDepRanges(packages, "0.2.0");

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("@de-otio/vestibulum");
    expect(result.violations[0]).toContain('"^0.2.0"');
    expect(result.violations[0]).toContain("0.3.x");
    expect(result.violations[0]).toContain('"^0.3.0"');
  });

  it("fails when vestibulum-cdk peer range is not widened after foundation MINOR bump", () => {
    const packages = [
      foundation("0.3.0"),
      vestibulum("0.3.0", "^0.3.0"),
      vestibulumCdk("0.2.0", "^0.2.0"), // not widened
    ];

    const result = evaluatePeerDepRanges(packages, "0.2.0");

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("@de-otio/vestibulum-cdk");
    expect(result.violations[0]).toContain('"^0.2.0"');
  });

  it("reports multiple violations when both vestibulum and vestibulum-cdk are stale", () => {
    const packages = [
      foundation("0.4.0"),
      vestibulum("0.3.0", "^0.3.0"),
      vestibulumCdk("0.3.0", "^0.3.0"),
    ];

    const result = evaluatePeerDepRanges(packages, "0.3.0");

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0]).toContain("@de-otio/vestibulum");
    expect(result.violations[1]).toContain("@de-otio/vestibulum-cdk");
  });

  // (c) Package with no peerDependencies is ignored cleanly
  it("passes when a workspace package declares no peerDependencies", () => {
    const packages = [
      foundation("0.3.0"),
      // vestibulum has no peerDependencies at all
      { name: "@de-otio/vestibulum", version: "0.3.0" } as PackageInfo,
      vestibulumCdk("0.3.0", "^0.3.0"),
    ];

    const result = evaluatePeerDepRanges(packages, "0.2.0");

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("passes when a workspace package has peerDependencies but not on saas-foundation", () => {
    const packages = [
      foundation("0.3.0"),
      {
        name: "@de-otio/vestibulum",
        version: "0.3.0",
        peerDependencies: { react: "^18.0.0" }, // unrelated peer dep only
      } as PackageInfo,
    ];

    const result = evaluatePeerDepRanges(packages, "0.2.0");

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  // (d) External (non-workspace) package in peerDependencies is NOT flagged
  it("ignores a peer dep on an external package whose name is not in WORKSPACE_PACKAGES", () => {
    const externalPkg: PackageInfo = {
      name: "@some-vendor/library",
      version: "2.0.0",
      peerDependencies: { "@de-otio/saas-foundation": "^0.2.0" },
    };
    const packages = [foundation("0.3.0"), externalPkg];

    const result = evaluatePeerDepRanges(packages, "0.2.0");

    // The external package is not in WORKSPACE_PACKAGES, so its stale peer
    // range must not produce a violation.
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  // --- no-bump scenarios -------------------------------------------------------

  it("skips the check when foundation MINOR is unchanged (patch bump only)", () => {
    const packages = [
      foundation("0.2.1"),
      vestibulum("0.2.0", "^0.2.0"),
      vestibulumCdk("0.2.0", "^0.2.0"),
    ];

    // base is 0.2.0, current is 0.2.1 — MINOR unchanged
    const result = evaluatePeerDepRanges(packages, "0.2.0");

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("skips the check when the base foundation version is null (new file or no origin)", () => {
    const packages = [
      foundation("0.3.0"),
      vestibulum("0.2.0", "^0.2.0"), // would fail if check ran
    ];

    const result = evaluatePeerDepRanges(packages, null);

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("skips the check when foundation is not present in the packages list", () => {
    const packages = [vestibulum("0.2.0", "^0.2.0")];

    const result = evaluatePeerDepRanges(packages, "0.2.0");

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  // --- WORKSPACE_PACKAGES export -----------------------------------------------

  it("WORKSPACE_PACKAGES exports exactly the four expected workspace names", () => {
    expect([...WORKSPACE_PACKAGES].sort()).toEqual([
      "@de-otio/saas-foundation",
      "@de-otio/saas-foundation-cdk",
      "@de-otio/vestibulum",
      "@de-otio/vestibulum-cdk",
    ]);
  });
});
