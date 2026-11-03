/**
 * Shared helpers for the sign-in synth tests: IAM policy lookup per Lambda and
 * a static scan of which SDK commands a handler's source sends.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { Template } from "aws-cdk-lib/assertions";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the runtime package's handler directory. */
export const HANDLERS_DIR = path.resolve(
  HERE,
  "../../../vestibulum/src/lambda/handlers",
);

export interface Statement {
  readonly Action: string | string[];
  readonly Effect: string;
  readonly Resource?: unknown;
  readonly Condition?: unknown;
  readonly Principal?: unknown;
}

const asArray = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

/** Logical id of the (single) Lambda whose Description contains `needle`. */
export function functionIdByDescription(template: Template, needle: string): string {
  const fns = template.findResources("AWS::Lambda::Function");
  const hits = Object.entries(fns).filter(([, r]) =>
    String((r.Properties as { Description?: string }).Description ?? "").includes(needle),
  );
  if (hits.length !== 1) throw new Error(`expected exactly one function for "${needle}", got ${hits.length}`);
  return hits[0]![0];
}

/** All IAM statements attached to a Lambda's execution role. */
export function statementsForFunction(template: Template, fnLogicalId: string): Statement[] {
  const fn = template.findResources("AWS::Lambda::Function")[fnLogicalId];
  const roleId = (fn?.Properties as { Role: { "Fn::GetAtt": string[] } }).Role["Fn::GetAtt"][0]!;
  const out: Statement[] = [];
  for (const policy of Object.values(template.findResources("AWS::IAM::Policy"))) {
    const roles = asArray((policy.Properties as { Roles: Array<{ Ref: string }> }).Roles);
    if (!roles.some((r) => r.Ref === roleId)) continue;
    out.push(
      ...asArray(
        (policy.Properties as { PolicyDocument: { Statement: Statement | Statement[] } })
          .PolicyDocument.Statement,
      ),
    );
  }
  return out;
}

/** Every distinct IAM action a Lambda is granted. */
export function actionsForFunction(template: Template, fnLogicalId: string): Set<string> {
  const actions = new Set<string>();
  for (const s of statementsForFunction(template, fnLogicalId)) {
    if (s.Effect !== "Allow") continue;
    for (const a of asArray(s.Action)) actions.add(a);
  }
  return actions;
}

/** SDK service package → IAM prefix. */
const SERVICES: Readonly<Record<string, string>> = {
  "@aws-sdk/client-cognito-identity-provider": "cognito-idp",
  "@aws-sdk/client-dynamodb": "dynamodb",
  "@aws-sdk/client-ses": "ses",
};

/**
 * The IAM actions the SOURCE of one handler directory sends, derived from
 * `new <Name>Command(` calls whose class is imported from a known SDK client.
 * Only direct calls are found; that is the point — a handler that sends a
 * command must be granted exactly that action (01-evidence #6, #14).
 */
/** Escapes every RegExp metacharacter, backslash included. */
function escapeRegExp(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
}

export function sdkActionsUsedBy(handlerDir: string): Set<string> {
  const used = new Set<string>();
  const dir = path.join(HANDLERS_DIR, handlerDir);
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    for (const [pkg, prefix] of Object.entries(SERVICES)) {
      const importRe = new RegExp(
        `import\\s*\\{([^}]*)\\}\\s*from\\s*"${escapeRegExp(pkg)}"`,
        "g",
      );
      for (const m of src.matchAll(importRe)) {
        const names = m[1]!
          .split(",")
          .map((n) => n.trim().replace(/^type\s+/, ""))
          .filter((n) => n.endsWith("Command"));
        for (const name of names) {
          if (new RegExp(`new\\s+${name}\\s*\\(`).test(src)) {
            used.add(`${prefix}:${name.replace(/Command$/, "")}`);
          }
        }
      }
    }
  }
  return used;
}
