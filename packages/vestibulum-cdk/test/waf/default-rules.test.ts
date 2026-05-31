import { describe, it, expect } from "vitest";
import { defaultWafRules } from "../../lib/waf/default-rules.js";

describe("defaultWafRules", () => {
  it("returns an array", () => {
    expect(Array.isArray(defaultWafRules())).toBe(true);
  });

  it("returns a fresh array on each call (no shared reference)", () => {
    const a = defaultWafRules();
    const b = defaultWafRules();
    expect(a).not.toBe(b);
  });

  it("contains AWSManagedRulesCommonRuleSet", () => {
    const rules = defaultWafRules();
    const names = rules.map((r) => r.name);
    expect(names).toContain("AWS-AWSManagedRulesCommonRuleSet");
  });

  it("contains AWSManagedRulesKnownBadInputsRuleSet", () => {
    const rules = defaultWafRules();
    const names = rules.map((r) => r.name);
    expect(names).toContain("AWS-AWSManagedRulesKnownBadInputsRuleSet");
  });

  it("contains AWSManagedRulesAmazonIpReputationList", () => {
    const rules = defaultWafRules();
    const names = rules.map((r) => r.name);
    expect(names).toContain("AWS-AWSManagedRulesAmazonIpReputationList");
  });

  it("does NOT contain ATPRuleSet (B-G: paid rule removed)", () => {
    const rules = defaultWafRules();
    const names = rules.map((r) => r.name);
    expect(names.some((n) => n.includes("ATP"))).toBe(false);
  });

  it("contains a rate-limit rule", () => {
    const rules = defaultWafRules();
    const hasRateLimit = rules.some(
      (r) =>
        typeof r.statement === "object" &&
        r.statement !== null &&
        "rateBasedStatement" in r.statement,
    );
    expect(hasRateLimit).toBe(true);
  });

  it("has all rules with cloudWatchMetricsEnabled: true", () => {
    const rules = defaultWafRules();
    for (const rule of rules) {
      expect(rule.visibilityConfig.cloudWatchMetricsEnabled).toBe(true);
    }
  });

  it("has non-duplicate priorities", () => {
    const rules = defaultWafRules();
    const priorities = rules.map((r) => r.priority);
    const uniquePriorities = new Set(priorities);
    expect(uniquePriorities.size).toBe(priorities.length);
  });
});
