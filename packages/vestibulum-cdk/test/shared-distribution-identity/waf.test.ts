/**
 * Tests for the two-layer WAF construct.
 *
 * Coverage:
 *   - Default CloudFront ACL has the three rules.
 *   - Default Cognito ACL has the three rules + WebACLAssociation.
 *   - `cloudFrontWebAclArn` override skips the default creation.
 *   - `cognitoPoolWebAclArn` override skips the default creation.
 *   - Missing `userPool` when not providing `cognitoPoolWebAclArn`
 *     throws a clear error.
 *   - Rate-limit overrides flow through to the rendered properties.
 *   - Removal policy override is applied.
 */

import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { afterAll, describe, expect, it } from "vitest";

import {
  DEFAULT_CLOUDFRONT_RATE_LIMIT,
  DEFAULT_COGNITO_INITIATE_AUTH_RATE_LIMIT,
  DEFAULT_COGNITO_SIGNUP_RATE_LIMIT,
  defaultCloudFrontWafRules,
  defaultCognitoWafRules,
  Waf,
} from "../../lib/shared-distribution-identity/waf.js";
import { cleanupTmpRoots, makeTestStack, makeUserPool } from "./fixtures.js";

afterAll(cleanupTmpRoots);

describe("Waf — defaults", () => {
  describe("defaultCloudFrontWafRules", () => {
    it("returns three rules", () => {
      expect(defaultCloudFrontWafRules()).toHaveLength(3);
    });

    it("rule 1 is a per-IP rate limit using the default", () => {
      const r = defaultCloudFrontWafRules()[0];
      expect(r?.priority).toBe(10);
      const stmt = r?.statement as { rateBasedStatement: { limit: number; aggregateKeyType: string } };
      expect(stmt.rateBasedStatement.limit).toBe(DEFAULT_CLOUDFRONT_RATE_LIMIT);
      expect(stmt.rateBasedStatement.aggregateKeyType).toBe("IP");
    });

    it("rule 2 is AWSManagedRulesCommonRuleSet", () => {
      const r = defaultCloudFrontWafRules()[1];
      const stmt = r?.statement as {
        managedRuleGroupStatement: { vendorName: string; name: string };
      };
      expect(stmt.managedRuleGroupStatement.name).toBe("AWSManagedRulesCommonRuleSet");
      expect(stmt.managedRuleGroupStatement.vendorName).toBe("AWS");
    });

    it("rule 3 is AWSManagedRulesKnownBadInputsRuleSet", () => {
      const r = defaultCloudFrontWafRules()[2];
      const stmt = r?.statement as {
        managedRuleGroupStatement: { vendorName: string; name: string };
      };
      expect(stmt.managedRuleGroupStatement.name).toBe(
        "AWSManagedRulesKnownBadInputsRuleSet",
      );
    });

    it("returns a fresh array on each call (no shared mutable state)", () => {
      const a = defaultCloudFrontWafRules();
      const b = defaultCloudFrontWafRules();
      expect(a).not.toBe(b);
    });

    it("honours the rateLimit override", () => {
      const r = defaultCloudFrontWafRules({ rateLimit: 42 });
      const stmt = r[0]?.statement as { rateBasedStatement: { limit: number } };
      expect(stmt.rateBasedStatement.limit).toBe(42);
    });
  });

  describe("defaultCognitoWafRules", () => {
    it("returns three rules", () => {
      expect(defaultCognitoWafRules()).toHaveLength(3);
    });

    it("rule 1 rate-limits InitiateAuth via x-amz-target scope-down", () => {
      const r = defaultCognitoWafRules()[0];
      expect(r?.priority).toBe(10);
      const stmt = r?.statement as {
        rateBasedStatement: {
          limit: number;
          scopeDownStatement: { byteMatchStatement: { searchString: string } };
        };
      };
      expect(stmt.rateBasedStatement.limit).toBe(
        DEFAULT_COGNITO_INITIATE_AUTH_RATE_LIMIT,
      );
      expect(stmt.rateBasedStatement.scopeDownStatement.byteMatchStatement.searchString).toBe(
        "InitiateAuth",
      );
    });

    it("rule 2 rate-limits SignUp", () => {
      const r = defaultCognitoWafRules()[1];
      const stmt = r?.statement as {
        rateBasedStatement: {
          limit: number;
          scopeDownStatement: { byteMatchStatement: { searchString: string } };
        };
      };
      expect(stmt.rateBasedStatement.limit).toBe(DEFAULT_COGNITO_SIGNUP_RATE_LIMIT);
      expect(stmt.rateBasedStatement.scopeDownStatement.byteMatchStatement.searchString).toBe(
        "SignUp",
      );
    });

    it("rule 3 is AWSManagedRulesAmazonIpReputationList", () => {
      const r = defaultCognitoWafRules()[2];
      const stmt = r?.statement as {
        managedRuleGroupStatement: { name: string };
      };
      expect(stmt.managedRuleGroupStatement.name).toBe(
        "AWSManagedRulesAmazonIpReputationList",
      );
    });

    it("honours both overrides", () => {
      const r = defaultCognitoWafRules({
        initiateAuthRateLimit: 11,
        signUpRateLimit: 22,
      });
      const init = r[0]?.statement as { rateBasedStatement: { limit: number } };
      const sign = r[1]?.statement as { rateBasedStatement: { limit: number } };
      expect(init.rateBasedStatement.limit).toBe(11);
      expect(sign.rateBasedStatement.limit).toBe(22);
    });
  });
});

