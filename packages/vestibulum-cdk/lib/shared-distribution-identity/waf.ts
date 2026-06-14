/**
 * Two-layer WAF posture for `SharedDistributionIdentity`. Implements
 * review fixes H2 (CloudFront-side ACL) and H3 (Cognito-pool ACL) per
 * `doc/vestibulum/shared-distribution/07-security-and-isolation.md` §
 * WAF.
 *
 * **Why two ACLs:** the shared distribution faces two distinct attack
 * surfaces. CloudFront-side traffic is the browser-facing surface
 * (rate-limit, OWASP-style rules). Cognito-pool traffic is the
 * direct-API surface (`InitiateAuth`, `SignUp`) which bypasses
 * CloudFront entirely. Each needs its own rule set scoped to its
 * threat profile.
 *
 * Both ACLs are constructed by default. Consumers who already operate
 * their own ACLs (e.g. a corporate-wide WAF with bespoke rules) can
 * supply pre-built ACL ARNs via the construct props; in that case
 * this module skips the local construction entirely.
 *
 * MCP C4 confirmed (2026-05-24): the AWS-managed rule group names
 * used here — `AWSManagedRulesCommonRuleSet`,
 * `AWSManagedRulesKnownBadInputsRuleSet`,
 * `AWSManagedRulesAmazonIpReputationList` — are the current canonical
 * names per
 * <https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-list.html>.
 */

import {
  RemovalPolicy,
  aws_cognito as cognito,
  aws_wafv2 as wafv2,
} from "aws-cdk-lib";
import { Construct } from "constructs";

/**
 * Default per-IP rate-limit on the CloudFront distribution
 * (5-minute window). 1000 req/5min is permissive for legitimate
 * users browsing the login pages, but stops sustained pumping.
 */
export const DEFAULT_CLOUDFRONT_RATE_LIMIT = 1000;

/**
 * Default per-IP rate-limit on Cognito `InitiateAuth` (5-minute
 * window). Tighter than CloudFront because each call costs
 * meaningfully more than a static asset fetch.
 */
export const DEFAULT_COGNITO_INITIATE_AUTH_RATE_LIMIT = 100;

/**
 * Default per-IP rate-limit on Cognito `SignUp` (5-minute window).
 * Tighter still — signup is rare and abuse-prone.
 */
export const DEFAULT_COGNITO_SIGNUP_RATE_LIMIT = 20;

/**
 * Build the default CloudFront-scoped rule set. Order:
 *
 *   1. (prio 10) Per-IP rate limit on all paths.
 *   2. (prio 20) `AWSManagedRulesCommonRuleSet` — OWASP baseline.
 *   3. (prio 30) `AWSManagedRulesKnownBadInputsRuleSet` — exploit signatures.
 *
 * Returns a fresh array each call so consumers can mutate it without
 * leaking state across stack instantiations.
 */
export function defaultCloudFrontWafRules(
  options: { readonly rateLimit?: number } = {},
): wafv2.CfnWebACL.RuleProperty[] {
  const rateLimit = options.rateLimit ?? DEFAULT_CLOUDFRONT_RATE_LIMIT;
  return [
    {
      name: "VestibulumSharedCloudFrontRateLimit",
      priority: 10,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          limit: rateLimit,
          aggregateKeyType: "IP",
          evaluationWindowSec: 300,
        },
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "VestibulumSharedCloudFrontRateLimit",
        sampledRequestsEnabled: true,
      },
    },
    {
      name: "AWS-AWSManagedRulesCommonRuleSet",
      priority: 20,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: {
          vendorName: "AWS",
          name: "AWSManagedRulesCommonRuleSet",
        },
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "AWS-AWSManagedRulesCommonRuleSet",
        sampledRequestsEnabled: true,
      },
    },
    {
      name: "AWS-AWSManagedRulesKnownBadInputsRuleSet",
      priority: 30,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: {
          vendorName: "AWS",
          name: "AWSManagedRulesKnownBadInputsRuleSet",
        },
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "AWS-AWSManagedRulesKnownBadInputsRuleSet",
        sampledRequestsEnabled: true,
      },
    },
  ];
}

/**
 * Build the default Cognito-pool (REGIONAL scope) rule set. Order:
 *
 *   1. (prio 10) Per-IP rate limit on `InitiateAuth`.
 *   2. (prio 20) Per-IP rate limit on `SignUp`.
 *   3. (prio 30) `AWSManagedRulesAmazonIpReputationList`.
 *
 * Per `07-security-and-isolation.md` § Cognito-side WAF: WAF rules
 * cannot match on PII (`username`, `password`), but can match on
 * non-confidential metadata (User-Agent, IP, request size). The
 * rate-limit rules below scope down on JSON body action names.
 */
