import type * as acm from "aws-cdk-lib/aws-certificatemanager";
import type * as wafv2 from "aws-cdk-lib/aws-wafv2";

/**
 * Read-only interface that `EdgeResources` exposes to downstream constructs.
 *
 * `MagicLinkAuthSite` consumes this interface when wiring up the CloudFront
 * distribution. Consumers who need a hand-rolled cert or Web ACL (e.g. a
 * cert shared across multiple distributions) implement this interface
 * directly and pass the instance into `MagicLinkAuthSite` as `edge`.
 *
 * Both resources this interface exposes MUST exist in us-east-1:
 * - CloudFront ACM certificates are us-east-1 only.
 * - WAFv2 in `CLOUDFRONT` scope is us-east-1 only.
 */
export interface IEdgeResources {
  /**
   * The ACM certificate for the CloudFront distribution.
   *
   * DNS-validated against the `hostedZone` passed to `EdgeResources`. Must
   * be in us-east-1 — CDK enforces this via `crossRegionReferences: true`
   * on the consumer stack.
   */
  readonly certificate: acm.ICertificate;

  /**
   * The WAFv2 Web ACL in CloudFront scope, or `undefined` when the
   * Web ACL is disabled via `EdgeResources.enableWebAcl: false`.
   *
   * Carries the default managed rule set unless `wafManagedRules`
   * overrides it. Consumers attach this to their CloudFront distribution
   * via `webAclId: edge.webAcl?.attrArn` (guarding the optional).
   */
  readonly webAcl: wafv2.CfnWebACL | undefined;
}
