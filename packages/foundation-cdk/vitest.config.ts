import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "foundation-cdk",
    include: ["test/**/*.test.ts", "test/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
      include: ["lib/**/*.ts"],
      exclude: ["lib/**/*.d.ts", "lib/**/index.ts"],
    },
    // NodejsFunction synth invokes esbuild via child_process.spawnSync,
    // which is incompatible with vitest's thread-worker stdio. Use forks
    // so each worker has a real process stdio.
    pool: "forks",
    poolOptions: { forks: { maxForks: 4, minForks: 2 } },
    isolate: true,
    sequence: { shuffle: true, seed: 1000 },
    testTimeout: 5000,
    hookTimeout: 5000,
  },
});