export function defaultCognitoWafRules(
  options: {
    readonly initiateAuthRateLimit?: number;
    readonly signUpRateLimit?: number;
  } = {},
): wafv2.CfnWebACL.RuleProperty[] {
  const initLimit =
    options.initiateAuthRateLimit ?? DEFAULT_COGNITO_INITIATE_AUTH_RATE_LIMIT;
  const signUpLimit = options.signUpRateLimit ?? DEFAULT_COGNITO_SIGNUP_RATE_LIMIT;
  return [
    {
      name: "VestibulumSharedCognitoInitiateAuthRateLimit",
      priority: 10,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          limit: initLimit,
          aggregateKeyType: "IP",
          evaluationWindowSec: 300,
          scopeDownStatement: {
            byteMatchStatement: {
              fieldToMatch: { singleHeader: { name: "x-amz-target" } },
              positionalConstraint: "CONTAINS",
              searchString: "InitiateAuth",
              textTransformations: [{ priority: 0, type: "NONE" }],
            },
          },
        },
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "VestibulumSharedCognitoInitiateAuthRateLimit",
        sampledRequestsEnabled: true,
      },
    },
    {
      name: "VestibulumSharedCognitoSignUpRateLimit",
      priority: 20,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          limit: signUpLimit,
          aggregateKeyType: "IP",
          evaluationWindowSec: 300,
          scopeDownStatement: {
            byteMatchStatement: {
              fieldToMatch: { singleHeader: { name: "x-amz-target" } },
              positionalConstraint: "CONTAINS",
              searchString: "SignUp",
              textTransformations: [{ priority: 0, type: "NONE" }],
            },
          },
        },
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "VestibulumSharedCognitoSignUpRateLimit",
        sampledRequestsEnabled: true,
      },
    },
    {
      name: "AWS-AWSManagedRulesAmazonIpReputationList",
      priority: 30,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: {
          vendorName: "AWS",
          name: "AWSManagedRulesAmazonIpReputationList",
        },
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "AWS-AWSManagedRulesAmazonIpReputationList",
        sampledRequestsEnabled: true,
      },
    },
  ];
}

/**
 * Props for {@link Waf}. Either pre-built ACL ARN OR a per-layer
 * rate-limit override; supply both for the corresponding layer and
 * the ARN takes precedence (the rate-limit override is silently
 * ignored — documented in JSDoc).
 */
export interface WafProps {
  /**
   * The Cognito User Pool the regional ACL is associated to. Required
   * only when {@link cognitoPoolWebAclArn} is unset — when the
   * consumer supplies their own ACL ARN, the association is
   * presumed to live elsewhere.
   */
  readonly userPool?: cognito.IUserPool;

  /**
   * Pre-built CloudFront-scoped WAF ACL ARN. When set, this module
   * skips constructing a CloudFront-scope ACL of its own. Useful for
   * consumers with a corporate-wide WAF policy.
   */
  readonly cloudFrontWebAclArn?: string;

  /**
   * Pre-built REGIONAL WAF ACL ARN already associated with the
   * Cognito pool. When set, this module skips constructing the
   * regional ACL.
   */
  readonly cognitoPoolWebAclArn?: string;

  /**
   * Override the per-IP rate limit on the CloudFront ACL (5-min
   * window). Ignored when {@link cloudFrontWebAclArn} is set.
   * @default 1000
   */
  readonly cloudFrontRateLimit?: number;

  /**
   * Override the per-IP rate limit on Cognito `InitiateAuth`
   * (5-min window). Ignored when {@link cognitoPoolWebAclArn} is
   * set.
   * @default 100
   */
  readonly cognitoInitiateAuthRateLimit?: number;

  /**
   * Override the per-IP rate limit on Cognito `SignUp` (5-min
   * window). Ignored when {@link cognitoPoolWebAclArn} is set.
   * @default 20
   */
  readonly cognitoSignUpRateLimit?: number;

  /**
   * Removal policy for any ACLs this construct creates. Defaults
   * to `DESTROY` (the ACLs hold no state worth retaining).
   * @default RemovalPolicy.DESTROY
   */
  readonly removalPolicy?: RemovalPolicy;
}

