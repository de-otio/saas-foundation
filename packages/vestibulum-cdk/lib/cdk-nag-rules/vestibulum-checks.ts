import { CfnResource } from "aws-cdk-lib";
import { IConstruct } from "constructs";
import { AwsSolutionsChecks, NagMessageLevel, NagPackProps } from "cdk-nag";
import { LambdaEdgeNoLogs } from "./lambda-edge-no-logs.js";
import { CloudFrontViewerProtocolRedirect } from "./cloudfront-viewer-protocol-redirect.js";

/**
 * cdk-nag NagPack that layers Vestibulum-specific compliance rules
 * over the upstream `AwsSolutions` rule set.
 *
 * **Rules added by this pack:**
 *
 * - **VST1 — `LambdaEdgeNoLogs`** (Error): Lambda@Edge functions must
 *   have no `logs:*` permission on their execution role.
 *
 * - **VST2 — `CloudFrontViewerProtocolRedirect`** (Error): every
 *   CloudFront cache behaviour must use `redirect-to-https` or
 *   `https-only`. Plaintext HTTP would let an attacker strip the
 *   Secure auth cookie.
 *
 * Wire in from your stack:
 *
 * @example
 * ```typescript
 * import { Aspects } from 'aws-cdk-lib';
 * import { VestibulumChecks } from '@de-otio/vestibulum-cdk';
 *
 * Aspects.of(app).add(new VestibulumChecks({ verbose: true }));
 * ```
 */
export class VestibulumChecks extends AwsSolutionsChecks {
  public constructor(props?: NagPackProps) {
    super(props);
    // The pack name surfaces in finding IDs (e.g. `Vestibulum-VST1`).
    (this as unknown as { packName: string }).packName = "Vestibulum";
  }

  public override visit(node: IConstruct): void {
    super.visit(node);
    if (node instanceof CfnResource) {
      this.checkVestibulumRules(node);
    }
  }

  private checkVestibulumRules(node: CfnResource): void {
    const apply = (
      this as unknown as {
        applyRule(params: Record<string, unknown>): void;
      }
    ).applyRule.bind(this);

    apply({
      ruleSuffixOverride: "VST1",
      info: "Lambda@Edge execution role grants CloudWatch Logs actions.",
      explanation:
        "Lambda@Edge runs in every CloudFront region; granting logs:* " +
        "would let the function write user data outside the consumer-" +
        "authorised residency boundary. Vestibulum requires the edge " +
        "role to omit all logs actions.",
      level: NagMessageLevel.ERROR,
      rule: LambdaEdgeNoLogs,
      node,
    });

    apply({
      ruleSuffixOverride: "VST2",
      info: "CloudFront cache behaviour permits plaintext HTTP.",
      explanation:
        "All Vestibulum CloudFront cache behaviours must redirect HTTP " +
        "to HTTPS (or set https-only). The auth cookie is Secure and " +
        "cannot survive a plaintext leg.",
      level: NagMessageLevel.ERROR,
      rule: CloudFrontViewerProtocolRedirect,
      node,
    });
  }
}
