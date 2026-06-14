/*
 * Custom cdk-nag rule: every Vestibulum CloudFront distribution must
 * redirect HTTP viewers to HTTPS. The auth-cookie is `Secure` and the
 * Lambda@Edge JWT verifier rejects requests without it — accepting
 * plaintext HTTP at the edge would silently downgrade those checks.
 */
import { CfnResource, Stack } from "aws-cdk-lib";
import { CfnDistribution } from "aws-cdk-lib/aws-cloudfront";
import { NagRuleCompliance } from "cdk-nag";

/**
 * Acceptable viewer-protocol-policy values. `redirect-to-https` is the
 * intended default; `https-only` is also accepted (even stricter).
 */
const ALLOWED_POLICIES = new Set(["redirect-to-https", "https-only"]);

interface CacheBehaviourShape {
  viewerProtocolPolicy?: string;
}

interface DistributionConfigShape {
  defaultCacheBehavior?: CacheBehaviourShape;
  cacheBehaviors?: CacheBehaviourShape[];
}

/**
 * Returns NON_COMPLIANT if any default or extra cache behaviour permits
 * plain HTTP at the viewer edge.
 */
function cloudfrontViewerProtocolRedirect(node: CfnResource): NagRuleCompliance {
  if (!(node instanceof CfnDistribution)) {
    return NagRuleCompliance.NOT_APPLICABLE;
  }

  const config = Stack.of(node).resolve(node.distributionConfig) as
    | DistributionConfigShape
    | undefined;
  if (config === undefined) {
    return NagRuleCompliance.NON_COMPLIANT;
  }

  const dflt = config.defaultCacheBehavior?.viewerProtocolPolicy;
  if (dflt == null || !ALLOWED_POLICIES.has(dflt)) {
    return NagRuleCompliance.NON_COMPLIANT;
  }

  const extras = config.cacheBehaviors ?? [];
  for (const cb of extras) {
    const v = cb.viewerProtocolPolicy;
    if (v == null || !ALLOWED_POLICIES.has(v)) {
      return NagRuleCompliance.NON_COMPLIANT;
    }
  }

  return NagRuleCompliance.COMPLIANT;
}

/**
 * The cdk-nag rule callback. Named `CloudFrontViewerProtocolRedirect` so
 * it surfaces clearly in cdk-nag report output and suppression identifiers.
 */
export const CloudFrontViewerProtocolRedirect = Object.defineProperty(
  cloudfrontViewerProtocolRedirect,
  "name",
  { value: "CloudFrontViewerProtocolRedirect" },
);
