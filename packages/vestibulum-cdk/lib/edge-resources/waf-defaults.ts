/**
 * Default WAFv2 managed-rule set for the CloudFront-scoped Web ACL
 * owned by {@link EdgeResources}.
 *
 * Built per the integrated design review of 2026-05-24:
 *
 * - **B-G:** `AWSManagedRulesATPRuleSet` is NOT in the default set. ATP
 *   is a paid managed-rule group (monthly fee + per-request charges)
 *   and is semantically meaningless against a passwordless magic-link
 *   flow — the "credential" is an opaque random token, there is no
 *   password field for ATP to inspect. Consumers who want it opt in via
 *   `extraWafManagedRuleGroups`.
 *
 * - **S-C8:** The rate-based statement on `/auth-verify` defaults to
 *   60 requests per 5-min window per IP, not the broader 2000/5min
 *   used in pre-review drafts. Every `/auth-verify` request triggers
 *   an SES send and a Cognito API call; the bar is much lower than
 *   generic bot-rate-limit.
 *
 * - **S-C12:** Metric names are derivable from the supplied prefix so
 *   the `Vestibulum*` branding is suppressible in consumer dashboards.
 *
 * Priorities are explicit and non-consecutive so consumers can interleave
 * custom rules without renumbering.
 */

import type * as wafv2 from "aws-cdk-lib/aws-wafv2";

/**
 * Default per-IP rate-limit on `/auth-verify` (5-minute window).
 *
 * Tight by intent — every request triggers an SES send and a Cognito
 * API call, so legitimate use (one click on a magic link plus a few
 * retries for typos) passes well below this limit while pumping
 * attacks fail almost immediately.
 *
 * Configurable via {@link DefaultWafRulesOptions.authVerifyRateLimit}.
 */
export const DEFAULT_AUTH_VERIFY_RATE_LIMIT = 60;

/**
 * Default per-IP rate-limit on `GET /login` (5-minute window).
 *
 * Looser than the auth-verify limit; `/login` serves a static HTML
 * page so generic bot scraping is the threat profile, not SES /
 * Cognito cost-DoS.
 *
 * Configurable via {@link DefaultWafRulesOptions.loginRateLimit}.
 */
export const DEFAULT_LOGIN_RATE_LIMIT = 200;

/**
 * Options for {@link defaultWafRules}. All optional — the defaults
 * produce the rule set documented in `03-edge-resources.md`.
 */
export interface DefaultWafRulesOptions {
  /**
   * Resource-name prefix for the rate-limit rule names and metric
   * names emitted by this rule set. Defaults to `'Vestibulum'`; pass
   * a different value to suppress the Vestibulum branding in
   * CloudWatch dashboards (S-C12).
   */
  readonly resourceNamePrefix?: string;
  /**
   * Per-IP rate limit on `/auth-verify` (5-minute window).
   * @default 60
   */
  readonly authVerifyRateLimit?: number;
  /**
   * Per-IP rate limit on `GET /login` (5-minute window).
   * @default 200
   */
  readonly loginRateLimit?: number;
}

/**
 * Returns the Vestibulum default WAFv2 managed-rule set.
 *
 * **Why a function, not a const:** WAFv2 `RuleProperty` objects are
 * inert data, but the consuming construct may mutate the array when
 * it merges in consumer-passed overrides. Returning a fresh array
 * each call prevents two stacks in the same app from sharing the same
 * underlying object — a footgun where a mutation in stack A would
 * leak into stack B.
 *
 * **Rule set:**
 *
 * | Priority | Name                                          | Action  |
 * | -------- | --------------------------------------------- | ------- |
 * | 10       | `AWS-AWSManagedRulesCommonRuleSet`            | managed |
 * | 20       | `AWS-AWSManagedRulesKnownBadInputsRuleSet`    | managed |
 * | 30       | `AWS-AWSManagedRulesAmazonIpReputationList`   | managed |
 * | 50       | `${prefix}AuthRateLimit` (on `/auth-verify`)  | block   |
 * | 60       | `${prefix}LoginRateLimit` (on `/login` GET)   | block   |
 */
export function defaultWafRules(
  options: DefaultWafRulesOptions = {},
): wafv2.CfnWebACL.RuleProperty[] {
  const prefix = options.resourceNamePrefix ?? "Vestibulum";
  const authVerifyLimit = options.authVerifyRateLimit ?? DEFAULT_AUTH_VERIFY_RATE_LIMIT;
  const loginLimit = options.loginRateLimit ?? DEFAULT_LOGIN_RATE_LIMIT;

  return [
    // 1. Common rule set — broad OWASP-style baseline.
    {
      name: "AWS-AWSManagedRulesCommonRuleSet",
      priority: 10,
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
    // 2. Known bad inputs — exploit payload signatures.
    {
      name: "AWS-AWSManagedRulesKnownBadInputsRuleSet",
      priority: 20,
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
    // 3. IP reputation — drop traffic from known-bad IPs.
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
    // 4. Tight rate limit on /auth-verify — magic-link-pumping guard.
    //    Per S-C8: every /auth-verify request triggers an SES send +
    //    Cognito API call, so the bar is much lower than generic
    //    bot-rate-limit.
    {
      name: `${prefix}AuthRateLimit`,
      priority: 50,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          limit: authVerifyLimit,
          aggregateKeyType: "IP",
          evaluationWindowSec: 300,
          scopeDownStatement: {
            byteMatchStatement: {
              fieldToMatch: { uriPath: {} },
              positionalConstraint: "STARTS_WITH",
              searchString: "/auth-verify",
              textTransformations: [{ priority: 0, type: "LOWERCASE" }],
            },
          },
        },
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `${prefix}AuthRateLimit`,
        sampledRequestsEnabled: true,
      },
    },
    // 5. Looser rate limit on GET /login — generic bot deterrent for
    //    the static login page. Catches scrapers without affecting
    //    normal use.
    {
      name: `${prefix}LoginRateLimit`,
      priority: 60,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          limit: loginLimit,
          aggregateKeyType: "IP",
          evaluationWindowSec: 300,
          scopeDownStatement: {
            byteMatchStatement: {
              fieldToMatch: { uriPath: {} },
              positionalConstraint: "STARTS_WITH",
              searchString: "/login",
              textTransformations: [{ priority: 0, type: "LOWERCASE" }],
            },
          },
        },
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `${prefix}LoginRateLimit`,
        sampledRequestsEnabled: true,
      },
    },
  ];
}
