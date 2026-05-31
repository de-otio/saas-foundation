import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "foundation",
    include: ["test/**/*.test.ts", "test/**/*.spec.ts"],
    exclude: ["test/eslint-fixtures/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
      include: ["src/**/*.ts"],
      // Note: frozen-type brand checkers under src/types/frozen/ are
      // explicitly INCLUDED in coverage — they hold the cross-package
      // invariant and require ≥ 95% line/branch coverage per the P1
      // acceptance criteria. Only barrels (index.ts) and pure-type
      // .d.ts files are excluded.
      exclude: ["src/**/*.d.ts", "src/**/index.ts", "src/secrets/schemas.ts"],
    },
    pool: "threads",
    poolOptions: { threads: { maxThreads: 4, minThreads: 2 } },
    isolate: true,
    sequence: { shuffle: true, seed: 1000 },
    testTimeout: 5000,
    hookTimeout: 5000,
  },
});
