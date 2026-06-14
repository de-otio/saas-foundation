/**
 * Unit test for the check-changesets CI gate.
 *
 * The gate's pure logic (`evaluateChangesets`) is exercised here against
 * synthetic inputs. The test covers the four main outcomes:
 *   - non-trivial source change WITH a changeset → passes
 *   - non-trivial source change WITHOUT a changeset → fails
 *   - docs-only / trivial change without a changeset → passes (exempt)
 *   - [skip changeset] in PR title → passes regardless of diff
 *
 * End-to-end (real-git) verification of the gate is covered by CI
 * running the CLI form against the real working tree.
 */

import { describe, expect, it } from "vitest";

import { evaluateChangesets } from "./check-changesets.js";

describe("check-changesets: evaluateChangesets", () => {
  it("passes when a source change is present and a changeset file exists", () => {
    const result = evaluateChangesets({
      changedFiles: [
        "packages/foundation/src/logger/pino.ts",
        "packages/foundation/src/logger/pino.test.ts",
      ],
      changesetFiles: ["witty-owls-dance.md"],
    });
    expect(result.ok).toBe(true);
  });

  it("fails when a source change is present but no changeset file exists", () => {
    const result = evaluateChangesets({
      changedFiles: [
        "packages/vestibulum/src/components/Button.tsx",
        "packages/vestibulum/src/components/Button.test.tsx",
      ],
      changesetFiles: [],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/packages\/\*\/src\//);
  });

  it("passes when only non-source files are changed (docs-only PR)", () => {
    const result = evaluateChangesets({
      changedFiles: [
        "README.md",
        "doc/05-versioning-and-releases.md",
        "scripts/ci/check-changesets.ts",
      ],
      changesetFiles: [],
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toMatch(/changeset not required/);
  });

  it("passes when PR title contains [skip changeset] regardless of source changes", () => {
    const result = evaluateChangesets({
      changedFiles: ["packages/foundation/src/core/index.ts"],
      changesetFiles: [],
      prTitle: "refactor: internal cleanup [skip changeset]",
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toMatch(/\[skip changeset\]/);
  });

  it("[skip changeset] bypass fires even with no changeset files and source changes", () => {
    const result = evaluateChangesets({
      changedFiles: [
        "packages/foundation/src/types/index.ts",
        "packages/vestibulum/src/index.ts",
      ],
      changesetFiles: [],
      prTitle: "[skip changeset] rename internal symbols",
    });
    expect(result.ok).toBe(true);
  });

  it("passes when no files are changed at all", () => {
    const result = evaluateChangesets({
      changedFiles: [],
      changesetFiles: [],
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toMatch(/changeset not required/);
  });

  it("passes when only config/tooling files are changed", () => {
    const result = evaluateChangesets({
      changedFiles: [
        ".github/workflows/ci.yml",
        "package.json",
        "tsconfig.base.json",
        "scripts/ci/check-changesets.ts",
      ],
      changesetFiles: [],
    });
    expect(result.ok).toBe(true);
  });

  it("fails when a nested src/ path is changed with no changeset", () => {
    // Confirm the src/ pattern matches nested subdirectories
    const result = evaluateChangesets({
      changedFiles: ["packages/vestibulum-cdk/src/constructs/api/gateway.ts"],
      changesetFiles: [],
    });
    expect(result.ok).toBe(false);
  });

  it("passes when multiple source packages are changed and at least one changeset exists", () => {
    // The gate only requires at least one .changeset/*.md — not one per package
    const result = evaluateChangesets({
      changedFiles: [
        "packages/foundation/src/logger/pino.ts",
        "packages/vestibulum/src/index.ts",
      ],
      changesetFiles: ["shy-bears-jump.md"],
    });
    expect(result.ok).toBe(true);
  });

  it("prTitle defaults to empty string when omitted (no bypass)", () => {
    // Omitting prTitle should not trigger the [skip changeset] bypass
    const result = evaluateChangesets({
      changedFiles: ["packages/foundation/src/core/tenant.ts"],
      changesetFiles: [],
      // prTitle intentionally omitted
    });
    expect(result.ok).toBe(false);
  });
});