/**
 * Owns the two WAF Web ACLs for `SharedDistributionIdentity`.
 *
 * Construct in the same stack as the {@link cognito.IUserPool} for the
 * regional ACL — the CloudFront ACL is `CLOUDFRONT`-scoped which
 * means us-east-1 and is wired in by ARN from the consumer's
 * us-east-1 stack (mirrors `EdgeResources`).
 *
 * After construction:
 *
 *   - `cloudFrontWebAclArn` is always a usable ARN (either provided
 *     or just-constructed).
 *   - `cognitoPoolWebAclArn` is always a usable ARN.
 *   - The regional ACL → user pool association is provisioned
 *     automatically when this module builds the regional ACL.
 */
export class Waf extends Construct {
  /** ARN of the CloudFront-scoped Web ACL. */
  public readonly cloudFrontWebAclArn: string;

  /** ARN of the regional Web ACL associated with the Cognito pool. */
  public readonly cognitoPoolWebAclArn: string;

  /**
   * The CloudFront ACL if this module constructed it; `undefined` if
   * the consumer supplied a pre-built ARN.
   */
  public readonly cloudFrontWebAcl: wafv2.CfnWebACL | undefined;

  /**
   * The Cognito ACL if this module constructed it; `undefined` if the
   * consumer supplied a pre-built ARN.
   */
  public readonly cognitoPoolWebAcl: wafv2.CfnWebACL | undefined;

  public constructor(scope: Construct, id: string, props: WafProps) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;

    // -----------------------------------------------------------------
    // CloudFront-scoped ACL.
    // -----------------------------------------------------------------
    if (props.cloudFrontWebAclArn !== undefined) {
      this.cloudFrontWebAclArn = props.cloudFrontWebAclArn;
      this.cloudFrontWebAcl = undefined;
    } else {
      const cfRules = defaultCloudFrontWafRules({
        ...(props.cloudFrontRateLimit !== undefined && {
          rateLimit: props.cloudFrontRateLimit,
        }),
      });
      const cfAcl = new wafv2.CfnWebACL(this, "CloudFrontWebAcl", {
        scope: "CLOUDFRONT",
        defaultAction: { allow: {} },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: "VestibulumSharedCloudFrontWaf",
          sampledRequestsEnabled: true,
        },
        rules: cfRules,
        description:
          "Vestibulum shared-distribution CloudFront WAF (rate-limit + OWASP managed rules).",
      });
      cfAcl.applyRemovalPolicy(removalPolicy);
      this.cloudFrontWebAcl = cfAcl;
      this.cloudFrontWebAclArn = cfAcl.attrArn;
    }

    // -----------------------------------------------------------------
    // REGIONAL ACL (Cognito-pool).
    // -----------------------------------------------------------------
    if (props.cognitoPoolWebAclArn !== undefined) {
      this.cognitoPoolWebAclArn = props.cognitoPoolWebAclArn;
      this.cognitoPoolWebAcl = undefined;
    } else {
      if (props.userPool === undefined) {
        throw new Error(
          "Waf: `userPool` is required when `cognitoPoolWebAclArn` is not provided " +
            "(the regional ACL must be associated with a user pool).",
        );
      }
      const cogRules = defaultCognitoWafRules({
        ...(props.cognitoInitiateAuthRateLimit !== undefined && {
          initiateAuthRateLimit: props.cognitoInitiateAuthRateLimit,
        }),
        ...(props.cognitoSignUpRateLimit !== undefined && {
          signUpRateLimit: props.cognitoSignUpRateLimit,
        }),
      });
      const cogAcl = new wafv2.CfnWebACL(this, "CognitoPoolWebAcl", {
        scope: "REGIONAL",
        defaultAction: { allow: {} },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: "VestibulumSharedCognitoWaf",
          sampledRequestsEnabled: true,
        },
        rules: cogRules,
        description:
          "Vestibulum shared-distribution Cognito-pool WAF (rate-limit InitiateAuth+SignUp, IP reputation).",
      });
      cogAcl.applyRemovalPolicy(removalPolicy);
      this.cognitoPoolWebAcl = cogAcl;
      this.cognitoPoolWebAclArn = cogAcl.attrArn;

      // Associate with the user pool.
      const assoc = new wafv2.CfnWebACLAssociation(this, "CognitoPoolWebAclAssoc", {
        resourceArn: props.userPool.userPoolArn,
        webAclArn: cogAcl.attrArn,
      });
      assoc.applyRemovalPolicy(removalPolicy);
    }
  }
}
