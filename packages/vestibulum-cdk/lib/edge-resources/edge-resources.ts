/**
 * EdgeResources — stateless L3 construct that owns the us-east-1
 * dependencies of a vestibulum-cdk auth-site: the ACM certificate for
 * the CloudFront distribution and the WAFv2 Web ACL attached to it.
 *
 * Both resources MUST live in us-east-1 — CloudFront's only-supported
 * region for ACM viewer certificates and for `CLOUDFRONT`-scoped WAFv2
 * Web ACLs. Deploying this construct anywhere else fails at synth time
 * with a clear, named error rather than at `cdk deploy` with a
 * CloudFormation `INVALID_REQUEST`.
 *
 * Integrated security fixes from the 2026-05-24 design review:
 *
 * - B-F: `wafManagedRules` lives on this construct's props (the WAF
 *   Web ACL lives here), not on `MagicLinkAuthSiteProps`.
 * - B-G: `AWSManagedRulesATPRuleSet` is removed from the default rule
 *   set. Consumers opt in via `extraWafManagedRuleGroups`.
 * - S-C8: WAF rate-limit tightened to 60/5min on `/auth-verify`
 *   (was 2000/5min).
 * - S-C10: cross-region SSM permissions documented positively in
 *   {@link CROSS_REGION_REFERENCES_DEPLOY_ROLE_PERMISSIONS}.
 * - S-C12: namespace + prefix overridable; default `'Vestibulum'`.
 *
 * @see {@link https://github.com/de-otio/saas-foundation/blob/main/doc/vestibulum-cdk/03-edge-resources.md}
 */

import { Construct } from "constructs";
import {
  RemovalPolicy,
  Stack,
  aws_certificatemanager as acm,
  aws_route53 as route53,
  aws_wafv2 as wafv2,
} from "aws-cdk-lib";

import {
  DEFAULT_METRICS_NAMESPACE,
  resolveMetricsNamespace,
  resolveResourceNamePrefix,
} from "../_internal/branding.js";
import type { IEdgeResources } from "../_internal/edge-handle.js";
import { defaultWafRules } from "./waf-defaults.js";

/**
 * Thrown when `EdgeResources` is instantiated in any stack whose
 * region resolves to a value other than `us-east-1`. The check
 * tolerates CDK tokens (unit tests with `env: undefined`) and fires
 * only when the consumer has explicitly set an incompatible region.
 */
export class EdgeResourcesRegionError extends Error {
  public override readonly name = "EdgeResourcesRegionError";
  public constructor(region: string) {
    super(
      `EdgeResources must be instantiated in a us-east-1 stack ` +
        `(got region '${region}'). CloudFront ACM certificates and ` +
        `CloudFront-scoped WAFv2 Web ACLs are us-east-1-only.`,
    );
  }
}

/**
 * Description of an additional AWS-managed rule group to append to
 * the default rule set. Useful for paid groups (ATPRuleSet,
 * BotControlRuleSet, ACFPRuleSet) the consumer specifically wants
 * to enable — each is a silent recurring bill if defaulted on, so
 * vestibulum-cdk keeps the cost-surface decision on the consumer side.
 */
export interface ExtraWafManagedRuleGroup {
  /**
   * Name of the AWS-managed rule group (e.g. `AWSManagedRulesATPRuleSet`).
   */
  readonly name: string;
  /**
   * CloudFormation `priority` for the rule. Defaults under 100 are
   * reserved for the vestibulum-cdk default set; use 100+ for
   * consumer-added rules so the defaults can be extended without
   * priority collisions.
   */
  readonly priority: number;
  /**
   * Optional managed-rule group configuration block (e.g. `loginPath`
   * for ATPRuleSet). Passed through verbatim to CloudFormation.
   */
  readonly managedRuleGroupConfigs?: wafv2.CfnWebACL.ManagedRuleGroupConfigProperty[];
}

/**
 * Construct props for {@link EdgeResources}.
 */
