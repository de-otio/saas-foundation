/**
 * `crossRegionReferences: true` deploy-role requirement, stated
 * positively per the integrated security review (S-C10).
 *
 * `MagicLinkAuthSite` reads `EdgeResources.certificate.certificateArn`
 * and `EdgeResources.webAcl.attrArn` from a stack in a different
 * region. CDK implements that under the hood by writing SSM parameters
 * in us-east-1 with predictable names; the consumer's deploy role
 * needs to read those parameters.
 *
 * This module is documentation-only. The IAM grant itself lives on
 * the consumer's deploy role (typically the cdk-bootstrap stack's
 * standard policies); the construct cannot grant cross-stack /
 * cross-region IAM at synth time.
 *
 * Exposed because synth-time error messages and README examples reach
 * for the canonical statement, and a single source for it keeps the
 * wording stable across docs.
 */

/**
 * The IAM permissions the consumer's deploy role needs to read the
 * SSM-backed cross-region references CDK generates for
 * `crossRegionReferences: true`.
 *
 * Positive statement (S-C10): scoped to **the same account** in
 * **us-east-1**, against the `/cdk/exports/*` SSM parameter prefix.
 * No cross-account grant is required.
 */
export const CROSS_REGION_REFERENCES_DEPLOY_ROLE_PERMISSIONS = {
  /** The minimum action set. PutParameter is needed on the publishing
   *  side (the us-east-1 stack); GetParameter on the consuming side
   *  (the regional stack). Most cdk-bootstrap deploy roles already
   *  include both. */
  actions: ["ssm:GetParameter", "ssm:PutParameter"] as const,
  /** Resource pattern. Substitute the consumer's account ID. */
  resourcePattern: "arn:aws:ssm:us-east-1:<account-id>:parameter/cdk/exports/*",
  /** Note worth surfacing to consumers: SSM parameter names are not
   *  secrets but the pattern (`/cdk/exports/<stack-name>/<export-name>`)
   *  fingerprints vestibulum-cdk-using accounts. Low-risk; documented
   *  for completeness. */
  note: "Same-account, us-east-1 only. No cross-account grant required.",
} as const;

/**
 * Renders the deploy-role permission requirement as a human-readable
 * paragraph. Used in synth-time error messages so the consumer sees
 * the canonical statement without consulting the README.
 */
export function renderCrossRegionPermissionGuidance(accountId?: string): string {
  const arn = CROSS_REGION_REFERENCES_DEPLOY_ROLE_PERMISSIONS.resourcePattern.replace(
    "<account-id>",
    accountId ?? "<account-id>",
  );
  return (
    `The consumer's CDK deploy role needs ` +
    `${CROSS_REGION_REFERENCES_DEPLOY_ROLE_PERMISSIONS.actions.join(" + ")} ` +
    `on ${arn}. ${CROSS_REGION_REFERENCES_DEPLOY_ROLE_PERMISSIONS.note}`
  );
}
