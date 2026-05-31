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
    poolOptions: { threads: { maxThreads: 2, minThreads: 1 } },
    isolate: true,
    sequence: { shuffle: true, seed: 1000 },
    testTimeout: 5000,
    hookTimeout: 5000,
  },
});
