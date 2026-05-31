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

const BASE_BRANCH = process.env["GITHUB_BASE_REF"] ?? "main";

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

function parseMinor(version: string): number {
  const parts = version.split(".");
  return parseInt(parts[1] ?? "0", 10);
}

function parseMinorFromRange(range: string): number {
  // Accept ^0.X.0 or ^0.X.Y patterns
  const match = range.match(/\^0\.(\d+)\./);
  return match ? parseInt(match[1] ?? "0", 10) : -1;
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

  const baseMinor = parseMinor(baseFoundationVersion);
  const currentMinor = parseMinor(foundationPkg.version);

  if (currentMinor <= baseMinor) {
    console.log(
      "[check-peerdep-ranges] Foundation MINOR not bumped — no peer-dep range check required.",
    );
    process.exit(0);
  }

  console.log(
    `[check-peerdep-ranges] Foundation MINOR bumped: 0.${baseMinor}.x → 0.${currentMinor}.x. Checking peer-dep ranges.`,
  );

  const failures: string[] = [];

  // vestibulum must accept ^0.currentMinor.0
  const vestibulumRange =
    vestibulumPkg.peerDependencies?.["@de-otio/saas-foundation"] ?? "";
  const vestibulumRangeMinor = parseMinorFromRange(vestibulumRange);
  if (vestibulumRangeMinor < currentMinor) {
    failures.push(
      `@de-otio/vestibulum peerDependency "@de-otio/saas-foundation": "${vestibulumRange}" does not accept 0.${currentMinor}.x. Widen to "^0.${currentMinor}.0".`,
    );
  }

  // vestibulum-cdk must accept ^0.currentMinor.0 (if it declares the peer)
  const vestibulumCdkRange =
    vestibulumCdkPkg.peerDependencies?.["@de-otio/saas-foundation"] ?? "";
  if (vestibulumCdkRange) {
    const vestibulumCdkRangeMinor = parseMinorFromRange(vestibulumCdkRange);
    if (vestibulumCdkRangeMinor < currentMinor) {
      failures.push(
        `@de-otio/vestibulum-cdk peerDependency "@de-otio/saas-foundation": "${vestibulumCdkRange}" does not accept 0.${currentMinor}.x. Widen to "^0.${currentMinor}.0".`,
      );
    }
  }

  if (failures.length === 0) {
    console.log("[check-peerdep-ranges] OK — peer-dep ranges accept the new foundation version.");
    process.exit(0);
  }

  console.error(`
[check-peerdep-ranges] FAIL: Foundation MINOR bumped but peer-dep ranges not widened.

${failures.join("\n")}

See doc/05-versioning-and-releases.md § Cross-package compatibility for details.
`);
  process.exit(1);
}

main();
