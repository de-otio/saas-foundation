/**
 * CI gate: verify the ESLint rule that quarantines `@prisma/client`
 * imports actually fires on the fixture file. The fixture lives at
 * `test/eslint-fixtures/audit-prisma-leak.fixture.ts` and is excluded
 * from the normal lint pass via `ignorePatterns`. This test invokes
 * eslint on it explicitly (`--no-ignore`) and asserts the rule error
 * appears in the output.
 *
 * The rule lives in `.eslintrc.cjs` under the
 * `packages/foundation/src/audit/**` override (plus an explicit match
 * for the fixture path).
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const fixturePath = resolve(
  repoRoot,
  "packages/foundation/test/eslint-fixtures/audit-prisma-leak.fixture.ts",
);

describe("audit/prisma quarantine: ESLint fixture", () => {
  it("eslint reports a no-restricted-imports violation on the fixture", () => {
    const result = spawnSync("npx", ["eslint", "--no-ignore", "--format", "json", fixturePath], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 60_000,
    });

    // eslint exits with code 1 when violations are found. We assert on
    // the JSON output content rather than the exit code so a future
    // eslint behaviour change doesn't make the test brittle.
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
  });
});
