/**
 * Unit test for the frozen-fanout CI gate.
 *
 * The gate's pure logic (`evaluateFanout`) is exercised here against
 * synthetic inputs. The success and failure fixtures cover both the
 * foundation-owned and vestibulum-owned watch paths.
 *
 * End-to-end (real-git) verification of the gate is covered by CI
 * running the CLI form against the real working tree.
 */

import { describe, expect, it } from "vitest";

import { FROZEN_RULES, evaluateFanout } from "./check-frozen-fanout.js";

describe("check-frozen-fanout: evaluateFanout", () => {
  it("passes when no frozen-type files are changed", () => {
    const diffFiles = [
      "packages/foundation/src/logger/pino.ts",
      "packages/foundation/test/logger/pino.test.ts",
      "README.md",
    ];
    const changedPackages = new Set<string>(["@de-otio/saas-foundation"]);

    const failures = evaluateFanout(diffFiles, changedPackages);
    expect(failures).toEqual([]);
  });

  it("passes for a foundation frozen-type change with full fanout", () => {
    const diffFiles = [
      "packages/foundation/src/types/frozen/tenant.ts",
      "packages/foundation/test/frozen/tenant.property.test.ts",
    ];
    const changedPackages = new Set<string>([
      "@de-otio/saas-foundation",
      "@de-otio/vestibulum",
      "@de-otio/vestibulum-cdk",
    ]);

    const failures = evaluateFanout(diffFiles, changedPackages);
    expect(failures).toEqual([]);
  });

  it("fails for a foundation frozen-type change with NO changesets", () => {
    const diffFiles = ["packages/foundation/src/types/frozen/tenant.ts"];
    const changedPackages = new Set<string>();

    const failures = evaluateFanout(diffFiles, changedPackages);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("packages\\/foundation\\/src\\/types\\/frozen\\/");
    expect(failures[0]).toContain("@de-otio/saas-foundation");
    expect(failures[0]).toContain("@de-otio/vestibulum");
    expect(failures[0]).toContain("@de-otio/vestibulum-cdk");
  });

  it("fails for a foundation frozen-type change when only one dependent has a changeset", () => {
    const diffFiles = ["packages/foundation/src/types/frozen/audit.ts"];
    const changedPackages = new Set<string>(["@de-otio/saas-foundation"]);

    const failures = evaluateFanout(diffFiles, changedPackages);
    expect(failures).toHaveLength(1);
    // Foundation itself is covered; the missing fanout is vestibulum + vestibulum-cdk
    expect(failures[0]).toContain("@de-otio/vestibulum");
    expect(failures[0]).toContain("@de-otio/vestibulum-cdk");
    expect(failures[0]).not.toContain("@de-otio/saas-foundation,");
  });

  it("passes for a vestibulum-owned frozen-type change with vestibulum + vestibulum-cdk changesets", () => {
    const diffFiles = ["packages/vestibulum/src/types/frozen/callbacks.ts"];
    const changedPackages = new Set<string>([
      "@de-otio/vestibulum",
      "@de-otio/vestibulum-cdk",
    ]);

    const failures = evaluateFanout(diffFiles, changedPackages);
    expect(failures).toEqual([]);
  });

  it("fails for a vestibulum-owned frozen-type change without vestibulum-cdk fanout", () => {
    const diffFiles = ["packages/vestibulum/src/types/frozen/callbacks.ts"];
    const changedPackages = new Set<string>(["@de-otio/vestibulum"]);

    const failures = evaluateFanout(diffFiles, changedPackages);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("@de-otio/vestibulum-cdk");
  });

  it("reports both rules independently when both watch paths fire", () => {
    const diffFiles = [
      "packages/foundation/src/types/frozen/tenant.ts",
      "packages/vestibulum/src/types/frozen/callbacks.ts",
    ];
    // No changesets at all
    const changedPackages = new Set<string>();

    const failures = evaluateFanout(diffFiles, changedPackages);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain("foundation\\/src\\/types\\/frozen");
    expect(failures[1]).toContain("vestibulum\\/src\\/types\\/frozen");
  });

  it("FROZEN_RULES exports the expected watch paths", () => {
    // Pin the rule set; if anyone adds a new frozen-type path, the test
    // forces them to update this assertion AND the gate rules together.
    expect(FROZEN_RULES.map((r) => r.watchPath.source)).toEqual([
      "^packages\\/foundation\\/src\\/types\\/frozen\\/",
      "^packages\\/vestibulum\\/src\\/types\\/frozen\\/",
    ]);
  });

  it("a frozen change to a sub-folder file still fires the rule", () => {
    const diffFiles = ["packages/foundation/src/types/frozen/sub/dir/file.ts"];
    const changedPackages = new Set<string>();

    const failures = evaluateFanout(diffFiles, changedPackages);
    expect(failures).toHaveLength(1);
  });

  it("a change to packages/foundation/src/types/ (NOT frozen/) does not fire the rule", () => {
    const diffFiles = ["packages/foundation/src/types/internal.ts"];
    const changedPackages = new Set<string>();

    const failures = evaluateFanout(diffFiles, changedPackages);
    expect(failures).toEqual([]);
  });
});
