"use strict";

/**
 * Root ESLint config for the saas-foundation monorepo.
 *
 * Rules are intentionally strict:
 * - @typescript-eslint/recommended-type-checked for type-aware rules
 * - @typescript-eslint/strict for additional strictness
 * - Custom rules enforcing the package-boundary discipline
 *   documented in doc/02-monorepo-layout.md and doc/03-package-relationships.md
 *
 * Per-package overrides add further restrictions scoped to specific packages.
 */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    project: [
      "./packages/foundation/tsconfig.eslint.json",
      "./packages/foundation/tsconfig.fixtures.json",
      "./packages/vestibulum/tsconfig.eslint.json",
      "./packages/foundation-cdk/tsconfig.eslint.json",
      "./packages/vestibulum-cdk/tsconfig.eslint.json",
      "./scripts/tsconfig.eslint.json",
    ],
    tsconfigRootDir: __dirname,
  },
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended-type-checked",
    "plugin:@typescript-eslint/strict",
  ],
  rules: {
    // Drop AWS SDK promises on the floor → easy async bugs
    "@typescript-eslint/no-floating-promises": "error",

    // Coercing undefined|string to boolean hides bugs
    "@typescript-eslint/strict-boolean-expressions": "error",

    // Allow _-prefixed unused vars (conventional ignore pattern)
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],

    // Cross-package relative imports are forbidden.
    // Imports between packages must use the published package name.
    // e.g. '../../vestibulum/src/...' is forbidden;
    //      '@de-otio/vestibulum' is required.
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: ["**/packages/foundation/src/**", "**/packages/foundation/src"],
            message:
              "Cross-package relative import. Use the published package name '@de-otio/saas-foundation' instead.",
          },
          {
            group: ["**/packages/vestibulum/src/**", "**/packages/vestibulum/src"],
            message:
              "Cross-package relative import. Use the published package name '@de-otio/vestibulum' instead.",
          },
          {
            group: ["**/packages/foundation-cdk/lib/**", "**/packages/foundation-cdk/lib"],
            message:
              "Cross-package relative import. Use the published package name '@de-otio/saas-foundation-cdk' instead.",
          },
          {
            group: ["**/packages/vestibulum-cdk/lib/**", "**/packages/vestibulum-cdk/lib"],
            message:
              "Cross-package relative import. Use the published package name '@de-otio/vestibulum-cdk' instead.",
          },
          {
            group: [
              "../../foundation/**",
              "../../vestibulum/**",
              "../../foundation-cdk/**",
              "../../vestibulum-cdk/**",
              "../../../packages/**",
            ],
            message:
              "Cross-package relative import. Use the published package name instead.",
          },
        ],
      },
    ],
  },
  overrides: [
    // --- packages/foundation: no aws-cdk-lib imports ---
    // Note: fixture files in test/eslint-fixtures/ are excluded from the
    // normal lint pass via ignorePatterns, but when linted explicitly
    // (e.g. with --no-ignore for CI fixture verification), this override
    // DOES apply so the rule fires as expected.
    {
      files: ["packages/foundation/**/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              // CDK ban (foundation must be CDK-free)
              {
                group: ["aws-cdk-lib", "aws-cdk-lib/**", "constructs"],
                message:
                  "foundation must not import aws-cdk-lib or constructs. CDK is a deploy-time concern; keep foundation CDK-free.",
              },
              // Cross-package absolute patterns
              {
                group: ["**/packages/vestibulum/src/**", "**/packages/vestibulum/src"],
                message:
                  "Cross-package relative import. Use the published package name '@de-otio/vestibulum' instead.",
              },
              {
                group: ["**/packages/foundation-cdk/lib/**", "**/packages/foundation-cdk/lib"],
                message:
                  "Cross-package relative import. Use the published package name '@de-otio/saas-foundation-cdk' instead.",
              },
              {
                group: ["**/packages/vestibulum-cdk/lib/**", "**/packages/vestibulum-cdk/lib"],
                message:
                  "Cross-package relative import. Use the published package name '@de-otio/vestibulum-cdk' instead.",
              },
              // Cross-package relative path patterns (e.g. ../../vestibulum/src/...)
              {
                group: [
                  "../../vestibulum/**",
                  "../../foundation-cdk/**",
                  "../../vestibulum-cdk/**",
                  "../../../packages/**",
                ],
                message:
                  "Cross-package relative import. Use the published package name instead.",
              },
            ],
          },
        ],
      },
    },

    // --- packages/foundation/src/audit: @prisma/client quarantined to prisma.ts ---
    // Only `src/audit/prisma.ts` may top-level import @prisma/client.
    // Other files under src/audit/ would defeat the optional-peer-dep
    // pattern documented in doc/foundation/01-package-api.md § Prisma sub-paths.
    //
    // The patterns below include the foundation-wide CDK ban (which the
    // earlier foundation override sets) plus the prisma quarantine,
    // because ESLint overrides replace rule values rather than merging
    // them when the same rule is set in two overrides that both match a
    // file.
    //
    // The `audit-prisma-leak.fixture.ts` fixture under
    // `test/eslint-fixtures/` is also matched: the CI gate test runs
    // eslint over it (with --no-ignore so it isn't filtered by the
    // global `eslint-fixtures/` ignore) to verify the rule fires.
    {
      files: [
        "packages/foundation/src/audit/**/*.ts",
        "packages/foundation/test/eslint-fixtures/audit-prisma-leak.fixture.ts",
      ],
      excludedFiles: ["packages/foundation/src/audit/prisma.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: [
              {
                name: "@prisma/client",
                message:
                  "Only src/audit/prisma.ts may import @prisma/client. The sub-path quarantine keeps the optional peer dep optional in practice. See doc/foundation/01-package-api.md § Prisma sub-paths.",
              },
            ],
            patterns: [
              // Prisma quarantine
              {
                group: ["@prisma/client/**"],
                message:
                  "Only src/audit/prisma.ts may import @prisma/client. See doc/foundation/01-package-api.md § Prisma sub-paths.",
              },
              // Inherited foundation rules
              {
                group: ["aws-cdk-lib", "aws-cdk-lib/**", "constructs"],
                message:
                  "foundation must not import aws-cdk-lib or constructs. CDK is a deploy-time concern; keep foundation CDK-free.",
              },
              {
                group: ["**/packages/vestibulum/src/**", "**/packages/vestibulum/src"],
                message:
                  "Cross-package relative import. Use the published package name '@de-otio/vestibulum' instead.",
              },
              {
                group: ["**/packages/foundation-cdk/lib/**", "**/packages/foundation-cdk/lib"],
                message:
                  "Cross-package relative import. Use the published package name '@de-otio/saas-foundation-cdk' instead.",
              },
              {
                group: ["**/packages/vestibulum-cdk/lib/**", "**/packages/vestibulum-cdk/lib"],
                message:
                  "Cross-package relative import. Use the published package name '@de-otio/vestibulum-cdk' instead.",
              },
              {
                group: [
                  "../../vestibulum/**",
                  "../../foundation-cdk/**",
                  "../../vestibulum-cdk/**",
                  "../../../packages/**",
                ],
                message:
                  "Cross-package relative import. Use the published package name instead.",
              },
            ],
          },
        ],
      },
    },

    // --- packages/foundation/src/feature-toggles: @prisma/client quarantined to prisma.ts ---
    // Mirror of the audit quarantine rule. Only `src/feature-toggles/prisma.ts`
    // may top-level import @prisma/client. Other files under
    // `src/feature-toggles/` would defeat the optional-peer-dep pattern.
    //
    // The fixture at `test/eslint-fixtures/feature-toggles-prisma-leak.fixture.ts`
    // is matched so the CI gate test can verify the rule fires on it.
    {
      files: [
        "packages/foundation/src/feature-toggles/**/*.ts",
        "packages/foundation/test/eslint-fixtures/feature-toggles-prisma-leak.fixture.ts",
      ],
      excludedFiles: ["packages/foundation/src/feature-toggles/prisma.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: [
              {
                name: "@prisma/client",
                message:
                  "Only src/feature-toggles/prisma.ts may import @prisma/client. The sub-path quarantine keeps the optional peer dep optional in practice. See doc/foundation/01-package-api.md § Prisma sub-paths.",
              },
            ],
            patterns: [
              // Prisma quarantine
              {
                group: ["@prisma/client/**"],
                message:
                  "Only src/feature-toggles/prisma.ts may import @prisma/client. See doc/foundation/01-package-api.md § Prisma sub-paths.",
              },
              // Inherited foundation rules
              {
                group: ["aws-cdk-lib", "aws-cdk-lib/**", "constructs"],
                message:
                  "foundation must not import aws-cdk-lib or constructs. CDK is a deploy-time concern; keep foundation CDK-free.",
              },
              {
                group: ["**/packages/vestibulum/src/**", "**/packages/vestibulum/src"],
                message:
                  "Cross-package relative import. Use the published package name '@de-otio/vestibulum' instead.",
              },
              {
                group: ["**/packages/foundation-cdk/lib/**", "**/packages/foundation-cdk/lib"],
                message:
                  "Cross-package relative import. Use the published package name '@de-otio/saas-foundation-cdk' instead.",
              },
              {
                group: ["**/packages/vestibulum-cdk/lib/**", "**/packages/vestibulum-cdk/lib"],
                message:
                  "Cross-package relative import. Use the published package name '@de-otio/vestibulum-cdk' instead.",
              },
              {
                group: [
                  "../../vestibulum/**",
                  "../../foundation-cdk/**",
                  "../../vestibulum-cdk/**",
                  "../../../packages/**",
                ],
                message:
                  "Cross-package relative import. Use the published package name instead.",
              },
            ],
          },
        ],
      },
    },

    // --- packages/foundation-cdk: no value imports of @de-otio/saas-foundation* ---
    // Type-only imports are permitted (erased at compile time, no runtime dep).
    // Value imports would pull AWS SDK runtime into the consumer's CDK synth process.
    {
      files: ["packages/foundation-cdk/**/*.ts"],
      rules: {
        "@typescript-eslint/no-restricted-imports": [
          "error",
          {
            paths: [
              {
                name: "@de-otio/saas-foundation",
                allowTypeImports: true,
                message:
                  "foundation-cdk must not import @de-otio/saas-foundation at the value level. Use 'import type' to avoid pulling AWS SDK runtime into CDK synth.",
              },
            ],
            patterns: [
              {
                group: ["@de-otio/saas-foundation/**"],
                allowTypeImports: true,
                message:
                  "foundation-cdk must not value-import from @de-otio/saas-foundation sub-paths. Use 'import type'.",
              },
            ],
          },
        ],
      },
    },

    // --- test files: no real Date or Math.random globals ---
    // Enforces the determinism rules from doc/02-monorepo-layout.md.
    // Tests must use vi.useFakeTimers() or injected clock; randomness must be seeded.
    //
    // Also relaxes no-non-null-assertion in test files: non-null assertions on
    // mock call results (e.g. mock.commandCalls(Cmd)[0]!.args[0].input) are
    // idiomatic in aws-sdk-client-mock tests and throwing on undefined is the
    // correct failure mode for a malformed mock setup.
    {
      files: [
        "packages/*/test/**/*.ts",
        "packages/*/test/**/*.spec.ts",
        "packages/*/**/*.test.ts",
        "packages/*/**/*.spec.ts",
      ],
      excludedFiles: ["packages/*/test/eslint-fixtures/**"],
      rules: {
        "no-restricted-globals": [
          "error",
          {
            name: "Date",
            message:
              "Do not use the real Date global in tests. Use vi.useFakeTimers() or an injected clock parameter to ensure deterministic time-based assertions.",
          },
        ],
        "no-restricted-properties": [
          "error",
          {
            object: "Math",
            property: "random",
            message:
              "Do not call Math.random() in tests without a seeded source. Use a seeded random instance injected via the Random parameter pattern.",
          },
        ],
        "@typescript-eslint/no-non-null-assertion": "off",
        // Mock implementations in tests are typed async to match interfaces
        // but don't need await; turning the rule off for tests avoids noise.
        "@typescript-eslint/require-await": "off",
      },
    },

    // --- scripts TypeScript files: allow looser rules ---
    {
      files: ["scripts/**/*.ts"],
      rules: {
        "@typescript-eslint/no-floating-promises": "error",
        "@typescript-eslint/strict-boolean-expressions": "off",
      },
    },

  ],

  ignorePatterns: [
    "dist/",
    "node_modules/",
    "coverage/",
    "*.tsbuildinfo",
    "lambda-bundles/",
    "cdk.out/",
    // .mjs files are plain ESM scripts not part of a TS project; excluded from
    // type-aware linting. Add to a separate non-type-checked eslint config if needed.
    "**/*.mjs",
    // login-pages/ holds browser-delivered static assets (plain .js shipped to
    // the magic-link login page), not part of any TS project — excluded from
    // type-aware linting for the same reason as .mjs above.
    "packages/*/login-pages/",
    // Fixture files are linted explicitly by CI gate tests, not the normal lint pass
    "packages/*/test/eslint-fixtures/",
  ],
};