export interface EdgeResourcesProps {
  /**
   * Public-facing domain for the CloudFront distribution
   * (e.g. `app.example.com`). Used as the ACM cert subject.
   */
  readonly domain: string;

  /**
   * Route53 hosted zone used for ACM DNS validation records. Must
   * cover `domain` (either equal to it or a parent zone).
   */
  readonly hostedZone: route53.IHostedZone;

  /**
   * Additional SANs on the ACM cert. The common reason to set this
   * is to cover both the CloudFront distribution and the Cognito
   * Hosted UI custom domain with a single cert.
   */
  readonly subjectAlternativeNames?: string[];

  /**
   * Whether to create the CloudFront-scoped WAFv2 Web ACL.
   *
   * When `false`, no `CfnWebACL` is provisioned and {@link
   * EdgeResources.webAcl} is `undefined`; the consumer's CloudFront
   * distribution synthesises without a `WebACLId`. Use only where a
   * WAF is supplied out-of-band or deliberately omitted (e.g. a
   * dev/disposable stage) — the magic-link endpoint is a public auth
   * API and the `WafRequiredAspect` enforces WAF presence for the
   * default path.
   * @default true
   */
  readonly enableWebAcl?: boolean;

  /**
   * Override the default WAF managed rule set entirely. Passing a
   * single custom rule REPLACES the defaults — most consumers should
   * extend `defaultWafRules()` rather than replace. Ignored when
   * `enableWebAcl` is `false`.
   */
  readonly wafManagedRules?: wafv2.CfnWebACL.RuleProperty[];

  /**
   * Additional AWS-managed rule groups to append to the default rule
   * set. Useful for paid groups (ATPRuleSet, BotControl) the consumer
   * specifically wants to enable. Each entry is appended at the
   * priority you supply; the defaults occupy priorities 10-60.
   */
  readonly extraWafManagedRuleGroups?: ExtraWafManagedRuleGroup[];

  /**
   * Override the per-IP rate-limit on `/auth-verify` (5-min window).
   * @default 60
   */
  readonly authVerifyRateLimit?: number;

  /**
   * Override the per-IP rate-limit on `GET /login` (5-min window).
   * @default 200
   */
  readonly loginRateLimit?: number;

  /**
   * Override the CloudWatch metric namespace for the Web ACL's
   * visibility config. Per S-C12, consumers can suppress the
   * `Vestibulum/AuthSite` branding here.
   * @default `'Vestibulum/AuthSite'`
   */
  readonly metricsNamespace?: string;

  /**
   * Override the resource-name prefix used for the rate-limit rule
   * names and metric names. Per S-C12.
   * @default `'Vestibulum'`
   */
  readonly resourceNamePrefix?: string;

  /**
   * Removal policy for the cert and Web ACL. Both are stateless and
   * default to `DESTROY`; consumers running on RETAIN-by-policy infra
   * can override.
   * @default RemovalPolicy.DESTROY
   */
  readonly removalPolicy?: RemovalPolicy;
}

/**
 * Stateless L3 construct that owns the us-east-1 ACM certificate
 * and WAFv2 Web ACL for a vestibulum-cdk auth-site.
 *
 * @example
 * ```typescript
 * const edge = new EdgeResources(stack, 'Edge', {
 *   domain: 'app.example.com',
 *   hostedZone: HostedZone.fromLookup(stack, 'Zone', {
 *     domainName: 'example.com',
 *   }),
 * });
 * ```
 */
export class EdgeResources extends Construct implements IEdgeResources {
  /**
   * The ACM certificate for the CloudFront distribution. DNS-validated
   * against the hosted zone supplied in props.
   */
  public readonly certificate: acm.ICertificate;

  /**
   * The CloudFront-scoped WAFv2 Web ACL. Carries the default managed
   * rule set unless `wafManagedRules` overrides it. `undefined` when
   * `enableWebAcl` is `false`.
   */
  public readonly webAcl: wafv2.CfnWebACL | undefined;

  /**
   * The CloudWatch metric namespace used by the Web ACL's visibility
   * config. Exposed so downstream constructs (and tests) can read
   * the resolved value.
   */
  public readonly metricsNamespace: string;

