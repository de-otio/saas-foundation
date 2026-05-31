import { IAspect, Token } from "aws-cdk-lib";
import { CfnDistribution } from "aws-cdk-lib/aws-cloudfront";
import { IConstruct } from "constructs";
import { isInsideVestibulumSubtree } from "./subtree-marker.js";

/**
 * Synth-time CDK Aspect that fails the build when a CloudFront
 * `Distribution` inside a Vestibulum subtree is missing a Web ACL.
 *
 * The magic-link auth endpoint is a public-facing HTTP API that an attacker
 * can hit with credential-stuffing or enumeration traffic. Synthesising a
 * distribution without `WebACLId` routes that traffic straight to the auth
 * Lambda, which is precisely what the WAF prevents.
 *
 * Scope: inert outside a Vestibulum subtree.
 */
export class WafRequiredAspect implements IAspect {
  public visit(node: IConstruct): void {
    if (!(node instanceof CfnDistribution)) {
      return;
    }
    if (!isInsideVestibulumSubtree(node)) {
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
