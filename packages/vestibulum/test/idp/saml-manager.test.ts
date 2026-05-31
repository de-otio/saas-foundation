import { beforeEach, describe, it, expect } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  CognitoIdentityProviderClient,
  CreateIdentityProviderCommand,
  DeleteIdentityProviderCommand,
  DescribeIdentityProviderCommand,
  DescribeUserPoolClientCommand,
  ResourceNotFoundException,
  UpdateIdentityProviderCommand,
  UpdateUserPoolClientCommand,
} from "@aws-sdk/client-cognito-identity-provider";

import { SamlIdpManager } from "../../src/idp/saml-manager.js";
import { IdpManagerError, SamlMetadataError } from "../../src/errors.js";
import type { SamlMetadata } from "../../src/discovery/saml-metadata.js";

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const POOL_ID = "us-east-1_test12345";

const SIGNED_CERT_PEM = "-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----";

/** Construct a deterministic Date from a fixed ISO string (no Date.now() involved). */
// eslint-disable-next-line no-restricted-globals
const isoDate = (iso: string): Date => new Date(iso);

function makeMetadata(overrides: Partial<SamlMetadata> = {}): SamlMetadata {
  // Derive a consistent signatureStatus from isSigned in overrides
  // so existing tests need not be touched. The discriminated union
  // is the authoritative source (S-V7); the boolean is a convenience.
  const isSigned = overrides.isSigned ?? true;
  const defaultSignatureStatus: SamlMetadata["signatureStatus"] = isSigned
    ? { kind: "signed" }
    : { kind: "invalid_signature" };
  return {
    entityId: "urn:test:idp",
    ssoEndpoint: {
      binding: "HTTP-POST",
      location: "https://idp.example.com/sso",
    },
    signingCertificates: [
      {
        pem: SIGNED_CERT_PEM,
        notBefore: isoDate("2020-01-01T00:00:00Z"),
        notAfter: isoDate("2030-01-01T00:00:00Z"),
        fingerprintSha256: "abc123",
      },
    ],
    encryptionCertificates: [],
    nameIdFormats: ["urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"],
    isSigned,
    signatureStatus: defaultSignatureStatus,
    ...overrides,
  };
}

function makeManager(parseImpl?: (s: unknown) => Promise<SamlMetadata>): SamlIdpManager {
  return new SamlIdpManager({
    userPoolId: POOL_ID,
    region: "us-east-1",
    cognitoClient: new CognitoIdentityProviderClient({ region: "us-east-1" }),
    parseMetadata: parseImpl ?? (async () => makeMetadata()),
  });
}

beforeEach(() => {
  cognitoMock.reset();
});

describe("SamlIdpManager.constructor", () => {
  it("builds a default CognitoIdentityProviderClient when none supplied", () => {
    const m = new SamlIdpManager({
      userPoolId: POOL_ID,
      region: "us-east-1",
    });
    expect(m).toBeInstanceOf(SamlIdpManager);
  });

  it("uses the default parseSamlMetadata when no override is supplied", () => {
    // Just verifies the construction path; we don't actually
    // invoke parsing in this test (no XML supplied).
    const m = new SamlIdpManager({ userPoolId: POOL_ID, region: "us-east-1" });
    expect(m).toBeInstanceOf(SamlIdpManager);
  });
});

