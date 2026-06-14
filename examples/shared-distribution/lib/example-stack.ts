/**
 * Realistic instantiation of {@link SharedDistributionIdentity}.
 *
 * Shape:
 *   - Single stack, single identity, multi-tenant by data.
 *   - All domains are IETF-reserved (`example.com`) — never use real
 *     domains in committed example code.
 *   - The wildcard cert is `existingWildcardCertificateArn` with a
 *     placeholder ARN so the example synthesises cleanly without
 *     account-bound context lookups. Real consumers swap in a
 *     hosted-zone-backed cert (see README § Prerequisites).
 *   - `adminInvokePrincipal` is the deployment role; substitute the
 *     consumer's CLI / EventBridge / portal role for production.
 *   - `alarmTopic` is wired so the construct's CloudWatch alarms
 *     (orphan accumulation, allowlist changes, compensation events)
 *     have a subscriber.
 *
 * What the example deliberately OMITS:
 *   - No tenants are seeded at synth time. Tenants are pure data and
 *     are onboarded post-deploy via the admin Function URL (see
 *     README § Onboard a tenant).
 *   - No `tableKmsKey`. AWS-managed encryption is the construct
 *     default — sufficient for non-compliance-driven environments.
 *   - No custom `responseHeadersPolicy`, WAF ACL overrides, or
 *     custom JWKS TTL. The construct's hardened defaults are taken
 *     as-is.
 */

import { Stack, type StackProps, Tags } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sns from "aws-cdk-lib/aws-sns";
import { type Construct } from "constructs";

import { SharedDistributionIdentity } from "@de-otio/vestibulum-cdk";

/**
 * Parent subdomain the example identity serves. Tenants land on
 * leftmost-label subdomains under this — e.g. `acme.tenants.example.com`.
 *
 * `example.com` is an IETF-reserved test domain (RFC 2606). Real
 * consumers replace this with the parent zone they own.
 */
const TENANT_SUBDOMAIN_PARENT = "tenants.example.com";

/**
 * SES verified identity used as the magic-link sender. The sender
 * domain must be SES-verified in the deploy account before tenants
 * can complete the magic-link flow.
 */
const SES_IDENTITY_SENDER = "no-reply@example.com";

/**
 * Placeholder ARN for the wildcard ACM certificate. Real consumers
 * produce this cert via a us-east-1 stack (DNS validation against
 * their hosted zone) and import it here, or pass a `hostedZone` prop
 * with `crossRegionReferences: true` on the stack.
 */
const PLACEHOLDER_WILDCARD_CERT_ARN =
  "arn:aws:acm:us-east-1:111111111111:certificate/00000000-0000-0000-0000-000000000000";

export class ExampleStack extends Stack {
  public readonly identity: SharedDistributionIdentity;

  public constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    Tags.of(this).add("example", "shared-distribution");

    // Operator/deployment principal that is allowed to invoke the
    // admin Function URL. In a real deploy this is the CI deploy
    // role, the consumer's tenant-management service role, or an
    // EventBridge rule's role. Here we use a placeholder role ARN —
    // swap for the real principal at deploy time.
    const adminInvokePrincipal = new iam.ArnPrincipal(
      `arn:aws:iam::${this.account}:role/example-tenant-admin-role`,
    );

    // Alarms (orphan accumulation, allowlist changes, compensation
    // events) need a subscriber. The construct creates the alarms
    // either way; without a topic, alarms still fire but no one
    // notices.
    const alarmTopic = new sns.Topic(this, "AlarmTopic", {
      displayName: "shared-distribution-example-alarms",
    });

    this.identity = new SharedDistributionIdentity(this, "Identity", {
      tenantSubdomainParent: TENANT_SUBDOMAIN_PARENT,
      sesIdentitySender: SES_IDENTITY_SENDER,

      // Import an existing wildcard cert by ARN (placeholder).
      // Real consumers either:
      //   - pass `hostedZone: route53.HostedZone.fromLookup(...)` with
      //     `crossRegionReferences: true` on the stack, OR
      //   - produce the cert in a separate us-east-1 stack and import
      //     its ARN here.
      existingWildcardCertificateArn: PLACEHOLDER_WILDCARD_CERT_ARN,

      adminInvokePrincipal,
      alarmTopic,

      // Defaults are good — left explicit here to show the surface.
      // reservedSubdomains: undefined → DEFAULT_RESERVED_SUBDOMAINS
      // tenantSubdomainPattern: undefined → DEFAULT_TENANT_SUBDOMAIN_PATTERN
      // jwksTtl: undefined → 15 min
      // idTokenValidity: undefined → 60 min
      // advancedSecurity: undefined → 'audit' (shared-pool default)
      // tableKmsKey: undefined → AWS_MANAGED encryption
    });

    // Stack outputs — make the admin handles discoverable for operator
    // tooling. The README's onboarding snippets reference these.
    this.exportValue(this.identity.adminLambdaName, {
      name: "AdminLambdaName",
    });
    this.exportValue(this.identity.adminFunctionUrl, {
      name: "AdminFunctionUrl",
    });
    this.exportValue(this.identity.distribution.distributionDomainName, {
      name: "DistributionDomain",
    });
    this.exportValue(this.identity.wildcardCertificateArn, {
      name: "WildcardCertArn",
    });
  }
}
