/**
 * CI gate: verify the ESLint rule that quarantines `@prisma/client`
 * imports in `src/feature-toggles/` actually fires on the fixture file.
 *
 * The fixture lives at
 * `test/eslint-fixtures/feature-toggles-prisma-leak.fixture.ts` and is
 * excluded from the normal lint pass via `ignorePatterns`. This test
 * invokes eslint on it explicitly (`--no-ignore`) and asserts the
 * rule error appears in the output.
 *
 * The rule lives in `.eslintrc.cjs` under the
 * `packages/foundation/src/feature-toggles/**` override.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const fixturePath = resolve(
  repoRoot,
  "packages/foundation/test/eslint-fixtures/feature-toggles-prisma-leak.fixture.ts",
);

describe("feature-toggles/prisma quarantine: ESLint fixture", () => {
  it("eslint reports a no-restricted-imports violation on the fixture", () => {
    const result = spawnSync("npx", ["eslint", "--no-ignore", "--format", "json", fixturePath], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 60_000,
    });

    const stdout = result.stdout || "";
    expect(stdout).not.toBe("");

    interface EslintResult {
      filePath: string;
      messages: Array<{ ruleId: string | null; message: string }>;
    }
    const parsed: ReadonlyArray<EslintResult> = JSON.parse(stdout) as EslintResult[];
    expect(parsed).toHaveLength(1);
    const messages = parsed[0]!.messages;
    const hasRestrictedImport = messages.some(
      (m) => m.ruleId === "no-restricted-imports" && /@prisma\/client/.test(m.message),
    );
    expect(hasRestrictedImport).toBe(true);
    // Spawning type-aware ESLint over the full program is slow (~4-5s);
    // give the test the same budget the spawnSync call already allows so it
    // doesn't hit vitest's 5s default under parallel load.
  }, 60_000);
});
