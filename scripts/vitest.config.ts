import { defineConfig } from "vitest/config";

/**
 * Vitest config for the cross-package CI gate scripts.
 *
 * The CI gate scripts (`scripts/ci/*.ts`) implement repo-wide rules
 * (changeset-required, frozen-type fanout, peer-dep range sanity).
 * They have their own test suite here so the gate logic can be
 * exercised against synthetic inputs without requiring a real git
 * history.
 */
export default defineConfig({
  test: {
    name: "scripts",
    include: ["ci/**/*.test.ts", "ci/**/*.spec.ts"],
    pool: "threads",
    // vitest 4 removed `poolOptions`; the thread cap is the top-level `maxWorkers`.
    // This project keeps a lower cap (2) than the packages (4), so it needs a
    // distinct `sequence.groupOrder` — vitest 4 requires projects that share a
    // groupOrder to agree on maxWorkers.
    maxWorkers: 2,
    isolate: true,
    sequence: { shuffle: true, seed: 1000, groupOrder: 1 },
    testTimeout: 5000,
    hookTimeout: 5000,
  },
});
