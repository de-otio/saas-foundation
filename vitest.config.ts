import { defineConfig } from "vitest/config";

// Root Vitest config. Vitest 4 removed `vitest.workspace.ts` /
// `defineWorkspace`; the monorepo's per-package projects are now declared
// here via `test.projects`. Each entry points at a directory containing its
// own `vitest.config.ts`, so per-project settings (globalSetup, coverage
// thresholds, pool, seed) are honoured — notably vestibulum's globalSetup
// that generates the SAML test fixtures.
export default defineConfig({
  test: {
    projects: [
      "packages/foundation",
      "packages/vestibulum",
      "packages/foundation-cdk",
      "packages/vestibulum-cdk",
      // Cross-package CI gate scripts have their own test suite.
      "scripts",
    ],
  },
});
