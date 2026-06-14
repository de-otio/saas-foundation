import { describe, it, expect } from "vitest";
import {
  validateHostedUiDomainProps,
  extractAcmRegion,
  COGNITO_DOMAIN_PREFIX_REGEX,
} from "../../lib/hosted-ui-domain/index.js";

describe("hosted-ui-domain", () => {
  describe("extractAcmRegion", () => {
    it("extracts region from a well-formed ACM ARN", () => {
      expect(extractAcmRegion("arn:aws:acm:us-east-1:123456789012:certificate/abc-123")).toBe(
        "us-east-1",
      );
    });

    it("extracts eu-west-1 region", () => {
      expect(extractAcmRegion("arn:aws:acm:eu-west-1:123456789012:certificate/xyz-456")).toBe(
        "eu-west-1",
      );
    });

    it("returns undefined for a CDK token", () => {
      expect(
        extractAcmRegion("arn:aws:acm:${Token[AWS.Region.4]}:123456789012:certificate/abc"),
      ).toBeUndefined();
    });

    it("returns undefined for a malformed ARN", () => {
      expect(extractAcmRegion("not-an-arn")).toBeUndefined();
    });

    it("returns undefined for a non-ACM ARN", () => {
      expect(extractAcmRegion("arn:aws:iam::123456789012:role/MyRole")).toBeUndefined();
    });
  });

  describe("COGNITO_DOMAIN_PREFIX_REGEX", () => {
    it("accepts valid prefixes", () => {
      expect(COGNITO_DOMAIN_PREFIX_REGEX.test("my-app")).toBe(true);
      expect(COGNITO_DOMAIN_PREFIX_REGEX.test("acme-prod-auth")).toBe(true);
      expect(COGNITO_DOMAIN_PREFIX_REGEX.test("app123")).toBe(true);
    });

    it("rejects invalid prefixes", () => {
      expect(COGNITO_DOMAIN_PREFIX_REGEX.test("-leading")).toBe(false);
      expect(COGNITO_DOMAIN_PREFIX_REGEX.test("trailing-")).toBe(false);
      expect(COGNITO_DOMAIN_PREFIX_REGEX.test("under_score")).toBe(false);
      expect(COGNITO_DOMAIN_PREFIX_REGEX.test("UPPER")).toBe(false);
      expect(COGNITO_DOMAIN_PREFIX_REGEX.test("")).toBe(false);
    });
  });

  describe("validateHostedUiDomainProps", () => {
    it("passes for a valid cognito prefix", () => {
      expect(() =>
        validateHostedUiDomainProps({ kind: "cognito", prefix: "my-app-auth" }),
      ).not.toThrow();
    });

    it("throws for an invalid cognito prefix", () => {
      expect(() => validateHostedUiDomainProps({ kind: "cognito", prefix: "INVALID" })).toThrow(
        /invalid/i,
      );
    });

    it("passes for a valid custom domain", () => {
      expect(() =>
        validateHostedUiDomainProps({
          kind: "custom",
          domainName: "auth.example.com",
          acmCertArn: "arn:aws:acm:us-east-1:123456789012:certificate/abc-123",
        }),
      ).not.toThrow();
    });

    it("throws for empty domainName", () => {
      expect(() =>
        validateHostedUiDomainProps({
          kind: "custom",
          domainName: "",
          acmCertArn: "arn:aws:acm:us-east-1:123456789012:certificate/abc-123",
        }),
      ).toThrow(/domainName/);
    });

    it("throws for empty acmCertArn", () => {
      expect(() =>
        validateHostedUiDomainProps({
          kind: "custom",
          domainName: "auth.example.com",
          acmCertArn: "",
        }),
      ).toThrow(/acmCertArn/);
    });
  });
});