describe("SamlIdpManager.upsert", () => {
  it("creates a new IdP when none exists, using MetadataURL", async () => {
    cognitoMock
      .on(DescribeIdentityProviderCommand)
      .rejects(new ResourceNotFoundException({ message: "nope", $metadata: {} }));
    cognitoMock.on(CreateIdentityProviderCommand).resolves({});

    const manager = makeManager();
    const out = await manager.upsert({
      tenantId: "acme",
      metadata: { kind: "url", url: "https://idp.example.com/metadata" },
    });

    expect(out.cognitoIdpName).toMatch(/^tenant-acme/);
    expect(out.status).toBe("ACTIVE");
    expect(out.signingCertNotAfter).toEqual(isoDate("2030-01-01T00:00:00Z"));

    const call = cognitoMock.commandCalls(CreateIdentityProviderCommand)[0];
    expect(call!.args[0].input.ProviderType).toBe("SAML");
    expect(call!.args[0].input.ProviderDetails!["MetadataURL"]).toBe(
      "https://idp.example.com/metadata",
    );
    expect(call!.args[0].input.ProviderDetails!["MetadataFile"]).toBeUndefined();
    expect(call!.args[0].input.ProviderDetails!["IDPSignout"]).toBe("false");
    expect(call!.args[0].input.ProviderDetails!["RequestSigningAlgorithm"]).toBe("rsa-sha256");
  });

  it("creates a new IdP using MetadataFile when kind is xml", async () => {
    cognitoMock
      .on(DescribeIdentityProviderCommand)
      .rejects(new ResourceNotFoundException({ message: "nope", $metadata: {} }));
    cognitoMock.on(CreateIdentityProviderCommand).resolves({});

    const xml = '<?xml version="1.0"?><md:EntityDescriptor/>';
    const manager = makeManager();
    await manager.upsert({
      tenantId: "acme",
      metadata: { kind: "xml", xml },
    });

    const call = cognitoMock.commandCalls(CreateIdentityProviderCommand)[0];
    expect(call!.args[0].input.ProviderDetails!["MetadataFile"]).toBe(xml);
    expect(call!.args[0].input.ProviderDetails!["MetadataURL"]).toBeUndefined();
  });

  it("updates an existing IdP when one already exists at the derived name", async () => {
    cognitoMock
      .on(DescribeIdentityProviderCommand)
      .resolves({ IdentityProvider: { ProviderName: "tenant-acme" } });
    cognitoMock.on(UpdateIdentityProviderCommand).resolves({});

    const manager = makeManager();
    await manager.upsert({
      tenantId: "acme",
      metadata: { kind: "url", url: "https://idp.example.com/metadata" },
    });

    expect(cognitoMock.commandCalls(UpdateIdentityProviderCommand)).toHaveLength(1);
    expect(cognitoMock.commandCalls(CreateIdentityProviderCommand)).toHaveLength(0);
  });

  it("REFUSES unsigned metadata by default", async () => {
    const manager = makeManager(async () => makeMetadata({ isSigned: false }));

    await expect(
      manager.upsert({
        tenantId: "acme",
        metadata: { kind: "xml", xml: "<md:EntityDescriptor/>" },
      }),
    ).rejects.toMatchObject({
      reason: "unsigned",
    });
    expect(cognitoMock.commandCalls(CreateIdentityProviderCommand)).toHaveLength(0);
    expect(cognitoMock.commandCalls(UpdateIdentityProviderCommand)).toHaveLength(0);
  });

  it("accepts unsigned metadata when acceptUnsignedMetadata: true", async () => {
    cognitoMock
      .on(DescribeIdentityProviderCommand)
      .rejects(new ResourceNotFoundException({ message: "nope", $metadata: {} }));
    cognitoMock.on(CreateIdentityProviderCommand).resolves({});

    const manager = makeManager(async () => makeMetadata({ isSigned: false }));
    await manager.upsert({
      tenantId: "acme",
      metadata: { kind: "xml", xml: "<md:EntityDescriptor/>" },
      acceptUnsignedMetadata: true,
    });

    expect(cognitoMock.commandCalls(CreateIdentityProviderCommand)).toHaveLength(1);
  });

  it("rejects metadata with no signing certificate", async () => {
    const manager = makeManager(async () => makeMetadata({ signingCertificates: [] }));

    await expect(
      manager.upsert({
        tenantId: "acme",
        metadata: { kind: "xml", xml: "<md:EntityDescriptor/>" },
      }),
    ).rejects.toMatchObject({
      reason: "no_signing_cert",
    });
  });

  it("enables EncryptedResponses when the metadata advertises an encryption cert", async () => {
    cognitoMock
      .on(DescribeIdentityProviderCommand)
      .rejects(new ResourceNotFoundException({ message: "nope", $metadata: {} }));
    cognitoMock.on(CreateIdentityProviderCommand).resolves({});

    const manager = makeManager(async () =>
      makeMetadata({
        encryptionCertificates: [
          {
            pem: SIGNED_CERT_PEM,
            notBefore: isoDate("2020-01-01"),
            notAfter: isoDate("2030-01-01"),
            fingerprintSha256: "def456",
          },
        ],
      }),
    );

    await manager.upsert({
      tenantId: "acme",
      metadata: { kind: "url", url: "https://idp.example.com/metadata" },
    });

    const call = cognitoMock.commandCalls(CreateIdentityProviderCommand)[0];
    expect(call!.args[0].input.ProviderDetails!["EncryptedResponses"]).toBe("true");
  });

  it("disables EncryptedResponses when no encryption cert is present", async () => {
    cognitoMock
      .on(DescribeIdentityProviderCommand)
      .rejects(new ResourceNotFoundException({ message: "nope", $metadata: {} }));
    cognitoMock.on(CreateIdentityProviderCommand).resolves({});

    const manager = makeManager();
    await manager.upsert({
      tenantId: "acme",
      metadata: { kind: "url", url: "https://idp.example.com/metadata" },
    });

    const call = cognitoMock.commandCalls(CreateIdentityProviderCommand)[0];
    expect(call!.args[0].input.ProviderDetails!["EncryptedResponses"]).toBe("false");
  });

  it("honours explicit encryptAssertions override", async () => {
    cognitoMock
      .on(DescribeIdentityProviderCommand)
      .rejects(new ResourceNotFoundException({ message: "nope", $metadata: {} }));
    cognitoMock.on(CreateIdentityProviderCommand).resolves({});

    const manager = makeManager();
    await manager.upsert({
      tenantId: "acme",
      metadata: { kind: "url", url: "https://idp.example.com/metadata" },
      encryptAssertions: true,
    });

    const call = cognitoMock.commandCalls(CreateIdentityProviderCommand)[0];
    expect(call!.args[0].input.ProviderDetails!["EncryptedResponses"]).toBe("true");
  });

  it("honours explicit encryptAssertions: false override", async () => {
    cognitoMock
      .on(DescribeIdentityProviderCommand)
      .rejects(new ResourceNotFoundException({ message: "nope", $metadata: {} }));
    cognitoMock.on(CreateIdentityProviderCommand).resolves({});

    const manager = makeManager(async () =>
      makeMetadata({
        encryptionCertificates: [
          {
            pem: SIGNED_CERT_PEM,
            notBefore: isoDate("2020-01-01"),
            notAfter: isoDate("2030-01-01"),
            fingerprintSha256: "def456",
          },
        ],
      }),
    );
    await manager.upsert({
      tenantId: "acme",
      metadata: { kind: "url", url: "https://idp.example.com/metadata" },
      encryptAssertions: false,
    });

    const call = cognitoMock.commandCalls(CreateIdentityProviderCommand)[0];
    expect(call!.args[0].input.ProviderDetails!["EncryptedResponses"]).toBe("false");
  });

  it("merges consumer attribute-mapping overrides over defaults", async () => {
    cognitoMock
      .on(DescribeIdentityProviderCommand)
      .rejects(new ResourceNotFoundException({ message: "nope", $metadata: {} }));
    cognitoMock.on(CreateIdentityProviderCommand).resolves({});

    const manager = makeManager();
    await manager.upsert({
      tenantId: "acme",
      metadata: { kind: "url", url: "https://idp.example.com/metadata" },
      attributeMapping: {
        "custom:idpGroups": "http://schemas.microsoft.com/ws/2008/06/identity/claims/role",
        email: "http://example.com/mail", // override default
      },
    });

    const call = cognitoMock.commandCalls(CreateIdentityProviderCommand)[0];
    expect(call!.args[0].input.AttributeMapping).toMatchObject({
      email: "http://example.com/mail",
      family_name: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
      "custom:idpGroups": "http://schemas.microsoft.com/ws/2008/06/identity/claims/role",
    });
  });

  it("returns metadataExpiresAt and signingCertNotAfter for admin alerts", async () => {
    cognitoMock
      .on(DescribeIdentityProviderCommand)
      .rejects(new ResourceNotFoundException({ message: "nope", $metadata: {} }));
    cognitoMock.on(CreateIdentityProviderCommand).resolves({});

    const validUntil = isoDate("2030-06-01T00:00:00Z");
    const certNotAfter = isoDate("2028-01-01T00:00:00Z");
    const manager = makeManager(async () =>
      makeMetadata({
        validUntil,
        signingCertificates: [
          {
            pem: SIGNED_CERT_PEM,
            notBefore: isoDate("2020-01-01"),
            notAfter: certNotAfter,
            fingerprintSha256: "abc",
          },
        ],
      }),
    );

    const out = await manager.upsert({
      tenantId: "acme",
      metadata: { kind: "url", url: "https://idp.example.com/metadata" },
    });

    expect(out.metadataExpiresAt).toEqual(validUntil);
    expect(out.signingCertNotAfter).toEqual(certNotAfter);
  });

  it("reports earliest cert notAfter across signing + encryption certs", async () => {
    cognitoMock
      .on(DescribeIdentityProviderCommand)
      .rejects(new ResourceNotFoundException({ message: "nope", $metadata: {} }));
    cognitoMock.on(CreateIdentityProviderCommand).resolves({});

    const earlier = isoDate("2025-01-01T00:00:00Z");
    const later = isoDate("2030-01-01T00:00:00Z");
    const manager = makeManager(async () =>
      makeMetadata({
        signingCertificates: [
          {
            pem: SIGNED_CERT_PEM,
            notBefore: isoDate("2020-01-01"),
            notAfter: later,
            fingerprintSha256: "a",
          },
        ],
        encryptionCertificates: [
          {
            pem: SIGNED_CERT_PEM,
            notBefore: isoDate("2020-01-01"),
            notAfter: earlier,
            fingerprintSha256: "b",
          },
        ],
      }),
    );

    const out = await manager.upsert({
      tenantId: "acme",
      metadata: { kind: "url", url: "https://idp.example.com/metadata" },
    });

    expect(out.signingCertNotAfter).toEqual(earlier);
  });

  it("rejects too many IdpIdentifiers (>50)", async () => {
    const manager = makeManager();
    const tooMany = Array.from({ length: 51 }, (_, i) => `d${i}.example`);
    await expect(
      manager.upsert({
        tenantId: "acme",
        metadata: { kind: "url", url: "https://idp.example.com/metadata" },
        idpIdentifiers: tooMany,
      }),
    ).rejects.toBeInstanceOf(IdpManagerError);
  });

  it("rejects IdpIdentifier entries that are too long", async () => {
    const manager = makeManager();
    await expect(
      manager.upsert({
        tenantId: "acme",
        metadata: { kind: "url", url: "https://idp.example.com/metadata" },
        idpIdentifiers: ["a".repeat(41)],
      }),
    ).rejects.toMatchObject({ reason: "idp_identifier_invalid" });
  });

  it("rejects IdpIdentifier entries that violate the Cognito regex", async () => {
    const manager = makeManager();
    await expect(
      manager.upsert({
        tenantId: "acme",
        metadata: { kind: "url", url: "https://idp.example.com/metadata" },
        idpIdentifiers: ["bad/slash"],
      }),
    ).rejects.toMatchObject({ reason: "idp_identifier_invalid" });
  });

  it("rejects empty IdpIdentifier entries", async () => {
    const manager = makeManager();
    await expect(
      manager.upsert({
        tenantId: "acme",
        metadata: { kind: "url", url: "https://idp.example.com/metadata" },
        idpIdentifiers: [""],
      }),
    ).rejects.toMatchObject({ reason: "idp_identifier_invalid" });
  });
});

