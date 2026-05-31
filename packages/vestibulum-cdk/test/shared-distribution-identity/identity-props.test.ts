/**
 * Prop-variation tests for `SharedDistributionIdentity`.
 *
 * Each test exercises a distinct prop combination and asserts the
 * resulting CFn template has the right shape.
 */

import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as sns from "aws-cdk-lib/aws-sns";
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RESERVED_SUBDOMAINS,
  DEFAULT_TENANT_SUBDOMAIN_PATTERN,
  SharedDistributionIdentity,
  SharedDistributionIdentityPropsError,
  type SharedDistributionIdentityProps,
} from "../../lib/shared-distribution-identity/index.js";
import { WildcardCertConfigError } from "../../lib/shared-distribution-identity/wildcard-cert.js";

const TEST_ENV = { account: "123456789012", region: "us-east-1" };

// ---------------------------------------------------------------------------
// Typed helpers for CDK template assertions
// ---------------------------------------------------------------------------

interface DdbTableResource {
  Properties?: {
    SSESpecification?: { SSEEnabled?: boolean; SSEType?: string; KMSMasterKeyId?: unknown };
    TimeToLiveSpecification?: { AttributeName?: string };
  };
}

interface CognitoPoolResource {
  Properties?: {
    UserPoolAddOns?: unknown;
  };
}

interface CertResource {
  Properties?: {
    SubjectAlternativeNames?: unknown;
  };
}

function findDdbTables(template: Template): Record<string, DdbTableResource> {
  return template.findResources("AWS::DynamoDB::Table") as Record<string, DdbTableResource>;
}

function findCognitoPools(template: Template): Record<string, CognitoPoolResource> {
  return template.findResources("AWS::Cognito::UserPool") as Record<string, CognitoPoolResource>;
}

function findCerts(template: Template): Record<string, CertResource> {
  return template.findResources("AWS::CertificateManager::Certificate") as Record<string, CertResource>;
}

function makeStack(name: string): cdk.Stack {
  const app = new cdk.App();
  return new cdk.Stack(app, name, { env: TEST_ENV, stackName: name });
}

