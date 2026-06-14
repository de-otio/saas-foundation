/**
 * Unit tests for the coverage-include CI gate.
 *
 * The gate's pure logic (`findUncoveredConstructs`) is exercised here
 * against synthetic inputs.  The CLI form (real filesystem + real
 * vitest.config.ts import) is covered by running the script directly
 * in CI.
 *
 * Test matrix:
 *   (a) A lib file present in the include list → not reported.
 *   (b) A new behaviour-bearing lib file absent from the include list → reported.
 *   (c) barrel (`index.ts`) and `.d.ts` files → never reported.
 *   (d) A file matched by an exclude glob → not reported.
 */

import { describe, expect, it } from "vitest";

import { findUncoveredConstructs } from "./check-coverage-include.js";

// Minimal include / exclude globs mirroring the real vestibulum-cdk config.
const INCLUDE_GLOBS = [
  "lib/aspects/**/*.ts",
  "lib/waf/**/*.ts",
  "lib/_internal/cost-dos-guard.ts",
  "lib/shared-distribution-identity/identity.ts",
];

const EXCLUDE_GLOBS = ["lib/**/*.d.ts", "lib/**/index.ts"];

describe("findUncoveredConstructs", () => {
  // (a) Files that match an include glob → not reported.
  it("does not report a lib file that is present in the include list (wildcard match)", () => {
    const libFiles = ["lib/aspects/disabled-auth-flows.ts"];
    const result = findUncoveredConstructs(libFiles, INCLUDE_GLOBS, EXCLUDE_GLOBS);
    expect(result).toEqual([]);
  });

  it("does not report a lib file that is present in the include list (exact match)", () => {
    const libFiles = ["lib/_internal/cost-dos-guard.ts"];
    const result = findUncoveredConstructs(libFiles, INCLUDE_GLOBS, EXCLUDE_GLOBS);
    expect(result).toEqual([]);
  });

  // (b) A new behaviour-bearing file absent from the include list → reported.
  it("reports a behaviour-bearing lib file that is absent from the include list", () => {
    const libFiles = ["lib/edge-resources/edge-resources.ts"];
    const result = findUncoveredConstructs(libFiles, INCLUDE_GLOBS, EXCLUDE_GLOBS);
    expect(result).toEqual(["lib/edge-resources/edge-resources.ts"]);
  });

  it("reports only the absent files when mixed with covered files", () => {
    const libFiles = [
      "lib/aspects/waf-required.ts", // covered by lib/aspects/**/*.ts
      "lib/edge-resources/cross-region.ts", // NOT covered
      "lib/waf/default-rules.ts", // covered by lib/waf/**/*.ts
      "lib/_internal/branding.ts", // NOT covered
    ];
    const result = findUncoveredConstructs(libFiles, INCLUDE_GLOBS, EXCLUDE_GLOBS);
    expect(result).toEqual([
      "lib/edge-resources/cross-region.ts",
      "lib/_internal/branding.ts",
    ]);
  });

  // (c) Barrels and declaration files → never reported regardless of coverage.
  it("never reports lib/index.ts (package-root barrel)", () => {
    const libFiles = ["lib/index.ts"];
    const result = findUncoveredConstructs(libFiles, INCLUDE_GLOBS, EXCLUDE_GLOBS);
    expect(result).toEqual([]);
  });

  it("never reports a sub-directory barrel (index.ts)", () => {
    const libFiles = [
      "lib/aspects/index.ts",
      "lib/custom-attributes/index.ts",
      "lib/waf/index.ts",
    ];
    const result = findUncoveredConstructs(libFiles, INCLUDE_GLOBS, EXCLUDE_GLOBS);
    expect(result).toEqual([]);
  });

  it("never reports a .d.ts file", () => {
    const libFiles = [
      "lib/aspects/types.d.ts",
      "lib/waf/waf-rules.d.ts",
    ];
    const result = findUncoveredConstructs(libFiles, INCLUDE_GLOBS, EXCLUDE_GLOBS);
    expect(result).toEqual([]);
  });

  // (d) Files matched by an exclude glob → not reported.
  it("does not report a file that is matched by an exclude glob", () => {
    // lib/**/*.d.ts and lib/**/index.ts are in EXCLUDE_GLOBS.
    // Adding a hypothetical exclude to verify custom exclude globs work too.
    const customExcludeGlobs = [
      ...EXCLUDE_GLOBS,
      "lib/_internal/package-root.ts",
    ];
    const libFiles = ["lib/_internal/package-root.ts"];
    const result = findUncoveredConstructs(libFiles, INCLUDE_GLOBS, customExcludeGlobs);
    expect(result).toEqual([]);
  });

  // Edge cases.
  it("returns empty array when libFiles is empty", () => {
    const result = findUncoveredConstructs([], INCLUDE_GLOBS, EXCLUDE_GLOBS);
    expect(result).toEqual([]);
  });

  it("reports all behaviour-bearing files when includeGlobs is empty", () => {
    const libFiles = [
      "lib/aspects/waf-required.ts",
      "lib/aspects/index.ts", // barrel — should still be skipped
    ];
    const result = findUncoveredConstructs(libFiles, [], EXCLUDE_GLOBS);
    // Only the non-barrel is reported
    expect(result).toEqual(["lib/aspects/waf-required.ts"]);
  });

  it("supports deep ** patterns matching nested paths", () => {
    const deepInclude = ["lib/shared-distribution-identity/**/*.ts"];
    const libFiles = [
      "lib/shared-distribution-identity/identity.ts",
      "lib/shared-distribution-identity/cloudfront-distribution.ts",
      "lib/shared-distribution-identity/sub/nested/helper.ts",
    ];
    const result = findUncoveredConstructs(libFiles, deepInclude, EXCLUDE_GLOBS);
    expect(result).toEqual([]);
  });

  it("exact-file pattern does not match sibling files in the same directory", () => {
    // Only lib/_internal/cost-dos-guard.ts is listed; its sibling should be flagged.
    const libFiles = [
      "lib/_internal/cost-dos-guard.ts", // in INCLUDE_GLOBS
      "lib/_internal/runtime-env.ts", // NOT in INCLUDE_GLOBS
    ];
    const result = findUncoveredConstructs(libFiles, INCLUDE_GLOBS, EXCLUDE_GLOBS);
    expect(result).toEqual(["lib/_internal/runtime-env.ts"]);
  });
});
