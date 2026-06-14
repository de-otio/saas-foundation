import { Annotations, AspectPriority, Aspects, IAspect, Stack, Tags } from "aws-cdk-lib";
import type { IConstruct } from "constructs";
import { HOUSE_CONSTRUCT_METADATA_KEY } from "./metadata-tags.js";

/**
 * Metadata key set on a Stack by HouseTaggingAspect.visit() to record that
 * the aspect has been applied. validateHouseTaggingApplied() reads this
 * marker to decide whether to emit an error.
 */
export const HOUSE_TAGGING_APPLIED_METADATA_KEY = "de-otio:houseTaggingApplied";

/**
 * The four cost-allocation tag keys that HouseTaggingAspect emits. The
 * names follow AWS conventional PascalCase ("Environment", "Service",
 * "CostCenter", "Owner") so they line up with default cost-allocation
 * tag activation in Billing.
 */
export const HOUSE_TAGGING_KEYS = ["Environment", "Service", "CostCenter", "Owner"] as const;

export interface HouseTaggingAspectProps {
  /**
   * Deployment environment, e.g. "prod", "staging", "dev". Required.
   * Empty string emits a synth-time error.
   */
  readonly environment: string;

  /**
   * Logical service the stack belongs to, e.g. "magic-link-auth",
   * "shared-distribution". Required. Empty string emits a synth-time error.
   */
  readonly service: string;

  /**
   * Cost-centre / billing-owner identifier, e.g. "trellis-platform". The
   * value lands in the CostCenter tag and drives Cost Explorer grouping.
   * Required. Empty string emits a synth-time error.
   */
  readonly costCenter: string;

  /**
   * Team or individual responsible for the stack, e.g. "platform-team".
   * Required. Empty string emits a synth-time error.
   */
  readonly owner: string;
}

/**
 * CDK Aspect that applies the four house cost-allocation tags
 * (`Environment`, `Service`, `CostCenter`, `Owner`) to every Stack in the
 * scope it is applied to. The aspect also records a metadata marker on
 * each visited Stack so {@link validateHouseTaggingApplied} can detect
 * stacks that contain house constructs but were never tagged.
 *
 * Apply at the CDK App (or stack) root during synthesis:
 *
 * ```typescript
 * import * as cdk from 'aws-cdk-lib';
 * import { HouseTaggingAspect } from '@de-otio/saas-foundation-cdk/aspects';
 *
 * cdk.Aspects.of(app).add(new HouseTaggingAspect({
 *   environment: 'prod',
 *   service: 'magic-link-auth',
 *   costCenter: 'trellis-platform',
 *   owner: 'platform-team',
 * }));
 * ```
 *
 * Caveat (Lambda@Edge): CloudFront replicates Lambda@Edge functions into
 * regional replicas and the replicas do **not** inherit the tags from the
 * source function. This is a CloudFront limitation, not an aspect bug.
 * Lambda@Edge invocation cost therefore cannot be split by tag in Cost
 * Explorer.
 */
export class HouseTaggingAspect implements IAspect {
  private readonly props: HouseTaggingAspectProps;

  constructor(props: HouseTaggingAspectProps) {
    this.props = props;
  }

  visit(node: IConstruct): void {
    if (!Stack.isStack(node)) {
      return;
    }

    const missing = this.findMissingTagKeys();
    if (missing.length > 0) {
      Annotations.of(node).addError(
        `HouseTaggingAspect: missing required tag value(s): ${missing.join(", ")}. ` +
          `All four cost-allocation tags (Environment, Service, CostCenter, Owner) ` +
          `must be non-empty strings.`,
      );
      return;
    }

    // Record the application marker first so a later validation pass can
    // detect that the aspect did run on this stack.
    node.node.addMetadata(HOUSE_TAGGING_APPLIED_METADATA_KEY, true);

    Tags.of(node).add("Environment", this.props.environment);
    Tags.of(node).add("Service", this.props.service);
    Tags.of(node).add("CostCenter", this.props.costCenter);
    Tags.of(node).add("Owner", this.props.owner);
  }

  private findMissingTagKeys(): readonly string[] {
    const missing: string[] = [];
    if (this.props.environment === "") missing.push("environment");
    if (this.props.service === "") missing.push("service");
    if (this.props.costCenter === "") missing.push("costCenter");
    if (this.props.owner === "") missing.push("owner");
    return missing;
  }
}

/**
 * Validator Aspect that runs after {@link HouseTaggingAspect} and emits
 * an error on any Stack that contains house constructs but was not
 * tagged. Registered by {@link validateHouseTaggingApplied}; not exported
 * directly — consumers always go through the helper.
 */
class HouseTaggingValidatorAspect implements IAspect {
  visit(node: IConstruct): void {
    if (!Stack.isStack(node)) {
      return;
    }
    if (!stackContainsHouseConstruct(node)) {
      return;
    }
    if (stackHasTaggingApplied(node)) {
      return;
    }
    Annotations.of(node).addError(
      `HouseTaggingAspect not applied to stack "${node.node.path}", which ` +
        `contains house constructs. Cost-allocation tags (Environment, ` +
        `Service, CostCenter, Owner) will be absent and Cost Explorer ` +
        `cannot attribute spend. Apply HouseTaggingAspect at the app or ` +
        `stack root.`,
    );
  }
}

/**
 * Registers a synth-time validation pass on `scope`. For every Stack
 * inside `scope` that contains at least one house construct (detected via
 * the `de-otio:houseConstruct` metadata marker), the pass checks whether
 * {@link HouseTaggingAspect} has been applied. If not, synth fails with
 * a clear error pointing at the offending stack.
 *
 * Call this from the consumer's CDK app once stacks are declared:
 *
 * ```typescript
 * import * as cdk from 'aws-cdk-lib';
 * import {
 *   HouseTaggingAspect,
 *   validateHouseTaggingApplied,
 * } from '@de-otio/saas-foundation-cdk/aspects';
 *
 * const app = new cdk.App();
 * // ... declare stacks
 * cdk.Aspects.of(app).add(new HouseTaggingAspect({ ... }));
 * validateHouseTaggingApplied(app);
 * ```
 *
 * Implementation note: the validator runs as a CDK Aspect at
 * `AspectPriority.READONLY` (1000), so it fires AFTER any aspect at
 * `DEFAULT` or `MUTATING` priority — including {@link HouseTaggingAspect}
 * — has had a chance to set its application marker on each stack. This
 * closes the loophole where a consumer wires up house constructs but
 * forgets to attach the tagging aspect — without this validation, the
 * cost-allocation tags would silently be absent and Cost Explorer would
 * be unable to attribute spend.
 */
export function validateHouseTaggingApplied(scope: IConstruct): void {
  Aspects.of(scope).add(new HouseTaggingValidatorAspect(), {
    priority: AspectPriority.READONLY,
  });
}

function stackContainsHouseConstruct(stack: Stack): boolean {
  return hasDescendantWithHouseConstructMetadata(stack);
}

function hasDescendantWithHouseConstructMetadata(node: IConstruct): boolean {
  if (node.node.metadata.some((m) => m.type === HOUSE_CONSTRUCT_METADATA_KEY)) {
    return true;
  }
  for (const child of node.node.children) {
    if (hasDescendantWithHouseConstructMetadata(child)) {
      return true;
    }
  }
  return false;
}

function stackHasTaggingApplied(stack: Stack): boolean {
  return stack.node.metadata.some(
    (m) => m.type === HOUSE_TAGGING_APPLIED_METADATA_KEY,
  );
}
