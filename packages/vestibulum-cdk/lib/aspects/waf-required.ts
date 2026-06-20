import { IAspect, Token } from "aws-cdk-lib";
import { CfnDistribution } from "aws-cdk-lib/aws-cloudfront";
import { IConstruct } from "constructs";
import { isInsideVestibulumSubtree } from "./subtree-marker.js";

/**
 * Construct-metadata `type` marking a `CfnDistribution` whose missing
 * `WebACLId` is a deliberate opt-out (via `EdgeResources.enableWebAcl:
 * false`), not an accidental omission. {@link WafRequiredAspect} skips
 * any distribution carrying this marker.
 */
export const VESTIBULUM_WAF_OPT_OUT_MARKER_TYPE = "vestibulum:waf-opt-out";

/**
 * Marks a `CfnDistribution` (or the L2 `Distribution` wrapping it) as
 * intentionally WAF-less. Called by `MagicLinkAuthSite` when the
 * supplied `edge.webAcl` is `undefined` so the build-time
 * {@link WafRequiredAspect} tolerates the opt-out instead of failing.
 */
export function markWafIntentionallyDisabled(scope: IConstruct): void {
  scope.node.addMetadata(VESTIBULUM_WAF_OPT_OUT_MARKER_TYPE, true, {
    stackTrace: false,
  });
}

/**
 * Returns `true` when `node` (inclusive of its scopes) carries the
 * WAF opt-out marker.
 */
function isWafIntentionallyDisabled(node: IConstruct): boolean {
  for (const scope of node.node.scopes) {
    for (const entry of scope.node.metadata) {
      if (entry.type === VESTIBULUM_WAF_OPT_OUT_MARKER_TYPE) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Synth-time CDK Aspect that fails the build when a CloudFront
 * `Distribution` inside a Vestibulum subtree is missing a Web ACL.
 *
 * The magic-link auth endpoint is a public-facing HTTP API that an attacker
 * can hit with credential-stuffing or enumeration traffic. Synthesising a
 * distribution without `WebACLId` routes that traffic straight to the auth
 * Lambda, which is precisely what the WAF prevents.
 *
 * Scope: inert outside a Vestibulum subtree, and inert for distributions
 * explicitly marked WAF-less via {@link markWafIntentionallyDisabled}
 * (the `EdgeResources.enableWebAcl: false` opt-out).
 */
export class WafRequiredAspect implements IAspect {
  public visit(node: IConstruct): void {
    if (!(node instanceof CfnDistribution)) {
      return;
    }
    if (!isInsideVestibulumSubtree(node)) {
      return;
    }
    if (isWafIntentionallyDisabled(node)) {
      // Deliberate opt-out via EdgeResources.enableWebAcl: false.
      return;
    }

    const config = node.distributionConfig as
      | CfnDistribution.DistributionConfigProperty
      | undefined;

    if (config === undefined || Token.isUnresolved(config)) {
      // Nothing to check at this level — let CloudFormation enforce.
      return;
    }

    const webAclId = config.webAclId;
    if (
      webAclId === undefined ||
      webAclId === null ||
      (typeof webAclId === "string" && webAclId.length === 0)
    ) {
      throw new Error(
        `[vestibulum:WafRequiredAspect] CfnDistribution at ` +
          `'${node.node.path}' has no WebACLId. Every Vestibulum-managed ` +
          `auth site MUST be fronted by a WAFv2 Web ACL — the magic-link ` +
          `endpoint is a public auth API targeted by credential-stuffing ` +
          `traffic. Attach EdgeResources which wires the default WAF.`,
      );
    }
  }
}