describe("Waf — construct", () => {
  describe("defaults", () => {
    it("constructs both ACLs and associates the regional one with the pool", () => {
      const { stack } = makeTestStack();
      const pool = makeUserPool(stack);
      new Waf(stack, "Waf", { userPool: pool });
      const t = Template.fromStack(stack);

      // Two ACLs: one CLOUDFRONT, one REGIONAL.
      t.resourceCountIs("AWS::WAFv2::WebACL", 2);
      t.hasResourceProperties("AWS::WAFv2::WebACL", { Scope: "CLOUDFRONT" });
      t.hasResourceProperties("AWS::WAFv2::WebACL", { Scope: "REGIONAL" });

      // One association (pool → regional ACL).
      t.resourceCountIs("AWS::WAFv2::WebACLAssociation", 1);
    });

    it("CloudFront ACL has the three default rules", () => {
      const { stack } = makeTestStack();
      const pool = makeUserPool(stack);
      const w = new Waf(stack, "Waf", { userPool: pool });
      expect(w.cloudFrontWebAcl).toBeDefined();
      const acl = w.cloudFrontWebAcl!;
      const rules = acl.rules as cdk.aws_wafv2.CfnWebACL.RuleProperty[];
      expect(rules).toHaveLength(3);
    });

    it("Cognito ACL has the three default rules", () => {
      const { stack } = makeTestStack();
      const pool = makeUserPool(stack);
      const w = new Waf(stack, "Waf", { userPool: pool });
      const acl = w.cognitoPoolWebAcl!;
      const rules = acl.rules as cdk.aws_wafv2.CfnWebACL.RuleProperty[];
      expect(rules).toHaveLength(3);
    });

    it("exposes the constructed ACL ARNs", () => {
      const { stack } = makeTestStack();
      const pool = makeUserPool(stack);
      const w = new Waf(stack, "Waf", { userPool: pool });
      // Tokens, so just assert they're strings (CDK tokens stringify).
      expect(typeof w.cloudFrontWebAclArn).toBe("string");
      expect(typeof w.cognitoPoolWebAclArn).toBe("string");
    });
  });

  describe("overrides", () => {
    it("cloudFrontWebAclArn override skips the default creation", () => {
      const { stack } = makeTestStack();
      const pool = makeUserPool(stack);
      const w = new Waf(stack, "Waf", {
        userPool: pool,
        cloudFrontWebAclArn:
          "arn:aws:wafv2:us-east-1:111111111111:global/webacl/Bring/abcd",
      });
      const t = Template.fromStack(stack);
      // Only the regional ACL is created (1 instead of 2).
      t.resourceCountIs("AWS::WAFv2::WebACL", 1);
      t.hasResourceProperties("AWS::WAFv2::WebACL", { Scope: "REGIONAL" });
      expect(w.cloudFrontWebAcl).toBeUndefined();
      expect(w.cloudFrontWebAclArn).toContain("Bring");
    });

    it("cognitoPoolWebAclArn override skips the default creation", () => {
      const { stack } = makeTestStack();
      const w = new Waf(stack, "Waf", {
        cognitoPoolWebAclArn:
          "arn:aws:wafv2:eu-central-1:111111111111:regional/webacl/Bring/efgh",
      });
      const t = Template.fromStack(stack);
      // Only the CloudFront ACL is created.
      t.resourceCountIs("AWS::WAFv2::WebACL", 1);
      t.hasResourceProperties("AWS::WAFv2::WebACL", { Scope: "CLOUDFRONT" });
      // No association — the consumer is responsible for any
      // pre-existing association on their pre-built ACL.
      t.resourceCountIs("AWS::WAFv2::WebACLAssociation", 0);
      expect(w.cognitoPoolWebAcl).toBeUndefined();
    });

    it("both overrides → no ACLs constructed by this module", () => {
      const { stack } = makeTestStack();
      new Waf(stack, "Waf", {
        cloudFrontWebAclArn:
          "arn:aws:wafv2:us-east-1:111111111111:global/webacl/A/1",
        cognitoPoolWebAclArn:
          "arn:aws:wafv2:eu-central-1:111111111111:regional/webacl/B/2",
      });
      const t = Template.fromStack(stack);
      t.resourceCountIs("AWS::WAFv2::WebACL", 0);
    });

    it("throws when userPool is missing and cognitoPoolWebAclArn is not set", () => {
      const { stack } = makeTestStack();
      expect(() => new Waf(stack, "Waf", {})).toThrow(/userPool/);
    });

    it("respects rate-limit overrides at synth time", () => {
      const { stack } = makeTestStack();
      const pool = makeUserPool(stack);
      new Waf(stack, "Waf", {
        userPool: pool,
        cloudFrontRateLimit: 50,
        cognitoInitiateAuthRateLimit: 7,
        cognitoSignUpRateLimit: 3,
      });
      const t = Template.fromStack(stack);
      t.hasResourceProperties("AWS::WAFv2::WebACL", {
        Scope: "CLOUDFRONT",
        Rules: [
          {
            Priority: 10,
            Statement: {
              RateBasedStatement: { Limit: 50 },
            },
          },
          {},
          {},
        ],
      });
    });

    it("applies the removalPolicy override (RETAIN)", () => {
      const { stack } = makeTestStack();
      const pool = makeUserPool(stack);
      new Waf(stack, "Waf", {
        userPool: pool,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
      const t = Template.fromStack(stack);
      t.hasResource("AWS::WAFv2::WebACL", { DeletionPolicy: "Retain" });
    });
  });

  describe("MCP C4 — exact rule-group names", () => {
    it("CloudFront ACL uses the documented managed-rule names verbatim", () => {
      const cfRules = defaultCloudFrontWafRules();
      const names = cfRules
        .filter((r) => "managedRuleGroupStatement" in (r.statement as object))
        .map((r) => {
          const s = r.statement as {
            managedRuleGroupStatement: { name: string };
          };
          return s.managedRuleGroupStatement.name;
        });
      expect(names).toEqual([
        "AWSManagedRulesCommonRuleSet",
        "AWSManagedRulesKnownBadInputsRuleSet",
      ]);
    });

    it("Cognito ACL uses AWSManagedRulesAmazonIpReputationList", () => {
      const cogRules = defaultCognitoWafRules();
      const managed = cogRules.find(
        (r) => "managedRuleGroupStatement" in (r.statement as object),
      );
      const s = managed?.statement as {
        managedRuleGroupStatement: { name: string };
      };
      expect(s.managedRuleGroupStatement.name).toBe(
        "AWSManagedRulesAmazonIpReputationList",
      );
    });
  });
});
