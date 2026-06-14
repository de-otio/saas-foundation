#!/usr/bin/env node
/**
 * CI gate: check-peerdep-ranges
 *
 * Fails if packages/foundation/package.json version has a MINOR bump
 * but the peerDependency ranges in vestibulum and vestibulum-cdk have
 * not been widened to accept the new version.
 *
 * Rule: if foundation bumps 0.X.0 → 0.(X+1).0, vestibulum's and
 * vestibulum-cdk's peerDependency on @de-otio/saas-foundation must
 * accept ^0.(X+1).0.
 *
 * Usage (from CI):
 *   npx tsx scripts/ci/check-peerdep-ranges.ts
 *
 * Environment variables read:
 *   GITHUB_BASE_REF - base branch for the PR (e.g. "main")
 *
 * See doc/05-versioning-and-releases.md § CI gates for the full spec.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `|| "main"` (not `??`): on a push event the workflow passes
// GITHUB_BASE_REF as an empty string, which `??` would NOT replace, producing
// an invalid `origin/...:path` ref. Treat empty the same as unset.
const BASE_BRANCH = process.env["GITHUB_BASE_REF"] || "main";

/** Workspace-internal package names that are tracked by this gate. */
export const WORKSPACE_PACKAGES = new Set([
  "@de-otio/saas-foundation",
  "@de-otio/vestibulum",
  "@de-otio/saas-foundation-cdk",
  "@de-otio/vestibulum-cdk",
]);

export interface PackageInfo {
  name: string;
  version: string;
  peerDependencies?: Record<string, string>;
}

export interface EvaluationResult {
  ok: boolean;
  violations: string[];
}

/**
 * Derive the minor segment of a semver string (e.g. "0.3.1" → 3).
 * Exported for use in tests.
 */
export function parseMinor(version: string): number {
  const parts = version.split(".");
  return parseInt(parts[1] ?? "0", 10);
}

/**
 * Derive the minor segment from a `^0.X.Y` peer-dep range.
 * Returns -1 if the range does not match the expected pattern.
 * Exported for use in tests.
 */
export function parseMinorFromRange(range: string): number {
  // Accept ^0.X.0 or ^0.X.Y patterns
  const match = range.match(/\^0\.(\d+)\./);
  return match ? parseInt(match[1] ?? "0", 10) : -1;
}

/**
 * Pure gate logic.
 *
 * Given:
 *   - `packages`      – the current workspace package descriptors (name,
 *                       version, peerDependencies)
 *   - `foundationBaseVersion` – the foundation package's version on the base
 *                       branch (null when the file didn't exist at base, which
 *                       skips the check)
 *
 * Returns an EvaluationResult describing whether all peer-dep ranges are
 * consistent with the current foundation version.
 *
 * Policy:
 *   If foundation's MINOR has increased relative to the base branch version,
 *   every workspace package that declares a peerDependency on
 *   @de-otio/saas-foundation must use a `^0.X.Y` range whose minor segment
 *   is >= the current foundation minor. Packages without that peerDep are
 *   ignored. External (non-workspace) packages in peerDependencies are also
 *   ignored.
 *
 * Exported for unit testing — `main()` wires this up to git + the
 * filesystem; the test calls this directly.
 */
export function evaluatePeerDepRanges(
  packages: ReadonlyArray<PackageInfo>,
  foundationBaseVersion: string | null,
): EvaluationResult {
  if (foundationBaseVersion === null) {
    return { ok: true, violations: [] };
  }

  const foundation = packages.find((p) => p.name === "@de-otio/saas-foundation");
  if (!foundation) {
    return { ok: true, violations: [] };
  }

  const baseMinor = parseMinor(foundationBaseVersion);
  const currentMinor = parseMinor(foundation.version);

  if (currentMinor <= baseMinor) {
    return { ok: true, violations: [] };
  }

  const violations: string[] = [];

  for (const pkg of packages) {
    // Skip foundation itself
    if (pkg.name === "@de-otio/saas-foundation") continue;
    // Only evaluate workspace packages
    if (!WORKSPACE_PACKAGES.has(pkg.name)) continue;

    const range = pkg.peerDependencies?.["@de-otio/saas-foundation"];
    // Package doesn't declare this peer dep — nothing to check
    if (!range) continue;

    const rangeMinor = parseMinorFromRange(range);
    if (rangeMinor < currentMinor) {
      violations.push(
        `${pkg.name} peerDependency "@de-otio/saas-foundation": "${range}" does not accept 0.${currentMinor}.x. Widen to "^0.${currentMinor}.0".`,
      );
    }
  }

  return { ok: violations.length === 0, violations };
}

interface PackageJson {
  name: string;
  version: string;
  peerDependencies?: Record<string, string>;
}

function readPackageJson(pkgPath: string): PackageJson {
  return JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
}

function getVersionAtBase(filePath: string): string | null {
  try {
    const content = execSync(`git show origin/${BASE_BRANCH}:${filePath}`, {
      encoding: "utf8",
    });
    const pkg = JSON.parse(content) as PackageJson;
    return pkg.version;
  } catch {
    return null;
  }
}

function main(): void {
  const foundationPkgPath = join(process.cwd(), "packages/foundation/package.json");
  const vestibulumPkgPath = join(process.cwd(), "packages/vestibulum/package.json");
  const vestibulumCdkPkgPath = join(process.cwd(), "packages/vestibulum-cdk/package.json");

  const foundationPkg = readPackageJson(foundationPkgPath);
  const vestibulumPkg = readPackageJson(vestibulumPkgPath);
  const vestibulumCdkPkg = readPackageJson(vestibulumCdkPkgPath);

  const baseFoundationVersion = getVersionAtBase("packages/foundation/package.json");

  if (!baseFoundationVersion) {
    console.log("[check-peerdep-ranges] Could not read base foundation version — skipping check.");
    process.exit(0);
  }

  const currentMinor = parseMinor(foundationPkg.version);
  const baseMinor = parseMinor(baseFoundationVersion);

  if (currentMinor <= baseMinor) {
    console.log(
      "[check-peerdep-ranges] Foundation MINOR not bumped — no peer-dep range check required.",
    );
    process.exit(0);
  }

  console.log(
    `[check-peerdep-ranges] Foundation MINOR bumped: 0.${baseMinor}.x → 0.${currentMinor}.x. Checking peer-dep ranges.`,
  );

  const packages: PackageInfo[] = [foundationPkg, vestibulumPkg, vestibulumCdkPkg];
  const { ok, violations } = evaluatePeerDepRanges(packages, baseFoundationVersion);

  if (ok) {
    console.log("[check-peerdep-ranges] OK — peer-dep ranges accept the new foundation version.");
    process.exit(0);
  }

  console.error(`
[check-peerdep-ranges] FAIL: Foundation MINOR bumped but peer-dep ranges not widened.

${violations.join("\n")}

See doc/05-versioning-and-releases.md § Cross-package compatibility for details.
`);
  process.exit(1);
}

// Only run main() when invoked as a CLI entry point.
// When imported (e.g. from a test), the side-effectful main() does not fire.
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("check-peerdep-ranges.ts") === true;

if (isMainModule) {
  main();
}
