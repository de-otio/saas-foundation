# 02 — Monorepo layout

The concrete shape of the workspace. Where every file goes, what
tooling lives at the root, what each package owns, and how the build
and test orchestration composes.

## Directory tree

```
saas-foundation/
├── .changeset/                       # changesets config + pending changes
│   └── config.json
├── .github/
│   └── workflows/
│       ├── ci.yml                    # build + test + lint on PRs
│       └── publish.yml               # changesets version PR + OIDC publish
├── doc/                              # design docs (this directory)
├── examples/                         # end-to-end consumer examples
│   └── shared-distribution/          # shared-pool multi-tenant topology
├── packages/
│   ├── foundation/
│   │   ├── src/
│   │   ├── test/
│   │   ├── CHANGELOG.md
│   │   ├── README.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── vestibulum/
│   │   ├── src/
│   │   ├── test/
│   │   ├── CHANGELOG.md
│   │   ├── README.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── foundation-cdk/
│   │   ├── lib/                      # CDK construct source (trellis/CDK convention)
│   │   │   ├── nodejs-lambda/
│   │   │   ├── queue-with-dlq/
│   │   │   ├── single-table/
│   │   │   └── dashboards/
│   │   │       └── templates/        # JSON dashboard templates (data assets)
│   │   ├── test/
│   │   ├── CHANGELOG.md
│   │   ├── README.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── vestibulum-cdk/
│       ├── lib/                      # CDK construct source (existing convention)
│       ├── lambda-bundles/           # generated, gitignored
│       ├── login-pages/              # static HTML/CSS for the auth site
│       ├── test/
│       ├── scripts/                  # build-bundles, verify-bundles
│       ├── CHANGELOG.md
│       ├── README.md
│       ├── package.json
│       └── tsconfig.json
├── scripts/                          # cross-package tooling
│   ├── ci/                           # CI gate scripts (see 05-versioning)
│   │   ├── check-changesets.ts
│   │   ├── check-frozen-fanout.ts
│   │   └── check-peerdep-ranges.ts
│   └── build/                        # topological build / clean
├── .eslintrc.cjs                     # root ESLint
├── .gitignore
├── .prettierrc                       # transplanted from trellis
├── .nvmrc                            # Node 24
├── package.json                      # workspace root
├── package-lock.json
├── README.md
├── tsconfig.base.json                # shared compiler options
├── tsconfig.json                     # project-references aggregator
└── vitest.workspace.ts               # multi-project vitest config
```

Two things deliberately absent: no `apps/` directory (saas-foundation
does not host runnable apps; examples and consumers are external), and
no top-level `lib/` or `src/` (everything lives under
`packages/<name>/`).

## Workspaces declaration

Root `package.json`:

```json
{
  "name": "saas-foundation",
  "private": true,
  "workspaces": ["packages/*"],
  "engines": { "node": ">=24.0.0" },
  "scripts": {
    "build": "node scripts/build/topo.mjs",
    "typecheck": "tsc -b",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint packages scripts",
    "lint:fix": "eslint packages scripts --fix",
    "format": "prettier --write \"packages/**/*.{ts,tsx,md}\" \"doc/**/*.md\"",
    "changeset": "changeset",
    "version": "changeset version && npm install --package-lock-only",
    "release": "changeset publish"
  }
}
```

Per-package `package.json` follows the same shape; the `name` field
matches the published npm name (`@de-otio/saas-foundation`, etc.). No
`paths` aliases; cross-package imports use the published name.

## TypeScript setup

**Project references**, not path aliases. Without project references,
`tsc` does not understand the topological order of inter-workspace
deps and incremental builds break.

`tsconfig.base.json` (compiler options shared by all packages):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`tsconfig.json` at the root is a references aggregator:

```json
{
  "files": [],
  "references": [
    { "path": "packages/foundation" },
    { "path": "packages/vestibulum" },
    { "path": "packages/foundation-cdk" },
    { "path": "packages/vestibulum-cdk" }
  ]
}
```

Per-package `tsconfig.json` extends the base and declares its own
references:

```jsonc
// packages/vestibulum/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../foundation" }],
}
```

**No `paths` aliases.** Path aliases work in `tsc` but break runtime
imports unless every consumer remaps them too. Workspace deps +
project references is the only setup that's consistent across
build-time and runtime.

## Module system

ESM throughout for `foundation` and `vestibulum`. `"type": "module"`
in each package's `package.json`. Output `.js` files use ESM syntax.