function defaultProps(
  stack: cdk.Stack,
  overrides: Partial<SharedDistributionIdentityProps> = {},
): SharedDistributionIdentityProps {
  return {
    tenantSubdomainParent: "tenants.example.com",
    sesIdentitySender: "noreply@tenants.example.com",
    hostedZone: route53.HostedZone.fromHostedZoneAttributes(stack, "Zone", {
      hostedZoneId: "Z123456789",
      zoneName: "tenants.example.com",
    }),
    adminInvokePrincipal: new iam.AccountPrincipal("123456789012"),
    // Skip esbuild in unit tests — avoids staging-dir resolution issues.
    _skipEdgeBundle: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Customer-managed KMS key
// ---------------------------------------------------------------------------

describe("SharedDistributionIdentity — tableKmsKey", () => {
  it("applies customer-managed key to ClientConfig + MagicLinkTokens", () => {
    const stack = makeStack("KmsStack");
    const key = new kms.Key(stack, "TableKey", {
      enableKeyRotation: true,
    });

    new SharedDistributionIdentity(stack, "Identity", defaultProps(stack, {
      tableKmsKey: key,
    }));

    const template = Template.fromStack(stack);
    const tables = findDdbTables(template);
    const cmkTables = Object.values(tables).filter(
      (t) =>
        t.Properties?.SSESpecification?.SSEEnabled === true &&
        t.Properties?.SSESpecification?.KMSMasterKeyId !== undefined &&
        t.Properties?.SSESpecification?.SSEType === "KMS",
    );
    // ClientConfig + MagicLinkTokens both use the KMS key (2 tables);
    // Reservations stays AWS_MANAGED.
    expect(cmkTables.length).toBe(2);
  });

  it("Reservations table stays AWS_MANAGED even with tableKmsKey set", () => {
    const stack = makeStack("KmsReservationsStack");
    const key = new kms.Key(stack, "TableKey", { enableKeyRotation: true });

    new SharedDistributionIdentity(stack, "Identity", defaultProps(stack, {
      tableKmsKey: key,
    }));

    const template = Template.fromStack(stack);
    const tables = findDdbTables(template);
    // Find the reservations table (TTL attribute 'expiresAt')
    const reservations = Object.values(tables).find(
      (t) => t.Properties?.TimeToLiveSpecification?.AttributeName === "expiresAt",
    );
    expect(reservations).toBeDefined();
    // AWS_MANAGED means SSEEnabled is true but no KMSMasterKeyId; the
    // L2 emits SSESpecification with no KMSMasterKeyId in that case.
    const sse = reservations?.Properties?.SSESpecification;
    expect(sse?.KMSMasterKeyId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// existingWildcardCertificateArn
// ---------------------------------------------------------------------------

describe("SharedDistributionIdentity — existingWildcardCertificateArn", () => {
  it("imports an existing cert when ARN is provided (no new cert resource)", () => {
    const stack = makeStack("ImportCertStack");
    new SharedDistributionIdentity(stack, "Identity", {
      tenantSubdomainParent: "tenants.example.com",
      sesIdentitySender: "noreply@tenants.example.com",
      existingWildcardCertificateArn:
        "arn:aws:acm:us-east-1:123456789012:certificate/abcd-1234",
      adminInvokePrincipal: new iam.AccountPrincipal("123456789012"),
      _skipEdgeBundle: true,
    });

    const template = Template.fromStack(stack);
    // No new cert created.
    template.resourceCountIs("AWS::CertificateManager::Certificate", 0);
  });

  it("exposes the imported cert ARN unchanged on the construct", () => {
    const stack = makeStack("ImportCertExposeStack");
    const importedArn =
      "arn:aws:acm:us-east-1:123456789012:certificate/abcd-1234";
    const identity = new SharedDistributionIdentity(stack, "Identity", {
      tenantSubdomainParent: "tenants.example.com",
      sesIdentitySender: "noreply@tenants.example.com",
      existingWildcardCertificateArn: importedArn,
      adminInvokePrincipal: new iam.AccountPrincipal("123456789012"),
      _skipEdgeBundle: true,
    });

    expect(identity.wildcardCertificateArn).toBe(importedArn);
  });

  it("rejects setting BOTH hostedZone AND existingWildcardCertificateArn", () => {
    const stack = makeStack("BothCertStack");
    expect(() => {
      new SharedDistributionIdentity(stack, "Identity", {
        tenantSubdomainParent: "tenants.example.com",
        sesIdentitySender: "noreply@tenants.example.com",
        hostedZone: route53.HostedZone.fromHostedZoneAttributes(stack, "Zone", {
          hostedZoneId: "Z123456789",
          zoneName: "tenants.example.com",
        }),
        existingWildcardCertificateArn:
          "arn:aws:acm:us-east-1:123456789012:certificate/abcd-1234",
        adminInvokePrincipal: new iam.AccountPrincipal("123456789012"),
      });
    }).toThrowError(WildcardCertConfigError);
  });

  it("rejects when NEITHER hostedZone NOR existingWildcardCertificateArn is set", () => {
    const stack = makeStack("NoCertStack");
    expect(() => {
      new SharedDistributionIdentity(stack, "Identity", {
        tenantSubdomainParent: "tenants.example.com",
        sesIdentitySender: "noreply@tenants.example.com",
        adminInvokePrincipal: new iam.AccountPrincipal("123456789012"),
      });
    }).toThrowError(WildcardCertConfigError);
  });
});

// ---------------------------------------------------------------------------
// tenantSubdomainPattern + reservedSubdomains overrides
// ---------------------------------------------------------------------------

describe("SharedDistributionIdentity — subdomain customisation", () => {
  it("uses default pattern when prop is unset", () => {
    const stack = makeStack("DefaultPatternStack");
    const identity = new SharedDistributionIdentity(
      stack,
      "Identity",
      defaultProps(stack),
    );
    expect(identity.tenantSubdomainPattern).toBe(
      DEFAULT_TENANT_SUBDOMAIN_PATTERN,
    );
  });

  it("uses default reserved list when prop is unset", () => {
    const stack = makeStack("DefaultReservedStack");
    const identity = new SharedDistributionIdentity(
      stack,
      "Identity",
      defaultProps(stack),
    );
    expect([...identity.reservedSubdomains]).toEqual([
      ...DEFAULT_RESERVED_SUBDOMAINS,
    ]);
  });

  it("applies a custom tenantSubdomainPattern", () => {
    const stack = makeStack("CustomPatternStack");
    const customPattern = /^t[0-9]{4}$/;
    const identity = new SharedDistributionIdentity(
      stack,
      "Identity",
      defaultProps(stack, { tenantSubdomainPattern: customPattern }),
    );
    expect(identity.tenantSubdomainPattern).toBe(customPattern);
    expect(identity.tenantSubdomainPattern.test("t1234")).toBe(true);
    expect(identity.tenantSubdomainPattern.test("acme")).toBe(false);
  });

  it("applies a custom reservedSubdomains list", () => {
    const stack = makeStack("CustomReservedStack");
    const reserved = ["foo", "bar"];
    const identity = new SharedDistributionIdentity(
      stack,
      "Identity",
      defaultProps(stack, { reservedSubdomains: reserved }),
    );
    expect([...identity.reservedSubdomains]).toEqual(reserved);
    // Defaults NOT merged in — explicit override replaces the list.
    expect(identity.reservedSubdomains).not.toContain("admin");
  });
});

// ---------------------------------------------------------------------------
// idTokenValidity + jwksTtl validation
// ---------------------------------------------------------------------------

describe("SharedDistributionIdentity — duration props", () => {
  it("accepts a custom idTokenValidity above the floor", () => {
    const stack = makeStack("CustomIdTokenStack");
    const identity = new SharedDistributionIdentity(
      stack,
      "Identity",
      defaultProps(stack, { idTokenValidity: Duration.minutes(30) }),
    );
    expect(identity.idTokenValidity.toMinutes()).toBe(30);
  });

  it("rejects idTokenValidity < 5 min (Cognito floor)", () => {
    const stack = makeStack("BadIdTokenStack");
    expect(() => {
      new SharedDistributionIdentity(
        stack,
        "Identity",
        defaultProps(stack, { idTokenValidity: Duration.minutes(2) }),
      );
    }).toThrowError(SharedDistributionIdentityPropsError);
  });

  it("accepts a custom jwksTtl above the floor", () => {
    const stack = makeStack("CustomJwksTtlStack");
    const identity = new SharedDistributionIdentity(
      stack,
      "Identity",
      defaultProps(stack, { jwksTtl: Duration.minutes(5) }),
    );
    expect(identity.jwksTtl.toMinutes()).toBe(5);
  });

  it("rejects jwksTtl < 1 min", () => {
    const stack = makeStack("BadJwksTtlStack");
    expect(() => {
      new SharedDistributionIdentity(
        stack,
        "Identity",
        defaultProps(stack, { jwksTtl: Duration.seconds(30) }),
      );
    }).toThrowError(SharedDistributionIdentityPropsError);
  });
});

// ---------------------------------------------------------------------------
// Advanced security
// ---------------------------------------------------------------------------

describe("SharedDistributionIdentity — advancedSecurity", () => {
  it("defaults to 'audit' (shared-pool posture)", () => {
    const stack = makeStack("DefaultAdvSecStack");
    const identity = new SharedDistributionIdentity(
      stack,
      "Identity",
      defaultProps(stack),
    );
    expect(identity.advancedSecurity).toBe("audit");
  });

  it("can be set to 'off' to opt out", () => {
    const stack = makeStack("OffAdvSecStack");
    const identity = new SharedDistributionIdentity(
      stack,
      "Identity",
      defaultProps(stack, { advancedSecurity: "off" }),
    );
    expect(identity.advancedSecurity).toBe("off");
    const template = Template.fromStack(stack);
    // Pool should not have UserPoolAddOns when off.
    const pools = findCognitoPools(template);
    for (const [, p] of Object.entries(pools)) {
      expect(p.Properties?.UserPoolAddOns).toBeUndefined();
    }
  });

  it("can be set to 'enforced' to block on risk events", () => {
    const stack = makeStack("EnforcedAdvSecStack");
    new SharedDistributionIdentity(
      stack,
      "Identity",
      defaultProps(stack, { advancedSecurity: "enforced" }),
    );
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      UserPoolAddOns: Match.objectLike({
        AdvancedSecurityMode: "ENFORCED",
      }),
    });
  });
});

// ---------------------------------------------------------------------------
// SAN overrides
// ---------------------------------------------------------------------------

describe("SharedDistributionIdentity — certificateSubjectAlternativeNames", () => {
  it("includes the parent in the SAN list by default", () => {
    const stack = makeStack("DefaultSanStack");
    new SharedDistributionIdentity(
      stack,
      "Identity",
      defaultProps(stack),
    );
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::CertificateManager::Certificate", {
      SubjectAlternativeNames: Match.arrayWith(["tenants.example.com"]),
    });
  });

  it("omits the parent when an empty SAN list is provided", () => {
    const stack = makeStack("EmptySanStack");
    new SharedDistributionIdentity(
      stack,
      "Identity",
      defaultProps(stack, { certificateSubjectAlternativeNames: [] }),
    );
    const template = Template.fromStack(stack);
    const certs = findCerts(template);
    for (const [, c] of Object.entries(certs)) {
      expect(c.Properties?.SubjectAlternativeNames).toBeUndefined();
    }
  });

  it("applies a custom SAN list verbatim", () => {
    const stack = makeStack("CustomSanStack");
    new SharedDistributionIdentity(
      stack,
      "Identity",
      defaultProps(stack, {
        certificateSubjectAlternativeNames: [
          "tenants.example.com",
          "static.example.com",
        ],
      }),
    );
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::CertificateManager::Certificate", {
      SubjectAlternativeNames: Match.arrayWith([
        "tenants.example.com",
        "static.example.com",
      ]),
    });
  });
});

// ---------------------------------------------------------------------------
// removalPolicy override
// ---------------------------------------------------------------------------

describe("SharedDistributionIdentity — userPoolRemovalPolicy", () => {
  it("retains the user pool by default", () => {
    const stack = makeStack("DefaultRemovalStack");
    new SharedDistributionIdentity(stack, "Identity", defaultProps(stack));
    Template.fromStack(stack).hasResource("AWS::Cognito::UserPool", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  it("can be set to DESTROY for ephemeral envs", () => {
    const stack = makeStack("DestroyRemovalStack");
    new SharedDistributionIdentity(
      stack,
      "Identity",
      defaultProps(stack, { userPoolRemovalPolicy: RemovalPolicy.DESTROY }),
    );
    Template.fromStack(stack).hasResource("AWS::Cognito::UserPool", {
      DeletionPolicy: "Delete",
      UpdateReplacePolicy: "Delete",
    });
  });
});

// ---------------------------------------------------------------------------
// Required-prop validation
// ---------------------------------------------------------------------------

describe("SharedDistributionIdentity — required-prop validation", () => {
  it("rejects an empty tenantSubdomainParent", () => {
    const stack = makeStack("EmptyParentStack");
    expect(() => {
      new SharedDistributionIdentity(stack, "Identity", {
        ...defaultProps(stack),
        tenantSubdomainParent: "",
      });
    }).toThrowError(SharedDistributionIdentityPropsError);
  });

  it("rejects a sesIdentitySender that is not an email address", () => {
    const stack = makeStack("BadSenderStack");
    expect(() => {
      new SharedDistributionIdentity(stack, "Identity", {
        ...defaultProps(stack),
        sesIdentitySender: "not-an-email",
      });
    }).toThrowError(/sesIdentitySender/);
  });
});

// ---------------------------------------------------------------------------
// alarmTopic and perTenantMetrics propagation (held for P2c)
// ---------------------------------------------------------------------------

describe("SharedDistributionIdentity — observability prop pass-through", () => {
  it("stores the alarmTopic for P2c consumption", () => {
    const stack = makeStack("AlarmTopicStack");
    const topic = new sns.Topic(stack, "AlarmTopic");
    const identity = new SharedDistributionIdentity(
      stack,
      "Identity",
      defaultProps(stack, { alarmTopic: topic }),
    );
    expect(identity.alarmTopic).toBe(topic);
  });

  it("perTenantMetrics defaults to false", () => {
    const stack = makeStack("DefaultMetricsStack");
    const identity = new SharedDistributionIdentity(
      stack,
      "Identity",
      defaultProps(stack),
    );
    expect(identity.perTenantMetrics).toBe(false);
  });

  it("perTenantMetrics can be enabled", () => {
    const stack = makeStack("PerTenantMetricsStack");
    const identity = new SharedDistributionIdentity(
      stack,
      "Identity",
      defaultProps(stack, { perTenantMetrics: true }),
    );
    expect(identity.perTenantMetrics).toBe(true);
  });
});
