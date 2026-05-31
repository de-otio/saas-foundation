#!/usr/bin/env node
/**
 * CI gate: check-coverage-include
 *
 * Fails when a behaviour-bearing TypeScript file under
 * packages/vestibulum-cdk/lib/ is NOT matched by any glob in the
 * vitest.config.ts `coverage.include` allow-list.
 *
 * A file is "behaviour-bearing" if it is NOT:
 *   - a barrel (`index.ts` or the package-root `lib/index.ts`)
 *   - a type declaration (`*.d.ts`)
 *   - matched by an `coverage.exclude` glob
 *
 * A behaviour-bearing file is "covered" if it matches at least one
 * `coverage.include` glob.
 *
 * Usage (from CI):
 *   npx tsx scripts/ci/check-coverage-include.ts
 *
 * The script reads the vitest config at runtime so it stays in sync
 * automatically — no second source of truth to maintain.
 */

import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { minimatch } from "minimatch";

// ---------------------------------------------------------------------------
// Pure logic — exported for unit tests
// ---------------------------------------------------------------------------

/**
 * Returns the subset of `libFiles` that are behaviour-bearing but not
 * matched by any glob in `includeGlobs`.
 *
 * @param libFiles    Relative paths such as `lib/aspects/foo.ts`
 *                    (relative to the package root, matching how the
 *                    include globs are written in vitest.config.ts).
 * @param includeGlobs  Globs from `coverage.include` in vitest.config.ts.
 * @param excludeGlobs  Globs from `coverage.exclude` in vitest.config.ts.
 * @returns           Files that are uncovered — should be empty in a
 *                    healthy repo; non-empty means CI should fail.
 */
export function findUncoveredConstructs(
  libFiles: string[],
  includeGlobs: string[],
  excludeGlobs: string[],
): string[] {
  const uncovered: string[] = [];

  for (const file of libFiles) {
    // Barrels: lib/index.ts or any lib/**/index.ts
    const isBarrel =
      file === "lib/index.ts" || file.endsWith("/index.ts");

    // Type declarations — only ever emitted; no behaviour.
    const isDts = file.endsWith(".d.ts");

    // Files excluded by the coverage.exclude list are intentionally
    // omitted from coverage instrumentation.
    const isExcluded = excludeGlobs.some((g) => minimatch(file, g));

    if (isBarrel || isDts || isExcluded) {
      // Not behaviour-bearing — skip without reporting.
      continue;
    }

    // Behaviour-bearing: must appear in the include list.
    const isCovered = includeGlobs.some((g) => minimatch(file, g));

    if (!isCovered) {
      uncovered.push(file);
    }
  }

  return uncovered;
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/** Recursively enumerate all files under `dir`, returning absolute paths. */
function walkDir(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Locate the repo root relative to this script's directory.
  // __dirname equivalent for ESM:
  const scriptDir = fileURLToPath(new URL(".", import.meta.url));
  // scripts/ci/ → two levels up → repo root
  const repoRoot = join(scriptDir, "..", "..");
  const packageRoot = join(repoRoot, "packages", "vestibulum-cdk");
  const libDir = join(packageRoot, "lib");
  const vitestConfigPath = join(packageRoot, "vitest.config.ts");

  // Dynamically import the vitest config (tsx makes .ts importable).
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const configModule = await import(vitestConfigPath);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const coverage = configModule.default?.test?.coverage as {
    include?: string[];
    exclude?: string[];
  };

  const includeGlobs: string[] = coverage?.include ?? [];
  const excludeGlobs: string[] = coverage?.exclude ?? [];

  if (includeGlobs.length === 0) {
    console.error(
      "[check-coverage-include] ERROR: No coverage.include globs found in vitest.config.ts — " +
        "cannot validate. Is the config path correct?",
    );
    process.exit(1);
  }

  // Enumerate lib/**/*.ts and express paths relative to the package root
  // (e.g. "lib/aspects/foo.ts") — same form as the include globs.
  const absFiles = walkDir(libDir).filter((f) => f.endsWith(".ts"));
  const relFiles = absFiles.map((f) => relative(packageRoot, f));

  const uncovered = findUncoveredConstructs(relFiles, includeGlobs, excludeGlobs);

  if (uncovered.length === 0) {
    console.log(
      "[check-coverage-include] OK — all behaviour-bearing lib files are in the coverage include list.",
    );
    process.exit(0);
  }

  console.error(
    `[check-coverage-include] FAIL: New construct(s) not in the vestibulum-cdk coverage include list:\n` +
      uncovered.map((f) => `  ${f}`).join("\n") +
      `\n\nAdd them to packages/vestibulum-cdk/vitest.config.ts coverage.include,` +
      ` or add a test-exclusion comment explaining why they are intentionally omitted.`,
  );
  process.exit(1);
}

// Only run main() when invoked as a CLI entry point.
// Wrap in a void IIFE so we avoid top-level await (CJS compat under tsx).
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("check-coverage-include.ts") === true;

if (isMainModule) {
  void main();
}
