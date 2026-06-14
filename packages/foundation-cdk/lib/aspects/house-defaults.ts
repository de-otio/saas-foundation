import { Annotations, IAspect } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { IConstruct } from "constructs";
import { HOUSE_CONSTRUCT_METADATA_KEY } from "./metadata-tags.js";

/**
 * Severity level for a HouseDefaultsAspect rule.
 *
 * - 'warn'  Annotations.addWarning — synth succeeds, message shown.
 * - 'error' Annotations.addError   — synth fails.
 * - 'off'   Rule is skipped entirely.
 */
export type RuleSeverity = "warn" | "error" | "off";

export interface HouseDefaultsAspectProps {
  /**
   * Severity for raw-Lambda violations (any lambda.Function not created via
   * NodejsLambda, detected by absence of the house-construct metadata tag).
   * @default 'warn'
   */
  readonly rawLambda?: RuleSeverity;

  /**
   * Severity for raw-Table violations (any dynamodb.Table not created via
   * SingleTable, detected by absence of the house-construct metadata tag).
   * @default 'warn'
   */
  readonly rawTable?: RuleSeverity;

  /**
   * Severity for raw-Queue violations (any sqs.Queue with no deadLetterQueue
   * configured, regardless of whether QueueWithDlq created it).
   * @default 'warn'
   */
  readonly rawQueue?: RuleSeverity;

  /**
   * Construct paths or path-prefix patterns for which every rule is silenced.
   * Path matching uses string-prefix semantics: a value of "MyApp/Ephemeral"
   * exempts any node whose path starts with that string.
   */
  readonly exempt?: readonly string[];
}

/**
 * CDK Aspect that detects raw aws-cdk-lib resources in contexts where
 * foundation-cdk wrapper constructs should be used.
 *
 * Apply to the CDK App (or a subtree) during synthesis:
 *
 * ```typescript
 * import * as cdk from 'aws-cdk-lib';
 * import { HouseDefaultsAspect } from '@de-otio/saas-foundation-cdk/aspects';
 *
 * cdk.Aspects.of(app).add(new HouseDefaultsAspect());
 * ```
 */
export class HouseDefaultsAspect implements IAspect {
  private readonly rawLambda: RuleSeverity;
  private readonly rawTable: RuleSeverity;
  private readonly rawQueue: RuleSeverity;
  private readonly exempt: readonly string[];

  constructor(props?: HouseDefaultsAspectProps) {
    this.rawLambda = props?.rawLambda ?? "warn";
    this.rawTable = props?.rawTable ?? "warn";
    this.rawQueue = props?.rawQueue ?? "warn";
    this.exempt = props?.exempt ?? [];
  }

  visit(node: IConstruct): void {
    if (this.isExempt(node)) {
      return;
    }

    if (node instanceof lambda.Function || node instanceof lambda.CfnFunction) {
      this.checkRawLambda(node);
    } else if (node instanceof dynamodb.Table || node instanceof dynamodb.CfnTable) {
      this.checkRawTable(node);
    } else if (node instanceof sqs.Queue) {
      this.checkRawQueue(node);
    }
  }

  private isExempt(node: IConstruct): boolean {
    const path = node.node.path;
    return this.exempt.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  }

  private hasHouseTag(node: IConstruct): boolean {
    return node.node.metadata.some((m) => m.type === HOUSE_CONSTRUCT_METADATA_KEY);
  }

  /**
   * Walk up the construct tree to check if any ancestor carries the
   * house-construct tag. This handles the case where the tag is set on
   * the L2 wrapper but the visitor encounters the L2 Function directly.
   */
  private hasHouseTagInAncestors(node: IConstruct): boolean {
    let current: IConstruct | undefined = node;
    while (current !== undefined) {
      if (this.hasHouseTag(current)) {
        return true;
      }
      current = current.node.scope;
    }
    return false;
  }

  private checkRawLambda(node: IConstruct): void {
    if (this.rawLambda === "off") {
      return;
    }
    if (this.hasHouseTagInAncestors(node)) {
      return;
    }
    const path = node.node.path;
    const message =
      `Lambda function at ${path} bypasses NodejsLambda; ARM64, X-Ray, log retention, ` +
      `and alarm defaults are not applied. Use NodejsLambda, or add "${path}" to the exempt list.`;
    this.emit(node, message, this.rawLambda);
  }

  private checkRawTable(node: IConstruct): void {
    if (this.rawTable === "off") {
      return;
    }
    if (this.hasHouseTagInAncestors(node)) {
      return;
    }
    const path = node.node.path;
    const message =
      `DynamoDB table at ${path} bypasses SingleTable; PITR, TTL, ` +
      `and spike alarms are not applied. Use SingleTable, or add "${path}" to the exempt list.`;
    this.emit(node, message, this.rawTable);
  }

  private checkRawQueue(node: IConstruct): void {
    if (this.rawQueue === "off") {
      return;
    }
    // The queue check is DLQ-presence, not metadata-tag based.
    // A consumer who builds their own queue+DLQ pair manually still satisfies
    // the intent; the check is the missing DLQ.
    const queue = node as sqs.Queue;
    if (queue.deadLetterQueue !== undefined) {
      return;
    }
    const path = node.node.path;
    const message =
      `SQS queue at ${path} has no DLQ. Failed messages will be lost after maxReceiveCount. ` +
      `Use QueueWithDlq, or attach a DLQ manually, or add "${path}" to the exempt list.`;
    this.emit(node, message, this.rawQueue);
  }

  private emit(node: IConstruct, message: string, severity: RuleSeverity): void {
    if (severity === "error") {
      Annotations.of(node).addError(message);
    } else {
      Annotations.of(node).addWarning(message);
    }
  }
}
