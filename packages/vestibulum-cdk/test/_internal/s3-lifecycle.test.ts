/**
 * Unit tests for the shared S3 lifecycle helper (cost-pillar S4).
 *
 * The helper is consumed by `MagicLinkAuthSite` and
 * `CloudFrontDistribution`; the integration tests in those constructs'
 * suites verify the rendered CFN. These tests cover the merge semantic
 * in isolation so the override behaviour is unambiguous.
 */

import { Duration, aws_s3 as s3 } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";

import {
  type BucketLifecycleProps,
  defaultGeneralBucketLifecycleRules,
  defaultImmutableAssetLifecycleRules,
  resolveLifecycleRules,
} from "../../lib/_internal/s3-lifecycle.js";

describe("defaultImmutableAssetLifecycleRules", () => {
  it("returns a single rule", () => {
    const rules = defaultImmutableAssetLifecycleRules();
    expect(rules).toHaveLength(1);
  });

  it("aborts incomplete multipart uploads after 7 days", () => {
    const [rule] = defaultImmutableAssetLifecycleRules();
    expect(rule?.abortIncompleteMultipartUploadAfter?.toDays()).toBe(7);
  });

  it("transitions to Standard-IA (INFREQUENT_ACCESS) after 30 days", () => {
    const [rule] = defaultImmutableAssetLifecycleRules();
    expect(rule?.transitions).toHaveLength(1);
    const transition = rule?.transitions?.[0];
    expect(transition?.storageClass).toBe(s3.StorageClass.INFREQUENT_ACCESS);
    expect(transition?.transitionAfter?.toDays()).toBe(30);
  });

  it("expires noncurrent versions after 90 days", () => {
    const [rule] = defaultImmutableAssetLifecycleRules();
    expect(rule?.noncurrentVersionExpiration?.toDays()).toBe(90);
  });

  it("is enabled by default", () => {
    const [rule] = defaultImmutableAssetLifecycleRules();
    expect(rule?.enabled).toBe(true);
  });

  it("has a stable rule id (for diff stability across releases)", () => {
    const [rule] = defaultImmutableAssetLifecycleRules();
    expect(rule?.id).toBe("vestibulum-immutable-assets-lifecycle");
  });

  it("returns a fresh array on every call (no shared mutable state)", () => {
    const a = defaultImmutableAssetLifecycleRules();
    const b = defaultImmutableAssetLifecycleRules();
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
  });
});

describe("defaultGeneralBucketLifecycleRules", () => {
  it("returns a single rule with abort + noncurrent expiry but no transition", () => {
    const rules = defaultGeneralBucketLifecycleRules();
    expect(rules).toHaveLength(1);
    const [rule] = rules;
    expect(rule?.abortIncompleteMultipartUploadAfter?.toDays()).toBe(7);
    expect(rule?.noncurrentVersionExpiration?.toDays()).toBe(90);
    expect(rule?.transitions).toBeUndefined();
  });
});

describe("resolveLifecycleRules", () => {
  const defaults = defaultImmutableAssetLifecycleRules();

  it("returns the defaults when override is undefined", () => {
    expect(resolveLifecycleRules(undefined, defaults)).toBe(defaults);
  });

  it("returns the defaults when override.rules is undefined", () => {
    const override: BucketLifecycleProps = {};
    expect(resolveLifecycleRules(override, defaults)).toBe(defaults);
  });

  it("returns an empty array when override.rules is the empty array (disabled)", () => {
    const override: BucketLifecycleProps = { rules: [] };
    const result = resolveLifecycleRules(override, defaults);
    expect(result).toEqual([]);
  });

  it("returns the consumer rules when override.rules is non-empty (replace)", () => {
    const consumerRule: s3.LifecycleRule = {
      id: "consumer-rule",
      expiration: Duration.days(365),
    };
    const override: BucketLifecycleProps = { rules: [consumerRule] };
    const result = resolveLifecycleRules(override, defaults);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(consumerRule);
  });

  it("does not mutate the defaults when override is supplied", () => {
    const snapshot = JSON.parse(JSON.stringify(defaults)) as unknown;
    resolveLifecycleRules({ rules: [] }, defaults);
    expect(JSON.parse(JSON.stringify(defaults))).toEqual(snapshot);
  });
});
