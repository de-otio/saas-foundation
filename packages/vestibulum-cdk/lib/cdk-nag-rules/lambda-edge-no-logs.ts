/*
 * Custom cdk-nag rule: a Lambda@Edge function's execution role must NOT
 * grant any CloudWatch Logs action. Lambda@Edge runs in every CloudFront
 * region; emitting logs would write user data to regions outside the
 * consumer's data-residency boundary.
 */
import { CfnResource, Stack } from "aws-cdk-lib";
import { CfnFunction } from "aws-cdk-lib/aws-lambda";
import { CfnPolicy, CfnRole, CfnManagedPolicy } from "aws-cdk-lib/aws-iam";
import { NagRuleCompliance } from "cdk-nag";

/**
 * IAM actions that, on a Lambda@Edge role, indicate the function is
 * permitted to write logs to CloudWatch.
 */
const FORBIDDEN_LOG_ACTIONS = [
  "logs:*",
  "logs:PutLogEvents",
  "logs:CreateLogGroup",
  "logs:CreateLogStream",
];

interface StatementShape {
  Action?: string | string[];
  Effect?: string;
}

interface PolicyDocumentShape {
  Statement?: StatementShape | StatementShape[];
}

function policyDocumentGrantsLogActions(doc: unknown): boolean {
  if (doc === null || typeof doc !== "object") {
    return false;
  }
  const statements = (doc as PolicyDocumentShape).Statement;
  if (statements === undefined) {
    return false;
  }
  const arr = Array.isArray(statements) ? statements : [statements];
  for (const stmt of arr) {
    if (stmt === null || typeof stmt !== "object") continue;
    const effect = stmt.Effect ?? "Allow";
    if (effect !== "Allow") continue;
    const actions = stmt.Action;
    if (actions === undefined) continue;
    const actionArr = Array.isArray(actions) ? actions : [actions];
    for (const a of actionArr) {
      if (typeof a === "string" && FORBIDDEN_LOG_ACTIONS.includes(a)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Heuristic for whether a CfnFunction is intended to run at the edge.
 * Identified via construct path containing 'edge' or 'checkauth'.
 */
function isEdgeFunction(node: CfnFunction): boolean {
  const path = node.node.path.toLowerCase();
  return path.includes("edge") || path.includes("checkauth");
}

function lambdaEdgeNoLogs(node: CfnResource): NagRuleCompliance {
  if (!(node instanceof CfnFunction)) {
    return NagRuleCompliance.NOT_APPLICABLE;
  }
  if (!isEdgeFunction(node)) {
    return NagRuleCompliance.NOT_APPLICABLE;
  }

  const stack = Stack.of(node);
  const fnRolePath = node.node.path;

  let nonCompliant = false;

  stack.node.findAll().forEach((c) => {
    if (nonCompliant) return;

    if (c instanceof CfnRole) {
      const sharesScope = c.node.scopes.some((s) => fnRolePath.startsWith(s.node.path + "/"));
      if (!sharesScope) return;
      const inline = c.policies;
      if (Array.isArray(inline)) {
        for (const p of inline) {
          const resolved = stack.resolve(p) as { policyDocument?: unknown } | undefined;
          if (resolved && policyDocumentGrantsLogActions(resolved.policyDocument)) {
            nonCompliant = true;
            return;
          }
        }
      }
    } else if (c instanceof CfnPolicy || c instanceof CfnManagedPolicy) {
      const sharesScope = c.node.scopes.some((s) => fnRolePath.startsWith(s.node.path + "/"));
      if (!sharesScope) return;
      const resolved = stack.resolve(c.policyDocument) as unknown;
      if (policyDocumentGrantsLogActions(resolved)) {
        nonCompliant = true;
      }
    }
  });

  return nonCompliant ? NagRuleCompliance.NON_COMPLIANT : NagRuleCompliance.COMPLIANT;
}

/**
 * The cdk-nag rule callback for "Lambda@Edge functions must not be
 * granted any CloudWatch Logs action".
 */
export const LambdaEdgeNoLogs = Object.defineProperty(lambdaEdgeNoLogs, "name", {
  value: "LambdaEdgeNoLogs",
});
