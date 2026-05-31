#!/usr/bin/env node
/**
 * CI gate: check-changesets
 *
 * Fails if a PR modifies any packages/<name>/src/ file but contains no
 * .changeset/<name>.md entry (other than README.md and config.json).
 *
 * Bypass: include [skip changeset] in the PR title for pure refactors
 * with no observable behaviour change.
 *
 * Usage (from CI):
 *   npx tsx scripts/ci/check-changesets.ts
 *
 * Environment variables read:
 *   GITHUB_BASE_REF        - base branch for the PR (e.g. "main")
 *   PR_TITLE               - PR title (optional, used for [skip changeset] detection)
 *   CHANGESETS_DIFF_FILES  - newline-separated list of changed files (overrides git,
 *                            for tests and CI fixture use)
 *
 * See doc/05-versioning-and-releases.md § CI gates for the full spec.
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BASE_BRANCH = process.env["GITHUB_BASE_REF"] ?? "main";

export interface EvaluateChangesetsInput {
  /** Files changed in the PR (from git diff --name-only). */
  readonly changedFiles: ReadonlyArray<string>;
  /** Changeset .md filenames present (excluding README.md). */
  readonly changesetFiles: ReadonlyArray<string>;
  /** PR title (optional, used for [skip changeset] bypass). */
  readonly prTitle?: string;
}

export interface EvaluateChangesetsResult {
  readonly ok: boolean;
  /** Human-readable reason why the result is ok or not. */
  readonly reason: string;
}

/**
 * Pure gate logic. Given the changed files, existing changeset files, and
 * optional PR title, returns whether the PR passes the changeset gate.
 *
 * Exported for unit testing — `main()` wires this up to git + the
 * filesystem; the test calls this directly.
 */
export function evaluateChangesets(
  input: EvaluateChangesetsInput,
): EvaluateChangesetsResult {
  const { changedFiles, changesetFiles, prTitle = "" } = input;

  // Bypass: [skip changeset] in PR title
  if (prTitle.includes("[skip changeset]")) {
    return { ok: true, reason: "PR title contains [skip changeset]" };
  }

  // Check if any packages/*/src/ file is modified
  const sourceModified = changedFiles.some((f) => /^packages\/[^/]+\/src\//.test(f));

  if (!sourceModified) {
    return {
      ok: true,
      reason: "No packages/*/src/ changes detected — changeset not required",
    };
  }

  // Check for a changeset entry
  if (changesetFiles.length > 0) {
    return { ok: true, reason: "Changeset entry found" };
  }

  return {
    ok: false,
    reason:
      "This PR modifies source files under packages/*/src/ but contains no .changeset/*.md entry",
  };
}

function getDiffFiles(): string[] {
  // Test/fixture override: if `CHANGESETS_DIFF_FILES` is set, parse it as
  // a newline-separated list. Lets the acceptance suite drive the CLI
  // form without needing a real `origin/main` ref.
  const override = process.env["CHANGESETS_DIFF_FILES"];
  if (override !== undefined) {
    return override
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const output = execSync(`git diff --name-only origin/${BASE_BRANCH}...HEAD`, {
    encoding: "utf8",
  });
  return output.trim().split("\n").filter(Boolean);
}

function getChangesetFiles(): string[] {
  const changesetDir = join(process.cwd(), ".changeset");
  if (!existsSync(changesetDir)) return [];

  return readdirSync(changesetDir).filter(
    (f) => f.endsWith(".md") && f !== "README.md",
  );
}

function main(): void {
  const prTitle = process.env["PR_TITLE"] ?? "";

  let changedFiles: string[];
  try {
    changedFiles = getDiffFiles();
  } catch (err) {
    console.error("[check-changesets] Failed to get diff:", err);
    process.exit(1);
  }

  const changesetFiles = getChangesetFiles();
  const result = evaluateChangesets({ changedFiles, changesetFiles, prTitle });

  if (result.ok) {
    console.log(`[check-changesets] OK — ${result.reason}.`);
    process.exit(0);
  }

  console.error(`
[check-changesets] FAIL: ${result.reason}.

Run 'npm run changeset' to create one, or add [skip changeset] to the PR
title if this is a pure refactor with no observable behaviour change.

See doc/05-versioning-and-releases.md § CI gates for details.
`);
  process.exit(1);
}

// Only run main() when invoked as a CLI entry point.
// When imported (e.g. from a test), the side-effectful main() does not fire.
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("check-changesets.ts") === true;

if (isMainModule) {
  main();
}