`vestibulum-cdk` is the awkward case: CDK consumers are split between
ESM and CommonJS, and a CJS consumer importing an ESM-only construct
package hits `ERR_REQUIRE_ESM` with no actionable error message. Two
options, tracked as an open question below:

1. **Dual-publish** ESM + CJS via tsup / rollup. ~30 extra lines of
   build config; bullet-proof for consumers.
2. **ESM-only**, document the requirement, push back on consumers
   still on CJS-CDK setups (which is the modern default anyway in
   2026).

Lean toward dual-publish for vestibulum-cdk only. Foundation and
vestibulum stay ESM-only — their consumers are API processes that
can be configured to ESM.

## Test framework

**Vitest** at the workspace root via
`vitest.workspace.ts`. Reasons:

- Trellis already uses vitest; the foundation modules we're extracting
  arrive with vitest tests already written
  (`apps/api/test/unit/*.test.ts` shape).
- ESM-first: matches the rest of the build.
- Fast: shared transformer across packages, parallel execution by
  default.
- API-compatible with jest for the patterns we care about
  (`vi.hoisted`, `vi.mock` with module factories,
  `vi.clearAllMocks`).

Vestibulum's original test suite used jest + `aws-sdk-client-mock` +
`aws-sdk-client-mock-jest`. The jest→vitest port is complete: all
four packages (including vestibulum) now use vitest. The mechanical
port was:

- `jest.fn()` → `vi.fn()`
- `jest.mock('mod', factory)` → `vi.mock('mod', factory)` (vitest
  hoists differently — top-level mocks work the same, but factory
  dependencies need `vi.hoisted` to be available)
- `aws-sdk-client-mock-jest` matchers → vitest equivalents
- jest config removed; vitest config wired per package

Per-package `vitest.config.ts` defines test directory and any
package-specific setup (e.g., vestibulum-cdk needs JSDOM for the
login-page tests; foundation does not).

`vitest.workspace.ts` at root composes the per-package configs:

```typescript
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/foundation",
  "packages/vestibulum",
  "packages/foundation-cdk",
  "packages/vestibulum-cdk",
]);
```

`npm test` at root runs all four suites; `npm test --workspace
@de-otio/vestibulum` runs one.

### Determinism rules

The repo is AI-maintained (see
[`10-ai-maintained-conventions.md`](10-ai-maintained-conventions.md));
flaky tests are the highest-leverage failure mode to prevent. Every
test suite — unit, snapshot, integration — observes the following:

- **No time-of-day assertions.** Use `vi.useFakeTimers()` or an
  injected `clock: () => Date` callback. Code that internally calls
  `Date.now()` / `new Date()` accepts a `clock` parameter; tests
  pin it.
- **No sort-order-dependent assertions** on `Object.keys`,
  `Map.entries()`, set iteration, or unsorted DB queries. Sort
  explicitly before comparing, or use set-equality matchers.
  The `check-unsorted-toequal` CI gate enforces a conservative subset
  of this rule (see below).
- **No real network or filesystem.** Mock at the AWS SDK or `fetch`
  boundary. Tests that genuinely need the network (LocalStack,
  integration tests against vestibulum-cdk synth output) live in a
  separate `integration/` test config and do not run on every PR.
- **No `Math.random()` or `crypto.randomBytes()` without seed
  injection.** Code paths consuming randomness accept a `Random`
  parameter (defaulting to the real one); tests pass a seeded
  instance.
- **Snapshot tests pin every input that affects logical IDs.** Stack
  name, account, region, and any prop value that flows into a
  construct's `id` chain. Otherwise a snapshot diff is
  indistinguishable from a real regression.

These rules are enforced by ESLint (`no-restricted-globals` on
`Date`/`Math.random` inside `test/`), by the `check-unsorted-toequal`
CI gate (see `scripts/ci/check-unsorted-toequal.ts`), and by review
discipline for the snapshot-input rule.

The CI gate is intentionally conservative to keep false positives near
zero. It flags equality assertions (`.toEqual` / `.toStrictEqual`) that
are applied **directly** to known-unordered iterables:

- `expect(Object.keys(x)).toEqual(...)` — and the `.values` / `.entries`
  variants. Chaining `.sort()` before the assertion (`Object.keys(x).sort()`)
  is not flagged.
- `expect([...x.keys()]).toEqual(...)` or `[...x.values()]` spreads.
- `expect([...someSet]).toEqual(...)` where the variable name contains
  "set" or "map" (case-insensitive heuristic).

