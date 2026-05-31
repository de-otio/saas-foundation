/**
 * Tests for the default `ResponseHeadersPolicy` factory.
 *
 * Per `doc/vestibulum/shared-distribution/04-multi-aud-edge-check.md` §
 * Security headers: HSTS preload 2y, tight CSP, X-Frame-Options DENY,
 * X-Content-Type-Options nosniff, Referrer-Policy
 * strict-origin-when-cross-origin, Permissions-Policy default-disabled.
 */

import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import {
  createDefaultResponseHeadersPolicy,
  DEFAULT_CONTENT_SECURITY_POLICY,
  DEFAULT_HSTS_MAX_AGE_DAYS,
  DEFAULT_PERMISSIONS_POLICY,
} from "../../lib/shared-distribution-identity/security-headers.js";

function synth(): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "S", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  createDefaultResponseHeadersPolicy(stack, "Policy");
  return Template.fromStack(stack);
}

describe("security-headers", () => {
  describe("DEFAULT_CONTENT_SECURITY_POLICY", () => {
    it("blocks frame-ancestors", () => {
      expect(DEFAULT_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    });

    it("denies remote scripts", () => {
      expect(DEFAULT_CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    });

    it("does not contain 'unsafe-eval'", () => {
      expect(DEFAULT_CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
    });

    it("does not allow script-src unsafe-inline", () => {
      expect(DEFAULT_CONTENT_SECURITY_POLICY).not.toMatch(/script-src[^;]*unsafe-inline/);
    });

    it("restricts form-action to self", () => {
      expect(DEFAULT_CONTENT_SECURITY_POLICY).toContain("form-action 'self'");
    });

    it("pins base-uri to 'none'", () => {
      expect(DEFAULT_CONTENT_SECURITY_POLICY).toContain("base-uri 'none'");
    });
  });

  describe("DEFAULT_PERMISSIONS_POLICY", () => {
    it("disables camera, geolocation, microphone, payment, accelerometer", () => {
      for (const f of ["camera", "geolocation", "microphone", "payment", "accelerometer"]) {
        expect(DEFAULT_PERMISSIONS_POLICY).toContain(`${f}=()`);
      }
    });
  });

  describe("HSTS settings", () => {
    it("DEFAULT_HSTS_MAX_AGE_DAYS = 730 (2 years)", () => {
      expect(DEFAULT_HSTS_MAX_AGE_DAYS).toBe(730);
    });
  });

  describe("createDefaultResponseHeadersPolicy", () => {
    it("creates exactly one ResponseHeadersPolicy", () => {
      const t = synth();
      t.resourceCountIs("AWS::CloudFront::ResponseHeadersPolicy", 1);
    });

    it("HSTS includeSubdomains: true, preload: true, max-age 730d in seconds", () => {
      const t = synth();
      t.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
        ResponseHeadersPolicyConfig: {
          SecurityHeadersConfig: {
            StrictTransportSecurity: {
              AccessControlMaxAgeSec: 730 * 24 * 60 * 60,
              IncludeSubdomains: true,
              Preload: true,
              Override: true,
            },
          },
        },
      });
    });

    it("X-Frame-Options DENY", () => {
      const t = synth();
      t.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
        ResponseHeadersPolicyConfig: {
          SecurityHeadersConfig: {
            FrameOptions: { FrameOption: "DENY", Override: true },
          },
        },
      });
    });

    it("X-Content-Type-Options nosniff (Override: true on ContentTypeOptions)", () => {
      const t = synth();
      t.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
        ResponseHeadersPolicyConfig: {
          SecurityHeadersConfig: {
            ContentTypeOptions: { Override: true },
          },
        },
      });
    });

    it("Referrer-Policy strict-origin-when-cross-origin", () => {
      const t = synth();
      t.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
        ResponseHeadersPolicyConfig: {
          SecurityHeadersConfig: {
            ReferrerPolicy: {
              ReferrerPolicy: "strict-origin-when-cross-origin",
              Override: true,
            },
          },
        },
      });
    });

    it("emits the default CSP body", () => {
      const t = synth();
      t.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
        ResponseHeadersPolicyConfig: {
          SecurityHeadersConfig: {
            ContentSecurityPolicy: {
              ContentSecurityPolicy: DEFAULT_CONTENT_SECURITY_POLICY,
              Override: true,
            },
          },
        },
      });
    });

    it("emits Permissions-Policy as a custom header", () => {
      const t = synth();
      t.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
        ResponseHeadersPolicyConfig: {
          CustomHeadersConfig: {
            Items: [
              {
                Header: "Permissions-Policy",
                Value: DEFAULT_PERMISSIONS_POLICY,
                Override: true,
              },
            ],
          },
        },
      });
    });

    it("respects contentSecurityPolicy override", () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, "S2");
      createDefaultResponseHeadersPolicy(stack, "Policy", {
        contentSecurityPolicy: "default-src 'none'",
      });
      const t = Template.fromStack(stack);
      t.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
        ResponseHeadersPolicyConfig: {
          SecurityHeadersConfig: {
            ContentSecurityPolicy: {
              ContentSecurityPolicy: "default-src 'none'",
            },
          },
        },
      });
    });

    it("name uses the configured prefix", () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, "S3");
      createDefaultResponseHeadersPolicy(stack, "Policy", {
        resourceNamePrefix: "AcmeCo",
      });
      const t = Template.fromStack(stack);
      const policies = t.findResources("AWS::CloudFront::ResponseHeadersPolicy");
      const names = Object.values(policies).map(
        (p: { Properties: { ResponseHeadersPolicyConfig: { Name: string } } }) =>
          p.Properties.ResponseHeadersPolicyConfig.Name,
      );
      expect(names[0]).toMatch(/^AcmeCo-SecurityHeaders-/);
    });
  });
});