describe("SamlIdpManager.get", () => {
  it("returns undefined when the IdP does not exist", async () => {
    cognitoMock
      .on(DescribeIdentityProviderCommand)
      .rejects(new ResourceNotFoundException({ message: "nope", $metadata: {} }));

    const manager = makeManager();
    expect(await manager.get("acme")).toBeUndefined();
  });

  it("returns the record when the IdP exists", async () => {
    const fixedDate = isoDate("2026-05-23T00:00:00Z");
    cognitoMock.on(DescribeIdentityProviderCommand).resolves({
      IdentityProvider: { ProviderName: "tenant-acme", LastModifiedDate: fixedDate },
    });

    const manager = makeManager();
    const out = await manager.get("acme");
    expect(out).toMatchObject({
      tenantId: "acme",
      status: "ACTIVE",
      lastSyncedAt: fixedDate,
    });
  });

  it("falls back to current Date when LastModifiedDate is missing", async () => {
    cognitoMock.on(DescribeIdentityProviderCommand).resolves({
      IdentityProvider: { ProviderName: "tenant-acme" },
    });

    const manager = makeManager();
    const out = await manager.get("acme");
    // eslint-disable-next-line no-restricted-globals
    expect(out?.lastSyncedAt).toBeInstanceOf(Date);
  });

  it("propagates non-NotFound errors from describe", async () => {
    cognitoMock.on(DescribeIdentityProviderCommand).rejects(new Error("throttled"));

    const manager = makeManager();
    await expect(manager.get("acme")).rejects.toThrow(/throttled/);
  });

  it("returns undefined when describe returns no IdentityProvider", async () => {
    cognitoMock.on(DescribeIdentityProviderCommand).resolves({});

    const manager = makeManager();
    expect(await manager.get("acme")).toBeUndefined();
  });
});