It does **not** attempt data-flow analysis on arbitrary array variables;
that would produce noise. Escape hatch: a `// sorted-ok` comment on
the assertion line or the line immediately above suppresses the finding
when order is guaranteed by other means (e.g. the source is a sorted
database query or a manually ordered literal).

## Linting and formatting

**ESLint** at root with per-package overrides. Root config establishes
the base ruleset (`@typescript-eslint/recommended-type-checked`,
`@typescript-eslint/strict`, plus a handful of project rules):

- `@typescript-eslint/no-floating-promises: error` — especially
  catches dropped AWS SDK promises.
- `@typescript-eslint/strict-boolean-expressions: error` — no
  truthy-coercion of `undefined | string` etc.
- `@typescript-eslint/no-unused-vars: error` — with the `_` prefix
  exemption.

Two custom rules enforced by ESLint config:

- **No cross-package relative imports.** A file under
  `packages/vestibulum/src/` cannot import via
  `../../foundation/src/...`. Must use the published name
  (`@de-otio/saas-foundation`). Enforced via the
  `no-restricted-imports` rule with a pattern blocklist.
- **No `aws-cdk-lib` inside `packages/foundation/`.** Foundation is
  CDK-free by definition; this prevents accidental scope creep.
  Enforced with `no-restricted-imports` scoped to that package's
  ESLint override.
- **No value imports of `@de-otio/saas-foundation*` inside
  `packages/foundation-cdk/`.** Foundation-cdk runs in the
  consumer's CDK synth process and must not pull AWS SDK
  runtime into synth. `import type { TenantId } from
'@de-otio/saas-foundation'` is permitted; value imports
  are not. Enforced via a custom `no-restricted-imports` rule
  in the package's ESLint override.

**Prettier** transplanted from trellis (`.prettierrc`, same
config). Formatting is not enforced by CI — `npm run format` is a
manual / pre-commit affordance, not a gate. The cost of formatting
arguments exceeds the cost of an inconsistent diff.

## Build orchestration

`npm run build` at root runs `scripts/build/topo.mjs`:

1. Determine the package dependency order via the workspace graph:
   `foundation` and `foundation-cdk` are siblings with no inter-dep;
   `vestibulum` depends on `foundation`; `vestibulum-cdk` depends
   on `vestibulum` (at bundle-time) and optionally on `foundation-cdk`
   (at type-check time once it adopts foundation-cdk constructs).
   A valid topo order is `foundation → foundation-cdk → vestibulum
→ vestibulum-cdk`; the script computes it from each package's
   declared peer/build deps, so adding a package only requires
   declaring deps correctly.
2. For each package in order, run its build script.
3. `foundation`, `foundation-cdk`, and `vestibulum` produce `dist/`
   via `tsc`.
4. `vestibulum-cdk` produces `dist/` via `tsc` **and** generates
   `lambda-bundles/` by bundling vestibulum Lambda handlers
   (next section).

`npm run typecheck` at root uses `tsc --build` (project references)
across the whole workspace — fast on incremental, no emit.

`npm run clean` deletes `packages/*/dist/`, `packages/*/.tsbuildinfo`,
`packages/vestibulum-cdk/lambda-bundles/`, and root `node_modules/.cache`.
The foundation-cdk dashboard JSON templates are _not_ generated —
they're committed source under `packages/foundation-cdk/lib/dashboards/templates/`
and are copied to `dist/dashboards/templates/` by the build step.

## Bundling vestibulum Lambda code into vestibulum-cdk

The only cross-package build-time coupling. `vestibulum` exports
Lambda handler factories (`createPreTokenGenerationHandler`,
`createPostConfirmationHandler`); `vestibulum-cdk` needs the
_bundled_ output to ship as Lambda function code.

Today, vestibulum's `runtime/scripts/build-bundles.js` walks its own
source and produces hashed bundles. In the monorepo, that script
moves to `packages/vestibulum-cdk/scripts/build-bundles.ts` and
treats `@de-otio/vestibulum` as the bundling input:

- esbuild entry point: a small wrapper per trigger
  (`packages/vestibulum-cdk/scripts/lambda-entries/pre-token.ts`)
  that imports from `@de-otio/vestibulum` and exports the handler.
- Output: `packages/vestibulum-cdk/lambda-bundles/pre-token-<hash>.js`
  and matching for each trigger.
- Hash: SHA-256 over the bundled bytes; written to a manifest the
  CDK constructs reference at synth time.

`verify-bundles.ts` (CI gate) recomputes the hash from the published
artifact and fails the release if it diverges from the committed
manifest. Prevents a published `vestibulum-cdk` from containing
Lambda code that doesn't match the `vestibulum` version it claims to
ship.

