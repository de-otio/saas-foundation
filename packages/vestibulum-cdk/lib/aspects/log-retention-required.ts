import { IAspect, Stack } from "aws-cdk-lib";
import { CfnFunction } from "aws-cdk-lib/aws-lambda";
import { CfnLogGroup } from "aws-cdk-lib/aws-logs";
import { IConstruct } from "constructs";
import { isInsideVestibulumSubtree } from "./subtree-marker.js";

/**
 * The retention floor for regional Lambda handlers, in days.
 *
 * 30 days is a sensible operational floor — long enough for forensic
 * investigation, short enough that retained PII does not accumulate
 * indefinitely.
 */
const REGIONAL_RETENTION_FLOOR_DAYS = 30;

/**
 * Maximum allowed retention for Lambda@Edge log groups, in days.
 *
 * Lambda@Edge runs in every CloudFront edge region. Even though the
 * bundled edge code never calls `console.*` and the edge role has no
 * `logs:PutLogEvents`, CDK auto-creates log groups eagerly. If any log
 * line slips through, it must vanish within 24 hours.
 */
const EDGE_RETENTION_MAX_DAYS = 1;

/**
 * Synth-time CDK Aspect that fails the build when a Lambda function
 * under a Vestibulum subtree has a log group without an explicit
 * `RetentionInDays`.
 *
 * Checks:
 * - The retention is set (not undefined).
 * - For edge function log groups, retention must be exactly 1 day.
 * - For regional Vestibulum log groups, retention must be at least 30 days.
 *
 * Scope: inert outside a Vestibulum subtree.
 */
export class LogRetentionRequiredAspect implements IAspect {
  public visit(node: IConstruct): void {
    if (!isInsideVestibulumSubtree(node)) {
      return;
    }

    if (node instanceof CfnLogGroup) {
      this.checkLogGroup(node);
      return;
    }

    if (node instanceof CfnFunction) {
      this.checkFunctionHasLogGroup(node);
    }
  }

  private checkLogGroup(logGroup: CfnLogGroup): void {
    const retention = logGroup.retentionInDays;
    if (retention === undefined) {
      throw new Error(
        `[vestibulum:LogRetentionRequiredAspect] CfnLogGroup at ` +
          `'${logGroup.node.path}' has no RetentionInDays. Every ` +
          `Vestibulum-owned log group must declare retention explicitly ` +
          `(${EDGE_RETENTION_MAX_DAYS} day for edge functions, at least ` +
          `${REGIONAL_RETENTION_FLOOR_DAYS} days for regional handlers).`,
      );
    }

    const isEdge = isEdgeLogGroup(logGroup);

    if (isEdge && retention !== EDGE_RETENTION_MAX_DAYS) {
      throw new Error(
        `[vestibulum:LogRetentionRequiredAspect] Edge CfnLogGroup at ` +
          `'${logGroup.node.path}' has RetentionInDays=${retention}; ` +
          `must be exactly ${EDGE_RETENTION_MAX_DAYS} day. Lambda@Edge ` +
          `runs in every CloudFront region and any escaped log line ` +
          `must vanish within 24h.`,
      );
    }

    if (!isEdge && retention < REGIONAL_RETENTION_FLOOR_DAYS) {
      throw new Error(
        `[vestibulum:LogRetentionRequiredAspect] Regional CfnLogGroup at ` +
          `'${logGroup.node.path}' has RetentionInDays=${retention}; ` +
          `must be at least ${REGIONAL_RETENTION_FLOOR_DAYS}.`,
      );
    }
  }

  private checkFunctionHasLogGroup(fn: CfnFunction): void {
    const stack = Stack.of(fn);
    const cfnFunctionName = fn.functionName;

    let found = false;
    stack.node.findAll().forEach((c) => {
      if (found) return;
      if (c instanceof CfnLogGroup) {
        const lgName = c.logGroupName;
        if (typeof lgName === "string" && typeof cfnFunctionName === "string") {
          if (lgName.includes(cfnFunctionName)) {
            found = true;
          }
        } else if (lgName !== undefined) {
          // Token reference; assume it might point at this function.
          found = true;
        }
      }
    });

    if (!found) {
      throw new Error(
        `[vestibulum:LogRetentionRequiredAspect] CfnFunction at ` +
          `'${fn.node.path}' has no paired CfnLogGroup in the stack. ` +
          `CDK's implicit log group has no retention, which would let ` +
          `Lambda logs accumulate indefinitely. Pass an explicit logGroup ` +
          `with retention set on the LambdaFunction props.`,
      );
    }
  }
}

/**
 * Heuristic for whether a log group belongs to a Lambda@Edge function.
 */
function isEdgeLogGroup(logGroup: CfnLogGroup): boolean {
  const path = logGroup.node.path.toLowerCase();
  if (path.includes("edge") || path.includes("checkauth")) {
    return true;
  }
  const name = logGroup.logGroupName;
  if (typeof name === "string" && name.includes("us-east-1.")) {
    return true;
  }
  return false;
}
