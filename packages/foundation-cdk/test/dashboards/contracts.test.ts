/**
 * Contracts consistency test.
 *
 * Every shipped template's variable contract must be consistent with
 * the actual template content:
 *   - No ${VAR} in the template that isn't listed in contract.required ∪ contract.optional
 *   - No contract entry (required or optional) that isn't referenced in the template
 */

import { describe, it, expect } from "vitest";
import { TEMPLATE_CONTRACTS } from "../../lib/dashboards/contracts.js";
import { listHouseDashboards } from "../../lib/dashboards/index.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const TEMPLATES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../lib/dashboards/templates",
);

const PLACEHOLDER_RE = /\$\{([A-Z0-9_]+)\}/g;

function extractPlaceholders(content: string): Set<string> {
  const found = new Set<string>();
  for (const match of content.matchAll(PLACEHOLDER_RE)) {
    if (match[1] !== undefined) {
      found.add(match[1]);
    }
  }
  return found;
}

describe("template contracts consistency", () => {
  const names = listHouseDashboards();

  for (const name of names) {
    describe(`${name} template`, () => {
      const templatePath = path.join(TEMPLATES_DIR, `${name}.json`);
      const content = fs.readFileSync(templatePath, "utf-8");
      const placeholders = extractPlaceholders(content);
      const contract = TEMPLATE_CONTRACTS[name];

      it("template file exists and is valid JSON", () => {
        expect(() => JSON.parse(content) as unknown).not.toThrow();
      });

      it("all template placeholders are covered by the contract", () => {
        const contractVars = new Set([...contract.required, ...contract.optional]);
        for (const placeholder of placeholders) {
          expect(contractVars.has(placeholder)).toBe(true);
        }
      });

      it("all contract entries are referenced in the template", () => {
        const allContractVars = [...contract.required, ...contract.optional];
        for (const variable of allContractVars) {
          expect(placeholders.has(variable)).toBe(true);
        }
      });

      it("contract has no duplicate entries", () => {
        const allVars = [...contract.required, ...contract.optional];
        const unique = new Set(allVars);
        expect(allVars.length).toBe(unique.size);
      });
    });
  }
});