The bundles directory is gitignored; the hash manifest
(`packages/vestibulum-cdk/lambda-bundles.lock.json`) is committed.
The lock is what the release process validates against.

## Examples

`examples/<topology>/` directories at root. Each example has its
own `package.json` and is **not** part of the workspace — it
installs the saas-foundation packages via local file paths
(`"@de-otio/vestibulum-cdk": "file:../../packages/vestibulum-cdk"`)
so it always builds against current source.

First example: `examples/shared-distribution/` — a runnable CDK app
demonstrating the `SharedDistributionIdentity` multi-tenant shared-pool
topology. It installs all four packages via `file:` paths and commits
its `cdk.context.json` for deterministic synth.

Examples are smoke-tested in CI on every PR (synth-only — no real
deploy) to catch breakage at the consumer surface.

**Commit `cdk.context.json` per example.** CDK best practice from
the [official guidance](https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html):
context snapshots (AZ lookups, AMI IDs, VPC lookups) must be
checked into version control so synth is deterministic. Each
example app under `examples/<topology>/` therefore commits its own
`cdk.context.json`. CI synth must not have AWS credentials available
— if a synth attempts a fresh lookup, it fails, signalling that the
context file is out of date and needs a refresh in a separate PR.
This is the same posture vestibulum-cdk and foundation-cdk consumers
should follow in their own apps; both packages' READMEs include a
one-line reminder.

## Scripts

Root `scripts/` directory holds anything that's truly cross-package:

- `scripts/build/topo.mjs` — topological build runner.
- `scripts/ci/check-changesets.ts` — CI gate from
  [`05-versioning-and-releases.md`](05-versioning-and-releases.md).
- `scripts/ci/check-frozen-fanout.ts` — frozen-type fanout enforcer.
- `scripts/ci/check-peerdep-ranges.ts` — peer-dep range sanity.

Per-package `scripts/` holds package-specific tooling:

- `packages/vestibulum-cdk/scripts/build-bundles.ts`
- `packages/vestibulum-cdk/scripts/verify-bundles.ts`

The split rule: if a script ever runs across more than one package, it
lives at root; otherwise it lives in the package.

## Node version

**Node 24**, pinned via `.nvmrc` and `engines.node` in every
`package.json`. Reason: npm Trusted Publishing requires npm ≥ 11.5.1,
which ships with Node 24. Node 22 (npm 10) fails the publish step
with a misleading 404 after sigstore signing — captured in user-global
CLAUDE.md and re-stated in
[`05-versioning-and-releases.md`](05-versioning-and-releases.md).

CI uses `actions/setup-node@v4` with `node-version-file: .nvmrc` so a
version bump only touches one file.

## What goes at root vs per package

Quick reference:

| File / dir            | Root                   | Per-package                    |
| --------------------- | ---------------------- | ------------------------------ |
| `package.json`        | yes (workspace)        | yes (published)                |
| `tsconfig.json`       | yes (references)       | yes (config)                   |
| `tsconfig.base.json`  | yes                    | extend only                    |
| `.eslintrc.cjs`       | yes                    | optional override              |
| `.prettierrc`         | yes                    | no                             |
| `vitest.workspace.ts` | yes                    | per-package `vitest.config.ts` |
| `CHANGELOG.md`        | no                     | yes                            |
| `README.md`           | yes (project overview) | yes (package docs)             |
| `LICENSE`             | yes                    | no (symlink or inherited)      |
| `.changeset/`         | yes                    | no                             |
| `.github/workflows/`  | yes                    | no                             |
| `scripts/`            | yes (cross-cutting)    | yes (package-local)            |
| `examples/`           | yes                    | no                             |

## Open questions

- **Dual-publish vestibulum-cdk (ESM + CJS)** vs ESM-only with a
  documented requirement? Decide before vestibulum-cdk's first
  monorepo publish.
- **License at root only, or per-package?** Per-package is npm
  convention; symlinks work but are fiddly on Windows (irrelevant
  here). Probably just commit `LICENSE` at root and reference it
  from each `package.json`'s `license` field.
- **Husky / lint-staged?** Trellis and vestibulum both go without
  pre-commit hooks. Inclination: also go without. Re-evaluate if a
  contributor consistently misses the format step.
- **Turborepo or nx for the build graph?** `scripts/build/topo.mjs`
  is ~50 lines and does what we need; the dependency-graph runners
  pay off at ten packages, not three. Stick with the homegrown
  script; revisit if the package count grows.
