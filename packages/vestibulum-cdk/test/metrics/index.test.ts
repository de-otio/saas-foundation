import { describe, it, expect } from "vitest";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import {
  buildIdentityMetrics,
  buildAuthSiteMetrics,
  buildSharedDistributionMetrics,
  DEFAULT_METRICS_NAMESPACE,
  DEFAULT_METRIC_PERIOD,
} from "../../lib/metrics/index.js";

describe("metrics", () => {
  describe("constants", () => {
    it("DEFAULT_METRICS_NAMESPACE is Vestibulum/AuthSite", () => {
      expect(DEFAULT_METRICS_NAMESPACE).toBe("Vestibulum/AuthSite");
    });

    it("DEFAULT_METRIC_PERIOD is 1 minute", () => {
      expect(DEFAULT_METRIC_PERIOD.toMinutes()).toBe(1);
    });
  });

  describe("buildIdentityMetrics", () => {
    it("returns all expected metric keys", () => {
      const metrics = buildIdentityMetrics({ userPoolId: "eu-west-1_AbCdEfGhI" });
      expect(metrics).toHaveProperty("signUpSuccesses");
      expect(metrics).toHaveProperty("signInSuccesses");
      expect(metrics).toHaveProperty("tokenRefreshSuccesses");
      expect(metrics).toHaveProperty("challengeFailures");
      expect(metrics).toHaveProperty("preSignUpRejections");
      expect(metrics).toHaveProperty("sesBounceRate");
      expect(metrics).toHaveProperty("sesComplaintRate");
    });

    it("returns cloudwatch.Metric instances", () => {
      const metrics = buildIdentityMetrics({ userPoolId: "eu-west-1_AbCdEfGhI" });
      expect(metrics.signUpSuccesses).toBeInstanceOf(cloudwatch.Metric);
      expect(metrics.challengeFailures).toBeInstanceOf(cloudwatch.Metric);
    });

    it("uses the default namespace when none supplied", () => {
      const metrics = buildIdentityMetrics({ userPoolId: "eu-west-1_AbCdEfGhI" });
      expect(metrics.signUpSuccesses.namespace).toBe(DEFAULT_METRICS_NAMESPACE);
    });

    it("uses a custom namespace when supplied", () => {
      const metrics = buildIdentityMetrics({
        userPoolId: "eu-west-1_AbCdEfGhI",
        metricsNamespace: "MyProduct/Auth",
      });
      expect(metrics.signUpSuccesses.namespace).toBe("MyProduct/Auth");
    });

    it("SES metrics use the AWS/SES namespace", () => {
      const metrics = buildIdentityMetrics({ userPoolId: "eu-west-1_AbCdEfGhI" });
      expect(metrics.sesBounceRate.namespace).toBe("AWS/SES");
      expect(metrics.sesComplaintRate.namespace).toBe("AWS/SES");
    });

    describe("tenantId dimension", () => {
      it("preSignUpRejections does NOT have TenantId when tenantId is absent", () => {
        const metrics = buildIdentityMetrics({ userPoolId: "eu-west-1_AbCdEfGhI" });
        expect(metrics.preSignUpRejections.dimensions).not.toHaveProperty("TenantId");
      });

      it("preSignUpRejections carries TenantId when tenantId is provided", () => {
        const metrics = buildIdentityMetrics({
          userPoolId: "eu-west-1_AbCdEfGhI",
          tenantId: "acme",
        });
        expect(metrics.preSignUpRejections.dimensions).toMatchObject({ TenantId: "acme" });
      });

      it("Cognito service metrics do NOT carry TenantId even when tenantId is provided", () => {
        const metrics = buildIdentityMetrics({
          userPoolId: "eu-west-1_AbCdEfGhI",
          tenantId: "acme",
        });
        expect(metrics.signUpSuccesses.dimensions).not.toHaveProperty("TenantId");
        expect(metrics.signInSuccesses.dimensions).not.toHaveProperty("TenantId");
        expect(metrics.tokenRefreshSuccesses.dimensions).not.toHaveProperty("TenantId");
        expect(metrics.challengeFailures.dimensions).not.toHaveProperty("TenantId");
      });

      it("SES metrics do NOT carry TenantId even when tenantId is provided", () => {
        const metrics = buildIdentityMetrics({
          userPoolId: "eu-west-1_AbCdEfGhI",
          tenantId: "acme",
        });
        // SES metrics have no dimensions (undefined or empty object) — either
        // way, TenantId must not be present.
        const bounceRateDims = metrics.sesBounceRate.dimensions ?? {};
        const complaintRateDims = metrics.sesComplaintRate.dimensions ?? {};
        expect(bounceRateDims).not.toHaveProperty("TenantId");
        expect(complaintRateDims).not.toHaveProperty("TenantId");
      });

      it("preSignUpRejections retains UserPoolId alongside TenantId", () => {
        const metrics = buildIdentityMetrics({
          userPoolId: "eu-west-1_AbCdEfGhI",
          tenantId: "acme",
        });
        expect(metrics.preSignUpRejections.dimensions).toMatchObject({
          UserPoolId: "eu-west-1_AbCdEfGhI",
          TenantId: "acme",
        });
      });
    });
  });

  describe("buildAuthSiteMetrics", () => {
    it("returns all expected metric keys", () => {
      const metrics = buildAuthSiteMetrics({ distributionId: "ABCDEF123456" });
      expect(metrics).toHaveProperty("distributionRequests");
      expect(metrics).toHaveProperty("distributionErrors");
      expect(metrics).toHaveProperty("edgeAuthDenies");
      expect(metrics).toHaveProperty("authVerifyErrors");
    });

    it("returns cloudwatch.Metric instances", () => {
      const metrics = buildAuthSiteMetrics({ distributionId: "ABCDEF123456" });
      expect(metrics.distributionRequests).toBeInstanceOf(cloudwatch.Metric);
      expect(metrics.edgeAuthDenies).toBeInstanceOf(cloudwatch.Metric);
    });

    it("uses the default namespace for custom metrics", () => {
      const metrics = buildAuthSiteMetrics({ distributionId: "ABCDEF123456" });
      expect(metrics.edgeAuthDenies.namespace).toBe(DEFAULT_METRICS_NAMESPACE);
    });

    it("uses a custom namespace when supplied", () => {
      const metrics = buildAuthSiteMetrics({
        distributionId: "ABCDEF123456",
        metricsNamespace: "MyProduct/Auth",
      });
      expect(metrics.edgeAuthDenies.namespace).toBe("MyProduct/Auth");
    });

    it("CloudFront metrics use the AWS/CloudFront namespace", () => {
      const metrics = buildAuthSiteMetrics({ distributionId: "ABCDEF123456" });
      expect(metrics.distributionRequests.namespace).toBe("AWS/CloudFront");
      expect(metrics.distributionErrors.namespace).toBe("AWS/CloudFront");
    });

    describe("tenantId dimension", () => {
      it("authVerifyErrors does NOT have TenantId when tenantId is absent", () => {
        const metrics = buildAuthSiteMetrics({ distributionId: "ABCDEF123456" });
        expect(metrics.authVerifyErrors.dimensions).not.toHaveProperty("TenantId");
      });

      it("authVerifyErrors carries TenantId when tenantId is provided", () => {
        const metrics = buildAuthSiteMetrics({
          distributionId: "ABCDEF123456",
          tenantId: "acme",
        });
        expect(metrics.authVerifyErrors.dimensions).toMatchObject({ TenantId: "acme" });
      });

      it("edgeAuthDenies does NOT carry TenantId even when tenantId is provided", () => {
        const metrics = buildAuthSiteMetrics({
          distributionId: "ABCDEF123456",
          tenantId: "acme",
        });
        expect(metrics.edgeAuthDenies.dimensions).not.toHaveProperty("TenantId");
      });

      it("authVerifyErrors retains DistributionId alongside TenantId", () => {
        const metrics = buildAuthSiteMetrics({
          distributionId: "ABCDEF123456",
          tenantId: "acme",
        });
        expect(metrics.authVerifyErrors.dimensions).toMatchObject({
          DistributionId: "ABCDEF123456",
          TenantId: "acme",
        });
      });
    });
  });

  describe("buildSharedDistributionMetrics", () => {
    const baseInput = {
      tenantId: "acme",
      userPoolId: "eu-west-1_AbCdEfGhI",
      distributionId: "ABCDEF123456",
    };

    it("returns all expected metric keys", () => {
      const metrics = buildSharedDistributionMetrics(baseInput);
      expect(metrics).toHaveProperty("preSignUpRejections");
      expect(metrics).toHaveProperty("authVerifyErrors");
    });

    it("returns cloudwatch.Metric instances", () => {
      const metrics = buildSharedDistributionMetrics(baseInput);
      expect(metrics.preSignUpRejections).toBeInstanceOf(cloudwatch.Metric);
      expect(metrics.authVerifyErrors).toBeInstanceOf(cloudwatch.Metric);
    });

    it("uses the default namespace when none supplied", () => {
      const metrics = buildSharedDistributionMetrics(baseInput);
      expect(metrics.preSignUpRejections.namespace).toBe(DEFAULT_METRICS_NAMESPACE);
      expect(metrics.authVerifyErrors.namespace).toBe(DEFAULT_METRICS_NAMESPACE);
    });

    it("uses a custom namespace when supplied", () => {
      const metrics = buildSharedDistributionMetrics({
        ...baseInput,
        metricsNamespace: "MyProduct/SharedAuth",
      });
      expect(metrics.preSignUpRejections.namespace).toBe("MyProduct/SharedAuth");
      expect(metrics.authVerifyErrors.namespace).toBe("MyProduct/SharedAuth");
    });

    it("preSignUpRejections carries TenantId and UserPoolId dimensions", () => {
      const metrics = buildSharedDistributionMetrics(baseInput);
      expect(metrics.preSignUpRejections.dimensions).toMatchObject({
        TenantId: "acme",
        UserPoolId: "eu-west-1_AbCdEfGhI",
      });
    });

    it("authVerifyErrors carries TenantId and DistributionId dimensions", () => {
      const metrics = buildSharedDistributionMetrics(baseInput);
      expect(metrics.authVerifyErrors.dimensions).toMatchObject({
        TenantId: "acme",
        DistributionId: "ABCDEF123456",
      });
    });

    it("different tenants produce different TenantId dimension values", () => {
      const acme = buildSharedDistributionMetrics({ ...baseInput, tenantId: "acme" });
      const beta = buildSharedDistributionMetrics({ ...baseInput, tenantId: "beta" });
      expect(acme.preSignUpRejections.dimensions).toMatchObject({ TenantId: "acme" });
      expect(beta.preSignUpRejections.dimensions).toMatchObject({ TenantId: "beta" });
    });
  });
});
