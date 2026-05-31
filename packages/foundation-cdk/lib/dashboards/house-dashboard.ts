import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import { Construct } from "constructs";
import { TEMPLATE_CONTRACTS, type VariableContract } from "./contracts.js";
import type { HouseDashboardName, HouseDashboardParams } from "./types.js";

/** Regex matching any substitution placeholder in a template. */
const PLACEHOLDER_RE = /\$\{([A-Z0-9_]+)\}/g;

/**
 * Read the raw template JSON from disk (bundled in dist/dashboards/templates/).
 * Returns the raw string — no substitution applied.
 */
function loadTemplate(name: HouseDashboardName): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const templatePath = path.join(dir, "templates", `${name}.json`);
  return fs.readFileSync(templatePath, "utf-8");
}

/**
 * Remove all JSON objects `{ ... }` in the body that contain the given
 * placeholder string, along with surrounding commas so the parent
 * array or object remains valid.
 *
 * This is a best-effort string operation: it finds the placeholder, walks
 * backward to the opening `{`, forward to the matching `}`, removes the
 * object, then cleans up the comma that would leave the enclosing collection
 * malformed.
 */
function removeEnclosingObject(body: string, placeholder: string): string {
  let result = body;
  // Keep removing while the placeholder still exists (handle multiple occurrences)
  let safety = 0;
  while (result.includes(placeholder) && safety < 100) {
    safety++;
    const idx = result.indexOf(placeholder);

    // Walk backward to find the opening `{` — skip nested braces
    let depth = 0;
    let start = -1;
    for (let i = idx - 1; i >= 0; i--) {
      const ch = result[i];
      if (ch === "}") {
        depth++;
      } else if (ch === "{") {
        if (depth === 0) {
          start = i;
          break;
        }
        depth--;
      }
    }

    if (start === -1) break; // safety: no enclosing object found

    // Walk forward to find the matching `}` from `start`
    depth = 0;
    let end = -1;
    for (let i = start; i < result.length; i++) {
      const ch = result[i];
      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    if (end === -1) break; // safety

    // Determine removal range including surrounding comma + whitespace
    // Strategy: prefer to remove trailing ", " (more common in arrays);
    // fall back to removing preceding ", " when at end of array.
    let removeStart = start;
    let removeEnd = end + 1;

    // Try trailing: look for whitespace then comma after the object
    const afterSlice = result.slice(removeEnd);
    const trailingMatch = afterSlice.match(/^(\s*,\s*)/);
    const trailingGroup = trailingMatch?.[1];
    if (trailingGroup !== undefined) {
      removeEnd += trailingGroup.length;
    } else {
      // Try leading: look for comma then optional whitespace before the object
      const beforeSlice = result.slice(0, removeStart);
      const leadingMatch = beforeSlice.match(/,(\s*)$/);
      if (leadingMatch !== null) {
        removeStart -= leadingMatch[0].length;
      }
    }

    result = result.slice(0, removeStart) + result.slice(removeEnd);
  }
  return result;
}

/**
 * Apply variable substitution to a dashboard template body string.
 *
 * - Required variables must all be supplied; throws listing missing names.
 * - Optional variables: if absent, the enclosing JSON object is removed.
 * - Every value is JSON-string-escaped so substituted values cannot break
 *   out of their JSON string context.
 * - Validates that no ${...} placeholders remain after substitution (typo guard).
 * - Validates that the output is parseable JSON.
 */
export function substitute(
  body: string,
  variables: Readonly<Record<string, string>>,
  contract: VariableContract,
): string {
  // 1. Validate required variables
  const missing = contract.required.filter((name) => !(name in variables));
  if (missing.length > 0) {
    throw new Error(`houseDashboard: missing required variable(s): ${missing.join(", ")}`);
  }

  let result = body;

  // 2. Remove widgets for absent optional variables first
  for (const name of contract.optional) {
    if (!(name in variables)) {
      const placeholder = `\${${name}}`;
      result = removeEnclosingObject(result, placeholder);
    }
  }

  // 3. Substitute all supplied variables (required + supplied optional)
  for (const [name, value] of Object.entries(variables)) {
    // JSON-string-escape: JSON.stringify wraps in double quotes; slice removes them.
    // Then additionally escape `${` to `${` so that a value like "${FOO}"
    // does not look like an unresolved template placeholder in the post-substitution check.
    // `$` === `$` so the parsed JSON string value is preserved exactly.
    const jsonEscaped = JSON.stringify(value).slice(1, -1);
    const escaped = jsonEscaped.replaceAll("${", "\\u0024{");
    const placeholder = `\${${name}}`;
    result = result.replaceAll(placeholder, escaped);
  }

  // 4. Reject any remaining ${...} patterns (template typo or undeclared variable)
  const remaining = result.match(PLACEHOLDER_RE);
  if (remaining !== null) {
    const unique = [...new Set(remaining)];
    throw new Error(
      `houseDashboard: unresolved placeholder(s) after substitution: ${unique.join(", ")}. ` +
        `Check for typos in the template or missing contract entries.`,
    );
  }

  // 5. Confirm structural validity
  try {
    JSON.parse(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`houseDashboard: substituted template is not valid JSON: ${msg}`);
  }

  return result;
}

/**
 * Create a CloudWatch dashboard from a named house template.
 *
 * Throws at synth time if the template name is unknown or required
 * variables are missing.
 */
export function houseDashboard(
  scope: Construct,
  id: string,
  template: HouseDashboardName,
  params: HouseDashboardParams,
): cloudwatch.CfnDashboard {
  const body = readHouseTemplate(template, params);
  return new cloudwatch.CfnDashboard(scope, id, {
    dashboardName: params.dashboardName,
    dashboardBody: body,
  });
}

/**
 * Render a house template to a substituted JSON string without creating
 * a CDK resource. Useful for post-processing (appending custom widgets)
 * before creating the CfnDashboard manually.
 */
export function readHouseTemplate(
  template: HouseDashboardName,
  params: HouseDashboardParams,
): string {
  const contract = TEMPLATE_CONTRACTS[template];
  const rawBody = loadTemplate(template);

  // If a region override is provided, merge it into variables
  const effectiveVars: Record<string, string> = { ...params.variables };
  if (params.region !== undefined && !("REGION" in effectiveVars)) {
    effectiveVars["REGION"] = params.region;
  }

  return substitute(rawBody, effectiveVars, contract);
}

/**
 * List available house dashboard template names.
 */
export function listHouseDashboards(): HouseDashboardName[] {
  return ["api-health", "database", "workers"];
}
