import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as route53 from "aws-cdk-lib/aws-route53";
import { beforeAll, describe, expect, it } from "vitest";

import {
  EdgeResources,
  EdgeResourcesRegionError,
  DEFAULT_AUTH_VERIFY_RATE_LIMIT,
  DEFAULT_LOGIN_RATE_LIMIT,
  defaultWafRules,
} from "../../lib/edge-resources/index.js";

const TEST_ENV = { account: "123456789012", region: "us-east-1" };

function makeStack(name: string, region: string = "us-east-1"): cdk.Stack {
  const app = new cdk.App();
  return new cdk.Stack(app, name, {
    env: { account: TEST_ENV.account, region },
    stackName: name,
  });
}

function makeZone(stack: cdk.Stack): route53.IHostedZone {
  return route53.HostedZone.fromHostedZoneAttributes(stack, "Zone", {
    hostedZoneId: "Z123456789EXAMPLE",
    zoneName: "example.com",
  });
}

describe("EdgeResources", () => {
  describe("default props in us-east-1", () => {
    let template: Template;
    let edge: EdgeResources;

    beforeAll(() => {
      const stack = makeStack("EdgeDefaultStack");
      edge = new EdgeResources(stack, "Edge", {
        domain: "app.example.com",
        hostedZone: makeZone(stack),
      });
      template = Template.fromStack(stack);
    });

    it("creates exactly one ACM Certificate", () => {
      template.resourceCountIs("AWS::CertificateManager::Certificate", 1);
    });

    it("creates exactly one WAFv2 Web ACL", () => {
      template.resourceCountIs("AWS::WAFv2::WebACL", 1);
    });

    it("ACM certificate has DNS validation for the supplied domain", () => {
      template.hasResourceProperties("AWS::CertificateManager::Certificate", {
        DomainName: "app.example.com",
        ValidationMethod: "DNS",
      });
    });

    it("Web ACL is in CLOUDFRONT scope with default Allow action", () => {
      template.hasResourceProperties("AWS::WAFv2::WebACL", {
        Scope: "CLOUDFRONT",
        DefaultAction: { Allow: {} },
      });
    });

    it("Web ACL metric name uses the default 'Vestibulum' prefix and safe-encoded domain", () => {
      template.hasResourceProperties("AWS::WAFv2::WebACL", {
        VisibilityConfig: {
          MetricName: "VestibulumWaf-app-example-com",
          CloudWatchMetricsEnabled: true,
          SampledRequestsEnabled: true,
        },
      });
    });

    it("exposes the resolved namespace and prefix as readonly props", () => {
      expect(edge.metricsNamespace).toBe("Vestibulum/AuthSite");
      expect(edge.resourceNamePrefix).toBe("Vestibulum");
    });

    it("certificate and Web ACL have RemovalPolicy DESTROY", () => {
      template.hasResource("AWS::CertificateManager::Certificate", {
        DeletionPolicy: "Delete",
        UpdateReplacePolicy: "Delete",
      });
      template.hasResource("AWS::WAFv2::WebACL", {
        DeletionPolicy: "Delete",
      });
    });
  });

  describe("default WAF rule set (B-G, S-C8)", () => {
    it("B-G: does NOT include AWSManagedRulesATPRuleSet by default", () => {
      const rules = defaultWafRules();
      const atp = rules.find((r) => JSON.stringify(r).includes("AWSManagedRulesATPRuleSet"));
      expect(atp).toBeUndefined();
    });

    it("S-C8: rate-limit on /auth-verify defaults to 60 / 5min / IP", () => {
      const rules = defaultWafRules();
      const rateLimit = rules.find((r) => r.name.endsWith("AuthRateLimit"));
      expect(rateLimit).toBeDefined();
      expect(DEFAULT_AUTH_VERIFY_RATE_LIMIT).toBe(60);
      const stmt = rateLimit?.statement as {
        rateBasedStatement?: {
          limit?: number;
          evaluationWindowSec?: number;
          scopeDownStatement?: {
            byteMatchStatement?: { searchString?: string };
          };
        };
      };
      expect(stmt.rateBasedStatement?.limit).toBe(60);
      expect(stmt.rateBasedStatement?.evaluationWindowSec).toBe(300);
      expect(stmt.rateBasedStatement?.scopeDownStatement?.byteMatchStatement?.searchString).toBe(
        "/auth-verify",
      );
    });

    it("includes the looser login rate-limit at 200 / 5min / IP", () => {
      const rules = defaultWafRules();
      const login = rules.find((r) => r.name.endsWith("LoginRateLimit"));
      expect(login).toBeDefined();
      expect(DEFAULT_LOGIN_RATE_LIMIT).toBe(200);
      const stmt = login?.statement as {
        rateBasedStatement?: { limit?: number };
      };
      expect(stmt.rateBasedStatement?.limit).toBe(200);
    });

    it("includes the three baseline managed rule groups at priorities 10/20/30", () => {
      const rules = defaultWafRules();
      const byPriority = new Map(rules.map((r) => [r.priority, r.name]));
      expect(byPriority.get(10)).toBe("AWS-AWSManagedRulesCommonRuleSet");
      expect(byPriority.get(20)).toBe("AWS-AWSManagedRulesKnownBadInputsRuleSet");
      expect(byPriority.get(30)).toBe("AWS-AWSManagedRulesAmazonIpReputationList");
    });

    it("returns a fresh array each call (no shared mutable state)", () => {
      const a = defaultWafRules();
      const b = defaultWafRules();
      expect(a).not.toBe(b);
      a.length = 0;
      expect(b.length).toBeGreaterThan(0);
    });
  });

  describe("S-C12: branding override", () => {
    it("resourceNamePrefix override flows into rate-limit rule names", () => {
      const rules = defaultWafRules({ resourceNamePrefix: "Acme" });
      const rateLimit = rules.find((r) => r.name.endsWith("AuthRateLimit"));
      expect(rateLimit?.name).toBe("AcmeAuthRateLimit");
      const login = rules.find((r) => r.name.endsWith("LoginRateLimit"));
      expect(login?.name).toBe("AcmeLoginRateLimit");
    });

    it("EdgeResources passes the override through to the Web ACL metric name", () => {
      const stack = makeStack("EdgeBrandedStack");
      new EdgeResources(stack, "Edge", {
        domain: "auth.acme.example",
        hostedZone: makeZone(stack),
        resourceNamePrefix: "Acme",
        metricsNamespace: "Acme/Auth",
      });
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::WAFv2::WebACL", {
        VisibilityConfig: Match.objectLike({
          MetricName: "AcmeWaf-auth-acme-example",
        }),
      });
    });

    it("empty resourceNamePrefix falls back to default", () => {
      const stack = makeStack("EdgeEmptyPrefixStack");
      const edge = new EdgeResources(stack, "Edge", {
        domain: "app.example.com",
        hostedZone: makeZone(stack),
        resourceNamePrefix: "",
      });
      expect(edge.resourceNamePrefix).toBe("Vestibulum");
    });
  });

  describe("S-C8: rate-limit prop overrides", () => {
    it("authVerifyRateLimit prop overrides the default", () => {
      const stack = makeStack("EdgeCustomRateStack");
      new EdgeResources(stack, "Edge", {
        domain: "app.example.com",
        hostedZone: makeZone(stack),
        authVerifyRateLimit: 30,
        loginRateLimit: 100,
      });
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::WAFv2::WebACL", {
        Rules: Match.arrayWith([
          Match.objectLike({
            Name: "VestibulumAuthRateLimit",
            Statement: Match.objectLike({
              RateBasedStatement: Match.objectLike({ Limit: 30 }),
            }),
          }),
          Match.objectLike({
            Name: "VestibulumLoginRateLimit",
            Statement: Match.objectLike({
              RateBasedStatement: Match.objectLike({ Limit: 100 }),
            }),
          }),
        ]),
      });
    });
  });

  describe("extraWafManagedRuleGroups (opt-in paid groups)", () => {
    it("appends consumer-supplied rule groups to the default set", () => {
      const stack = makeStack("EdgeATPStack");
      new EdgeResources(stack, "Edge", {
        domain: "app.example.com",
        hostedZone: makeZone(stack),
        extraWafManagedRuleGroups: [{ name: "AWSManagedRulesATPRuleSet", priority: 100 }],
      });
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::WAFv2::WebACL", {
        Rules: Match.arrayWith([
          Match.objectLike({
            Name: "AWS-AWSManagedRulesATPRuleSet",
            Priority: 100,
          }),
        ]),
      });
    });
  });

  describe("region guard", () => {
    it("throws EdgeResourcesRegionError when stack region is not us-east-1", () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, "EdgeWrongRegionStack", {
        env: { account: TEST_ENV.account, region: "eu-west-1" },
      });
      expect(
        () =>
          new EdgeResources(stack, "Edge", {
            domain: "app.example.com",
            hostedZone: makeZone(stack),
          }),
      ).toThrowError(EdgeResourcesRegionError);
    });

    it("tolerates token regions (unit tests with env: undefined)", () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, "EdgeTokenRegionStack");
      expect(
        () =>
          new EdgeResources(stack, "Edge", {
            domain: "app.example.com",
            hostedZone: makeZone(stack),
          }),
      ).not.toThrow();
    });

    it("EdgeResourcesRegionError carries the offending region", () => {
      const err = new EdgeResourcesRegionError("eu-central-1");
      expect(err.name).toBe("EdgeResourcesRegionError");
      expect(err.message).toContain("eu-central-1");
      expect(err.message).toContain("us-east-1");
    });
  });

  describe("wafManagedRules override", () => {
    it("replaces the default rule set entirely", () => {
      const stack = makeStack("EdgeCustomRulesStack");
      new EdgeResources(stack, "Edge", {
        domain: "app.example.com",
        hostedZone: makeZone(stack),
        wafManagedRules: [
          {
            name: "OnlyRule",
            priority: 99,
            action: { block: {} },
            statement: {
              ipSetReferenceStatement: { arn: "arn:aws:wafv2:::ipset/example" },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: "OnlyRule",
              sampledRequestsEnabled: true,
            },
          },
        ],
      });
      const template = Template.fromStack(stack);
      const acl = template.findResources("AWS::WAFv2::WebACL");
      const rules = (Object.values(acl)[0]?.Properties as { Rules: unknown[] }).Rules;
      expect(rules.length).toBe(1);
    });
  });

  describe("subjectAlternativeNames", () => {
    it("forwards SANs to the ACM certificate", () => {
      const stack = makeStack("EdgeSANStack");
      new EdgeResources(stack, "Edge", {
        domain: "app.example.com",
        hostedZone: makeZone(stack),
        subjectAlternativeNames: ["auth.example.com"],
      });
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::CertificateManager::Certificate", {
        DomainName: "app.example.com",
        SubjectAlternativeNames: ["auth.example.com"],
      });
    });
  });
});