describe("SamlIdpManager.delete", () => {
  it("deletes the IdP", async () => {
    cognitoMock.on(DeleteIdentityProviderCommand).resolves({});

    const manager = makeManager();
    await manager.delete("acme");

    expect(cognitoMock.commandCalls(DeleteIdentityProviderCommand)).toHaveLength(1);
  });

  it("is idempotent — NotFound during delete is treated as success", async () => {
    cognitoMock
      .on(DeleteIdentityProviderCommand)
      .rejects(new ResourceNotFoundException({ message: "gone", $metadata: {} }));

    const manager = makeManager();
    await expect(manager.delete("acme")).resolves.toBeUndefined();
  });

  it("propagates non-NotFound delete errors", async () => {
    cognitoMock.on(DeleteIdentityProviderCommand).rejects(new Error("throttled"));

    const manager = makeManager();
    await expect(manager.delete("acme")).rejects.toThrow(/throttled/);
  });

  it("detaches from supplied app clients before deleting", async () => {
    cognitoMock.on(DescribeUserPoolClientCommand).resolves({
      UserPoolClient: {
        ClientId: "app-1",
        SupportedIdentityProviders: ["COGNITO", "tenant-acme"],
      },
    });
    cognitoMock.on(UpdateUserPoolClientCommand).resolves({});
    cognitoMock.on(DeleteIdentityProviderCommand).resolves({});

    const manager = makeManager();
    await manager.delete("acme", ["app-1"]);

    const updateCalls = cognitoMock.commandCalls(UpdateUserPoolClientCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.args[0].input).toMatchObject({
      ClientId: "app-1",
      SupportedIdentityProviders: ["COGNITO"],
    });
  });

  it("skips detach if the app client is missing", async () => {
    cognitoMock
      .on(DescribeUserPoolClientCommand)
      .rejects(new ResourceNotFoundException({ message: "gone", $metadata: {} }));
    cognitoMock.on(DeleteIdentityProviderCommand).resolves({});

    const manager = makeManager();
    await manager.delete("acme", ["app-missing"]);

    expect(cognitoMock.commandCalls(UpdateUserPoolClientCommand)).toHaveLength(0);
  });

  it("skips detach if the IdP name was not on the app client", async () => {
    cognitoMock.on(DescribeUserPoolClientCommand).resolves({
      UserPoolClient: { ClientId: "app-1", SupportedIdentityProviders: ["COGNITO"] },
    });
    cognitoMock.on(DeleteIdentityProviderCommand).resolves({});

    const manager = makeManager();
    await manager.delete("acme", ["app-1"]);

    expect(cognitoMock.commandCalls(UpdateUserPoolClientCommand)).toHaveLength(0);
  });

  it("propagates non-NotFound errors during describe-while-detaching", async () => {
    cognitoMock.on(DescribeUserPoolClientCommand).rejects(new Error("throttled"));

    const manager = makeManager();
    await expect(manager.delete("acme", ["app-1"])).rejects.toThrow(/throttled/);
  });

  it("skips detach when describe returns an empty UserPoolClient field", async () => {
    cognitoMock.on(DescribeUserPoolClientCommand).resolves({});
    cognitoMock.on(DeleteIdentityProviderCommand).resolves({});

    const manager = makeManager();
    await manager.delete("acme", ["app-1"]);

    expect(cognitoMock.commandCalls(UpdateUserPoolClientCommand)).toHaveLength(0);
  });

  it("treats undefined SupportedIdentityProviders as empty (detach skips)", async () => {
    cognitoMock.on(DescribeUserPoolClientCommand).resolves({
      UserPoolClient: { ClientId: "app-1" /* no SupportedIdentityProviders */ },
    });
    cognitoMock.on(DeleteIdentityProviderCommand).resolves({});

    const manager = makeManager();
    await manager.delete("acme", ["app-1"]);

    expect(cognitoMock.commandCalls(UpdateUserPoolClientCommand)).toHaveLength(0);
  });
});

