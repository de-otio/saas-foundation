#!/usr/bin/env node
/**
 * CI gate: check-unsorted-toequal
 *
 * Flags equality assertions applied directly to unordered iterables in
 * test files under packages/<pkg>/test/<subdir>/*.test.ts.
 *
 * WHAT IS FLAGGED (conservative — false positives kept near zero):
 *
 *   1. Subject is an unordered Object method call — i.e. the expression
 *      passed directly to expect() is one of:
 *        Object.keys(x)   Object.values(x)   Object.entries(x)
 *      and the assertion is .toEqual(...) or .toStrictEqual(...).
 *      Note: expect(Object.keys(x).sort()).toEqual([...]) is NOT flagged
 *      because .sort() is chained before the assertion chain.
 *
 *   2. The expected/actual value (left side of toEqual argument) is a
 *      spread of a Map or Set iterator:
 *        [...x.keys()]   [...x.values()]   [...someSet]   [...someMap]
 *      where the spread target is a Set/Map variable (heuristic: name
 *      contains "set" or "map", case-insensitive) or an explicit
 *      x.keys() / x.values() call.
 *
 * WHAT IS NOT FLAGGED:
 *
 *   - expect(Object.keys(x).sort()).toEqual([...])  — sorted before compare
 *   - expect(someArbitraryArray).toEqual([...])     — no data-flow analysis
 *   - [...sortedResults]                            — no data-flow analysis
 *
 * ESCAPE HATCH:
 *   Add the comment `// sorted-ok` on the same line as the assertion, or
 *   on the line immediately above it, to suppress a finding.
 *
 * Usage (from CI):
 *   npx tsx scripts/ci/check-unsorted-toequal.ts
 *
 * See doc/02-monorepo-layout.md § Determinism rules and
 * doc/test-strategy/01-principles.md P2.4 for the policy this gate enforces.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** A single flagged location. */
export interface Finding {
  readonly filePath: string;
  readonly line: number;
  readonly text: string;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/**
 * Matches `expect(Object.keys(...))`, `expect(Object.values(...))`,
 * `expect(Object.entries(...))` — the unordered-iterable expression is the
 * direct argument to expect(), with no intermediate method call.
 *
 * A chained `.sort()` (e.g. `expect(Object.keys(x).sort())`) is NOT matched
 * because `.sort` appears between the Object method and the closing paren.
 */
const OBJECT_KEYS_SUBJECT_RE =
  /\bexpect\s*\(\s*Object\.(keys|values|entries)\s*\([^)]*\)\s*\)\s*\.(toEqual|toStrictEqual)\b/;

/**
 * Matches spread of a Map/Set iterator in the expected-value position of
 * toEqual([...]) or toStrictEqual([...]).
 *
 * Flagged patterns:
 *   [...x.keys()]
 *   [...x.values()]
 *   [...someSet]      (name contains "set", case-insensitive)
 *   [...someMap]      (name contains "map", case-insensitive)
 *   Array.from(someSet)  (name contains "set")
 *   Array.from(someMap)  (name contains "map")
 *
 * This is intentionally narrow — arbitrary spread variables are not flagged.
 */
const SPREAD_SET_MAP_RE =
  /\[\s*\.\.\.\s*(?:[a-zA-Z_$][\w$]*\.(keys|values)\s*\(\s*\)|(?:[a-zA-Z_$]*(?:set|map|Set|Map)[a-zA-Z_$0-9]*)\b)\s*\]/;

const ARRAY_FROM_SET_MAP_RE =
  /\bArray\.from\s*\(\s*(?:[a-zA-Z_$]*(?:set|map|Set|Map)[a-zA-Z_$0-9]*)\b/;

/** Comment on the same line or the line immediately above. */
const ESCAPE_HATCH = "sorted-ok";

// ---------------------------------------------------------------------------
// Pure gate logic
// ---------------------------------------------------------------------------

/**
 * Scan a single file's text and return all unsorted-toEqual findings.
 *
 * Exported for unit testing — the CLI wires this to the real filesystem;
 * tests call it with synthetic snippets.
 */
export function findUnsortedAssertions(
  fileText: string,
  filePath: string,
): Finding[] {
  const lines = fileText.split("\n");
  const findings: Finding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const prevLine = i > 0 ? (lines[i - 1] ?? "") : "";

    // Escape hatch: suppress if this line or the line above contains
    // the sorted-ok marker.
    if (line.includes(ESCAPE_HATCH) || prevLine.includes(ESCAPE_HATCH)) {
      continue;
    }

    // Rule 1: expect(Object.keys/values/entries(x)).toEqual/toStrictEqual
    if (OBJECT_KEYS_SUBJECT_RE.test(line)) {
      findings.push({
        filePath,
        line: i + 1,
        text: line.trim(),
        reason:
          "expect(Object.keys/values/entries(...)) asserted with toEqual/toStrictEqual — iteration order is not guaranteed; sort explicitly or use a set-equality matcher",
      });
      continue;
    }

    // Rule 2: spread of Map/Set iterator in expected value
    if (
      (SPREAD_SET_MAP_RE.test(line) || ARRAY_FROM_SET_MAP_RE.test(line)) &&
      /\.(toEqual|toStrictEqual)\s*\(/.test(line)
    ) {
      findings.push({
        filePath,
        line: i + 1,
        text: line.trim(),
        reason:
          "toEqual/toStrictEqual applied to a spread of a Map/Set iterator — iteration order is not guaranteed; sort explicitly or use a set-equality matcher",
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// CLI: filesystem walk
// ---------------------------------------------------------------------------

function walkTestFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      results.push(...walkTestFiles(full));
    } else if (entry.endsWith(".test.ts")) {
      results.push(full);
    }
  }
  return results;
}

function main(): void {
  const root = process.cwd();
  const packagesDir = join(root, "packages");

  // Collect packages/*/test/**/*.test.ts
  let packageDirs: string[];
  try {
    packageDirs = readdirSync(packagesDir);
  } catch (err) {
    console.error("[check-unsorted-toequal] Cannot read packages/:", err);
    process.exit(1);
  }

  const testFiles: string[] = [];
  for (const pkg of packageDirs) {
    const testDir = join(packagesDir, pkg, "test");
    testFiles.push(...walkTestFiles(testDir));
  }

  const allFindings: Finding[] = [];

  for (const filePath of testFiles) {
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const findings = findUnsortedAssertions(text, filePath);
    allFindings.push(...findings);
  }

  if (allFindings.length === 0) {
    console.log(
      "[check-unsorted-toequal] OK — no unsorted-iterable equality assertions found.",
    );
    process.exit(0);
  }

  console.error(
    "[check-unsorted-toequal] FAIL: equality assertions on unordered iterables detected.\n",
  );
  for (const f of allFindings) {
    console.error(`  ${f.filePath}:${f.line}`);
    console.error(`    ${f.text}`);
    console.error(`    → ${f.reason}\n`);
  }
  console.error(
    "Fix: sort before comparing (e.g. .sort()), use expect.arrayContaining(),\n" +
      "or add a `// sorted-ok` comment if the order is guaranteed by other means.",
  );
  process.exit(1);
}

// Only run main() when invoked as a CLI entry point.
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("check-unsorted-toequal.ts") === true;

if (isMainModule) {
  main();
}
