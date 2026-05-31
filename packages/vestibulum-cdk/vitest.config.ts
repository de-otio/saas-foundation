import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "vestibulum-cdk",
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
      include: [
        "lib/aspects/**/*.ts",
        "lib/cdk-nag-rules/**/*.ts",
        "lib/waf/**/*.ts",
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
      ],
      exclude: ["lib/**/*.d.ts", "lib/**/index.ts"],
    },
    pool: "threads",
    poolOptions: { threads: { maxThreads: 4, minThreads: 2 } },
    isolate: true,
    sequence: { shuffle: true, seed: 1000 },
    testTimeout: 5000,
    hookTimeout: 5000,
  },
});