describe("SamlIdpManager.attachToAppClients", () => {
  it("appends the IdP name to existing SupportedIdentityProviders", async () => {
    cognitoMock.on(DescribeUserPoolClientCommand).resolves({
      UserPoolClient: { ClientId: "app-1", SupportedIdentityProviders: ["COGNITO"] },
    });
    cognitoMock.on(UpdateUserPoolClientCommand).resolves({});

    const manager = makeManager();
    await manager.attachToAppClients("acme", ["app-1"]);

    const call = cognitoMock.commandCalls(UpdateUserPoolClientCommand)[0];
    expect(call!.args[0].input.SupportedIdentityProviders).toEqual([
      "COGNITO",
      expect.stringMatching(/^tenant-/),
    ]);
  });

  it("is idempotent (no duplicate entries)", async () => {
    cognitoMock.on(DescribeUserPoolClientCommand).resolves({
      UserPoolClient: {
        ClientId: "app-1",
        SupportedIdentityProviders: ["COGNITO", "tenant-acme"],
      },
    });

    const manager = makeManager();
    await manager.attachToAppClients("acme", ["app-1"]);

    expect(cognitoMock.commandCalls(UpdateUserPoolClientCommand)).toHaveLength(0);
  });

  it("throws IdpManagerError(not_found) when the app client is missing", async () => {
    cognitoMock.on(DescribeUserPoolClientCommand).resolves({});

    const manager = makeManager();
    await expect(manager.attachToAppClients("acme", ["app-missing"])).rejects.toThrow(
      IdpManagerError,
    );
  });

  it("treats undefined SupportedIdentityProviders as empty (attach)", async () => {
    cognitoMock.on(DescribeUserPoolClientCommand).resolves({
      UserPoolClient: { ClientId: "app-1" /* no SupportedIdentityProviders */ },
    });
    cognitoMock.on(UpdateUserPoolClientCommand).resolves({});

    const manager = makeManager();
    await manager.attachToAppClients("acme", ["app-1"]);

    const call = cognitoMock.commandCalls(UpdateUserPoolClientCommand)[0];
    expect(call!.args[0].input.SupportedIdentityProviders).toEqual([
      expect.stringMatching(/^tenant-/),
    ]);
  });
});

describe("SamlMetadataError surface", () => {
  it("exposes the reason discriminant", () => {
    const err = new SamlMetadataError("unsigned", "detail");
    expect(err.reason).toBe("unsigned");
  });
});
