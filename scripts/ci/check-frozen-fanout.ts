#!/usr/bin/env node
/**
 * CI gate: check-frozen-fanout
 *
 * Fails if a PR changes any file under the frozen-type paths:
 *   packages/foundation/src/types/frozen/
 *   packages/vestibulum/src/types/frozen/
 *
 * …but the changeset manifest does NOT include all required dependent packages.
 *
 * Foundation-owned frozen types require changesets for:
 *   @de-otio/saas-foundation, @de-otio/vestibulum, @de-otio/vestibulum-cdk
 *
 * Vestibulum-owned frozen types require changesets for:
 *   @de-otio/vestibulum, @de-otio/vestibulum-cdk
 *
 * Usage (from CI):
 *   npx tsx scripts/ci/check-frozen-fanout.ts
 *
 * Environment variables read:
 *   GITHUB_BASE_REF - base branch for the PR (e.g. "main")
 *
 * See doc/05-versioning-and-releases.md § CI gates for the full spec.
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// `|| "main"` (not `??`): on a push event the workflow passes
// GITHUB_BASE_REF as an empty string, which `??` would NOT replace, producing
// an invalid `origin/...HEAD` ref. Treat empty the same as unset.
const BASE_BRANCH = process.env["GITHUB_BASE_REF"] || "main";

/**
 * Frozen-type watch paths and their required changeset fanout.
 *
 * Exported so the unit test can pin the rule set without re-deriving it.
 */
export interface FrozenRule {
  readonly watchPath: RegExp;
  readonly requiredPackages: ReadonlyArray<string>;
}

export const FROZEN_RULES: ReadonlyArray<FrozenRule> = [
  {
    watchPath: /^packages\/foundation\/src\/types\/frozen\//,
    requiredPackages: [
      "@de-otio/saas-foundation",
      "@de-otio/vestibulum",
      "@de-otio/vestibulum-cdk",
    ],
  },
  {
    watchPath: /^packages\/vestibulum\/src\/types\/frozen\//,
    requiredPackages: ["@de-otio/vestibulum", "@de-otio/vestibulum-cdk"],
  },
];

function getDiffFiles(): string[] {
  // Test/fixture override: if `FROZEN_FANOUT_DIFF_FILES` is set, parse it as
  // a newline-separated list. Lets the acceptance suite drive the CLI
  // form without needing a real `origin/main` ref.
  const override = process.env["FROZEN_FANOUT_DIFF_FILES"];
  if (override !== undefined) {
    return override.split("\n").map((s) => s.trim()).filter(Boolean);
  }
  const output = execSync(`git diff --name-only origin/${BASE_BRANCH}...HEAD`, {
    encoding: "utf8",
  });
  return output.trim().split("\n").filter(Boolean);
}

function getChangedPackages(): Set<string> {
  // Test/fixture override: if `FROZEN_FANOUT_CHANGESET_DIR` is set, read
  // that directory instead of the workspace's `.changeset/`.
  const changesetDir =
    process.env["FROZEN_FANOUT_CHANGESET_DIR"] ?? join(process.cwd(), ".changeset");
  const changed = new Set<string>();

  if (!existsSync(changesetDir)) return changed;

  const entries = readdirSync(changesetDir).filter(
    (f) => f.endsWith(".md") && f !== "README.md",
  );

  for (const entry of entries) {
    const content = readFileSync(join(changesetDir, entry), "utf8");
    // Changesets format: ---\n"@scope/pkg": patch\n---\n\nDescription
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatter?.[1]) continue;

    const lines = frontmatter[1].split("\n").filter(Boolean);
    for (const line of lines) {
      const match = line.match(/^"([^"]+)":/);
      if (match?.[1]) {
        changed.add(match[1]);
      }
    }
  }

  return changed;
}

/**
 * Pure gate logic. Given a list of changed files and a set of
 * packages with changesets, return the list of fanout failures.
 *
 * Exported for unit testing — `main()` wires this up to git + the
 * filesystem; the test calls this directly.
 */
export function evaluateFanout(
  diffFiles: ReadonlyArray<string>,
  changedPackages: ReadonlySet<string>,
  rules: ReadonlyArray<FrozenRule> = FROZEN_RULES,
): string[] {
  const failures: string[] = [];

  for (const rule of rules) {
    const frozenChanged = diffFiles.some((f) => rule.watchPath.test(f));
    if (!frozenChanged) continue;

    const missingPackages = rule.requiredPackages.filter((pkg) => !changedPackages.has(pkg));
    if (missingPackages.length > 0) {
      failures.push(
        `Frozen-type change at ${rule.watchPath.source} requires changesets for: ${missingPackages.join(", ")}`,
      );
    }
  }

  return failures;
}

function main(): void {
  let diffFiles: string[];
  try {
    diffFiles = getDiffFiles();
  } catch (err) {
    console.error("[check-frozen-fanout] Failed to get diff:", err);
    process.exit(1);
  }

  const changedPackages = getChangedPackages();
  const failures = evaluateFanout(diffFiles, changedPackages);

  if (failures.length === 0) {
    console.log("[check-frozen-fanout] OK — frozen-type fanout is complete.");
    process.exit(0);
  }

  console.error(`
[check-frozen-fanout] FAIL: Frozen-type changes detected without full fanout.

${failures.join("\n")}

A change to any frozen-set type requires a coordinated bump of every package
that imports it. Run 'npm run changeset' for each missing package.

If this change requires an RFC first, see doc/05-versioning-and-releases.md
§ RFC process for frozen types.
`);
  process.exit(1);
}

// Only run main() when invoked as a CLI entry point.
// When imported (e.g. from a test), the side-effectful main() does not fire.
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("check-frozen-fanout.ts") === true;

if (isMainModule) {
  main();
}
