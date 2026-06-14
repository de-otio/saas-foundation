import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "vestibulum",
    globalSetup: ["test/fixtures/saml/build-fixtures.ts"],
    include: ["test/**/*.test.ts", "test/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
        // Frozen-type brand checkers hold the cross-package invariant.
        // The 95% floor is ENFORCED here (not just a convention) per the
        // P1 acceptance criteria.
        "**/src/types/frozen/**": {
          lines: 95,
          functions: 95,
          branches: 95,
          statements: 95,
        },
      },
      include: ["src/**/*.ts"],
      // Note: frozen-type brand checkers under src/types/frozen/ are
      // explicitly INCLUDED in coverage — they hold the cross-package
      // invariant. The ≥95% line/branch/function/statement floor is
      // enforced via the glob threshold above.
      exclude: ["src/**/*.d.ts", "src/**/index.ts"],
    },
    pool: "threads",
    poolOptions: { threads: { maxThreads: 4, minThreads: 2 } },
    isolate: true,
    sequence: { shuffle: true, seed: 1000 },
    testTimeout: 5000,
    hookTimeout: 5000,
  },
});
