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
 *   GITHUB_BASE_REF   - base branch for the PR (e.g. "main")
 *   PR_TITLE          - PR title (optional, used for [skip changeset] detection)
 *
 * See doc/05-versioning-and-releases.md § CI gates for the full spec.
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BASE_BRANCH = process.env["GITHUB_BASE_REF"] ?? "main";
const PR_TITLE = process.env["PR_TITLE"] ?? "";

function getDiffFiles(): string[] {
  const output = execSync(`git diff --name-only origin/${BASE_BRANCH}...HEAD`, {
    encoding: "utf8",
  });
  return output.trim().split("\n").filter(Boolean);
}

function hasChangesetEntry(): boolean {
  const changesetDir = join(process.cwd(), ".changeset");
  if (!existsSync(changesetDir)) return false;

  const entries = readdirSync(changesetDir).filter(
    (f) => f.endsWith(".md") && f !== "README.md",
  );
  return entries.length > 0;
}

function main(): void {
  // Bypass: [skip changeset] in PR title
  if (PR_TITLE.includes("[skip changeset]")) {
    console.log("[check-changesets] Skipping: PR title contains [skip changeset]");
    process.exit(0);
  }

  let diffFiles: string[];
  try {
    diffFiles = getDiffFiles();
  } catch (err) {
    console.error("[check-changesets] Failed to get diff:", err);
    process.exit(1);
  }

  // Check if any packages/*/src/ file is modified
  const sourceModified = diffFiles.some((f) => /^packages\/[^/]+\/src\//.test(f));

  if (!sourceModified) {
    console.log(
      "[check-changesets] No packages/*/src/ changes detected — changeset not required.",
    );
    process.exit(0);
  }

  // Check for a changeset entry
  if (hasChangesetEntry()) {
    console.log("[check-changesets] Changeset entry found — OK.");
    process.exit(0);
  }

  console.error(`
[check-changesets] FAIL: This PR modifies source files under packages/*/src/
but contains no .changeset/*.md entry.

Run 'npm run changeset' to create one, or add [skip changeset] to the PR
title if this is a pure refactor with no observable behaviour change.

See doc/05-versioning-and-releases.md § CI gates for details.
`);
  process.exit(1);
}

main();