  /**
   * The resolved resource-name prefix. Exposed for the same reason
   * as {@link metricsNamespace}.
   */
  public readonly resourceNamePrefix: string;

  public constructor(scope: Construct, id: string, props: EdgeResourcesProps) {
    super(scope, id);

    // -------------------------------------------------------------------
    // Region guard — fail fast at synth time, not at deploy time.
    // The `/Token/` check lets unit tests with `env: undefined` pass.
    // -------------------------------------------------------------------
    const region = Stack.of(this).region;
    if (region && region !== "us-east-1" && !/Token/.test(region)) {
      throw new EdgeResourcesRegionError(region);
    }

    this.resourceNamePrefix = resolveResourceNamePrefix(props.resourceNamePrefix);
    this.metricsNamespace = resolveMetricsNamespace(props.metricsNamespace);
    const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;

    // -------------------------------------------------------------------
    // ACM certificate — DNS-validated via the consumer's hosted zone.
    // -------------------------------------------------------------------
    const certProps: acm.CertificateProps = {
      domainName: props.domain,
      validation: acm.CertificateValidation.fromDns(props.hostedZone),
      ...(props.subjectAlternativeNames && {
        subjectAlternativeNames: props.subjectAlternativeNames,
      }),
    };
    const certificate = new acm.Certificate(this, "Certificate", certProps);
    certificate.applyRemovalPolicy(removalPolicy);
    this.certificate = certificate;

    // -------------------------------------------------------------------
    // WAFv2 Web ACL — CloudFront-scoped.
    //
    // Default rule set per defaultWafRules(); the `extraWafManagedRuleGroups`
    // prop opts in to paid groups (ATPRuleSet etc.) without changing
    // the default.
    //
    // `enableWebAcl: false` opts out entirely: no CfnWebACL is created
    // and `this.webAcl` stays `undefined`, so the downstream distribution
    // synthesises without a WebACLId. The rule/visibility config below is
    // guarded accordingly — none of it is built when the ACL is off.
    // -------------------------------------------------------------------
    const enableWebAcl = props.enableWebAcl ?? true;
    if (enableWebAcl) {
      const baseRules: wafv2.CfnWebACL.RuleProperty[] =
        props.wafManagedRules ??
        defaultWafRules({
          resourceNamePrefix: this.resourceNamePrefix,
          ...(props.authVerifyRateLimit !== undefined && {
            authVerifyRateLimit: props.authVerifyRateLimit,
          }),
          ...(props.loginRateLimit !== undefined && {
            loginRateLimit: props.loginRateLimit,
          }),
        });

      const extras = (props.extraWafManagedRuleGroups ?? []).map(
        (rg): wafv2.CfnWebACL.RuleProperty => ({
          name: `AWS-${rg.name}`,
          priority: rg.priority,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: rg.name,
              ...(rg.managedRuleGroupConfigs && {
                managedRuleGroupConfigs: rg.managedRuleGroupConfigs,
              }),
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `AWS-${rg.name}`,
            sampledRequestsEnabled: true,
          },
        }),
      );

      const rules: wafv2.CfnWebACL.RuleProperty[] = [...baseRules, ...extras];

      const safeDomain = props.domain.replace(/\./g, "-");
      const webAcl = new wafv2.CfnWebACL(this, "WebAcl", {
        scope: "CLOUDFRONT",
        defaultAction: { allow: {} },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: `${this.resourceNamePrefix}Waf-${safeDomain}`,
          sampledRequestsEnabled: true,
        },
        rules,
        description: `${this.resourceNamePrefix} WAFv2 Web ACL for ${props.domain}.`,
      });
      webAcl.applyRemovalPolicy(removalPolicy);
      this.webAcl = webAcl;
    } else {
      this.webAcl = undefined;
    }

    // Suppress unused-import lint for the const exported here only as
    // a side-effect for documentation symmetry.
    void DEFAULT_METRICS_NAMESPACE;
  }
}
