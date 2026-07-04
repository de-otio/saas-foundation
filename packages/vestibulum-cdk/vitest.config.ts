import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "vestibulum-cdk",
    include: ["test/**/*.test.ts", "test/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      thresholds: {
        perFile: true,
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
      include: [
        "lib/aspects/**/*.ts",
        "lib/cdk-nag-rules/**/*.ts",
        "lib/custom-attributes/**/*.ts",
        "lib/hosted-ui-domain/**/*.ts",
        "lib/app-clients/**/*.ts",
        "lib/trigger-hooks/**/*.ts",
        "lib/metrics/**/*.ts",
        "lib/magic-link-identity/**/*.ts",
        // Cost-pillar S7 — shared SES cost-DoS guard helper.
        "lib/_internal/cost-dos-guard.ts",
        // P2a — shared-distribution-identity core construct
        "lib/shared-distribution-identity/identity.ts",
        "lib/shared-distribution-identity/client-config-table.ts",
        "lib/shared-distribution-identity/reservations-table.ts",
        "lib/shared-distribution-identity/triggers.ts",
        "lib/shared-distribution-identity/wildcard-cert.ts",
        // P2b — CloudFront + edge + WAF + security headers
        "lib/shared-distribution-identity/cloudfront-distribution.ts",
        "lib/shared-distribution-identity/edge-function.ts",
        "lib/shared-distribution-identity/waf.ts",
        "lib/shared-distribution-identity/security-headers.ts",
        // Cost-pillar S4 — S3 lifecycle defaults
        "lib/_internal/s3-lifecycle.ts",
        "lib/magic-link-auth-site/magic-link-auth-site.ts",
        // Behaviour-bearing internals and constructs (added when the
        // check-coverage-include gate flagged them as missing from the
        // allow-list — see scripts/ci/check-coverage-include.ts).
        "lib/_internal/branding.ts",
        "lib/_internal/package-root.ts",
        "lib/_internal/runtime-env.ts",
        "lib/edge-resources/edge-resources.ts",
        "lib/edge-resources/cross-region.ts",
        "lib/edge-resources/waf-defaults.ts",
        "lib/magic-link-auth-site/auth-verify-paths.ts",
        "lib/magic-link-auth-site/ses-validation.ts",
        "lib/shared-distribution-identity/admin-lambda.ts",
        "lib/shared-distribution-identity/reconciler.ts",
      ],
      // edge-handle.ts and identity-handle.ts are interface-only (zero
      // runtime code), so they are excluded by design rather than
      // coverage-gated — the gate treats them as a documented decision.
      exclude: [
        "lib/**/*.d.ts",
        "lib/**/index.ts",
        "lib/_internal/edge-handle.ts",
        "lib/_internal/identity-handle.ts",
      ],
    },
    pool: "threads",
    poolOptions: { threads: { maxThreads: 4, minThreads: 2 } },
    isolate: true,
    sequence: { shuffle: true, seed: 1000 },
    testTimeout: 5000,
    hookTimeout: 5000,
  },
});
