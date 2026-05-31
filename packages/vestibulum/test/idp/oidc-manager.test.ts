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
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

import { OidcIdpManager } from "../../src/idp/oidc-manager.js";
import { IdpSecretsClient } from "../../src/secrets/secrets-client.js";
import { IdpManagerError } from "../../src/errors.js";

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const secretsMock = mockClient(SecretsManagerClient);

const POOL_ID = "us-east-1_test12345";
const PLAINTEXT_SECRET = "super-secret-OIDC-client-shhhhh";

/** Construct a deterministic Date from a fixed ISO string (no Date.now() involved). */
// eslint-disable-next-line no-restricted-globals
const isoDate = (iso: string): Date => new Date(iso);

function makeManager(): OidcIdpManager {
  const secretsClient = new IdpSecretsClient({
    secretPrefix: "/vestibulum/idp/test-app/",
    secretsClient: new SecretsManagerClient({ region: "us-east-1" }),
  });
  return new OidcIdpManager({
    userPoolId: POOL_ID,
    region: "us-east-1",
    secretsClient,
    cognitoClient: new CognitoIdentityProviderClient({ region: "us-east-1" }),
  });
}

const TEST_SECRET_ARN =
  "arn:aws:secretsmanager:us-east-1:111111111111:secret:/vestibulum/idp/test-app/oidc-client-secret/acme-AbCdEf";
const TEST_SECRET_VERSION = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  cognitoMock.reset();
  secretsMock.reset();
  // Default: any get on secrets returns the test plaintext, ARN, and
  // a pinned VersionId — the manager (S-V2) propagates the version
  // into `OidcIdpRecord.clientSecret`.
  secretsMock.on(GetSecretValueCommand).resolves({
    SecretString: PLAINTEXT_SECRET,
    ARN: TEST_SECRET_ARN,
    VersionId: TEST_SECRET_VERSION,
  });
});

describe("OidcIdpManager.upsert", () => {
  it("creates a new IdP when none exists, passing the LITERAL secret to Cognito", async () => {
    cognitoMock
      .on(DescribeIdentityProviderCommand)
      .rejects(new ResourceNotFoundException({ message: "nope", $metadata: {} }));
    cognitoMock.on(CreateIdentityProviderCommand).resolves({});

    const manager = makeManager();
    const out = await manager.upsert({
      tenantId: "acme",
      issuer: "https://login.example.com/",
      clientId: "client-123",
      clientSecretArn:
        "arn:aws:secretsmanager:us-east-1:111111111111:secret:/vestibulum/idp/test-app/oidc-client-secret/acme-AbCdEf",
    });

    expect(out.cognitoIdpName).toMatch(/^tenant-acme/);
    expect(out.status).toBe("ACTIVE");
    expect(out.tenantId).toBe("acme");
    // S-V2: the record carries a pinned SecretRef with the version
    // Secrets Manager actually served. Consumers persist this so
    // they can detect drift against AWSCURRENT (rotation signal).
    expect(out.clientSecret).toBeDefined();
    expect(out.clientSecret!.arn).toBe(TEST_SECRET_ARN);
    expect(out.clientSecret!.versionId).toBe(TEST_SECRET_VERSION);

    // CRITICAL: the secret passed to Cognito is the plaintext, NOT the ARN.
    const call = cognitoMock.commandCalls(CreateIdentityProviderCommand)[0];
    expect(call!.args[0].input.UserPoolId).toBe(POOL_ID);
    expect(call!.args[0].input.ProviderType).toBe("OIDC");
    const details = call!.args[0].input.ProviderDetails!;
    expect(details["client_secret"]).toBe(PLAINTEXT_SECRET);
    expect(details["client_secret"]).not.toContain("arn:aws:secretsmanager");
    expect(details["client_id"]).toBe("client-123");
    expect(details["oidc_issuer"]).toBe("https://login.example.com/");
    expect(details["authorize_scopes"]).toBe("openid email profile");
    expect(details["attributes_request_method"]).toBe("GET");
  });

  it("updates an existing IdP when one already exists at the derived name", async () => {
    cognitoMock
      .on(DescribeIdentityProviderCommand)
      .resolves({ IdentityProvider: { ProviderName: "tenant-acme" } });
    cognitoMock.on(UpdateIdentityProviderCommand).resolves({});

    const manager = makeManager();
    await manager.upsert({
      tenantId: "acme",
      issuer: "https://login.example.com/",
      clientId: "client-123",
      clientSecretArn: "arn:aws:secretsmanager:us-east-1:1:secret:x-AbCdEf",
    });

    expect(cognitoMock.commandCalls(UpdateIdentityProviderCommand)).toHaveLength(1);
    expect(cognitoMock.commandCalls(CreateIdentityProviderCommand)).toHaveLength(0);
    const call = cognitoMock.commandCalls(UpdateIdentityProviderCommand)[0];
    expect(call!.args[0].input.ProviderDetails!["client_secret"]).toBe(PLAINTEXT_SECRET);
  });

  it("uses default scopes and attribute mapping when not provided", async () => {
    cognitoMock
      .on(DescribeIdentityProviderCommand)
      .rejects(new ResourceNotFoundException({ message: "nope", $metadata: {} }));
    cognitoMock.on(CreateIdentityProviderCommand).resolves({});

    const manager = makeManager();
    await manager.upsert({
      tenantId: "acme",
      issuer: "https://login.example.com",
      clientId: "client-123",
      clientSecretArn: "arn:aws:secretsmanager:us-east-1:1:secret:x-AbCdEf",
    });

    const call = cognitoMock.commandCalls(CreateIdentityProviderCommand)[0];
    expect(call!.args[0].input.ProviderDetails!["authorize_scopes"]).toBe("openid email profile");
    expect(call!.args[0].input.AttributeMapping).toMatchObject({
      email: "email",
      email_verified: "email_verified",
      given_name: "given_name",
      family_name: "family_name",
      name: "name",
    });
  });

  it("merges consumer attribute-mapping overrides over defaults", async () => {
    cognitoMock
      .on(DescribeIdentityProviderCommand)
      .rejects(new ResourceNotFoundException({ message: "nope", $metadata: {} }));
    cognitoMock.on(CreateIdentityProviderCommand).resolves({});

    const manager = makeManager();
    await manager.upsert({
      tenantId: "acme",
      issuer: "https://login.example.com",
      clientId: "client-123",
      clientSecretArn: "arn:aws:secretsmanager:us-east-1:1:secret:x-AbCdEf",
      attributeMapping: {
        "custom:idpGroups": "roles",
        email: "mail", // override default
      },
    });

    const call = cognitoMock.commandCalls(CreateIdentityProviderCommand)[0];
    expect(call!.args[0].input.AttributeMapping).toMatchObject({
      email: "mail",
      family_name: "family_name", // default preserved
      "custom:idpGroups": "roles", // override applied
    });
  });

  it("passes through scopes as a space-separated string", async () => {
    cognitoMock
      .on(DescribeIdentityProviderCommand)
      .rejects(new ResourceNotFoundException({ message: "nope", $metadata: {} }));
    cognitoMock.on(CreateIdentityProviderCommand).resolves({});

    const manager = makeManager();
    await manager.upsert({
      tenantId: "acme",
      issuer: "https://login.example.com",
      clientId: "client-123",
      clientSecretArn: "arn:aws:secretsmanager:us-east-1:1:secret:x-AbCdEf",
      scopes: ["openid", "email", "groups"],
    });

    const call = cognitoMock.commandCalls(CreateIdentityProviderCommand)[0];
    expect(call!.args[0].input.ProviderDetails!["authorize_scopes"]).toBe("openid email groups");
  });

  it("passes IdpIdentifiers when supplied", async () => {
    cognitoMock
      .on(DescribeIdentityProviderCommand)
      .rejects(new ResourceNotFoundException({ message: "nope", $metadata: {} }));
    cognitoMock.on(CreateIdentityProviderCommand).resolves({});

    const manager = makeManager();
    await manager.upsert({
      tenantId: "acme",
      issuer: "https://login.example.com",
      clientId: "client-123",
      clientSecretArn: "arn:aws:secretsmanager:us-east-1:1:secret:x-AbCdEf",
      idpIdentifiers: ["acme.example", "acme-corp.example"],
    });

    const call = cognitoMock.commandCalls(CreateIdentityProviderCommand)[0];
    expect(call!.args[0].input.IdpIdentifiers).toEqual(["acme.example", "acme-corp.example"]);
  });

  it("rejects too many IdpIdentifiers (>50)", async () => {
    const manager = makeManager();
    const tooMany = Array.from({ length: 51 }, (_, i) => `domain${i}.example`);
    await expect(
      manager.upsert({
        tenantId: "acme",
        issuer: "https://login.example.com",
        clientId: "client-123",
        clientSecretArn: "arn:aws:secretsmanager:us-east-1:1:secret:x-AbCdEf",
        idpIdentifiers: tooMany,
      }),
    ).rejects.toThrow(IdpManagerError);
  });

  it("rejects IdpIdentifier entries that are too long", async () => {
    const manager = makeManager();
    await expect(
      manager.upsert({
        tenantId: "acme",
        issuer: "https://login.example.com",
        clientId: "client-123",
        clientSecretArn: "arn:aws:secretsmanager:us-east-1:1:secret:x-AbCdEf",
        idpIdentifiers: ["a".repeat(41)],
      }),
    ).rejects.toMatchObject({
      reason: "idp_identifier_invalid",
    });
  });

  it("rejects IdpIdentifier entries that are empty", async () => {
    const manager = makeManager();
    await expect(
      manager.upsert({
        tenantId: "acme",
        issuer: "https://login.example.com",
        clientId: "client-123",
        clientSecretArn: "arn:aws:secretsmanager:us-east-1:1:secret:x-AbCdEf",
        idpIdentifiers: [""],
      }),
    ).rejects.toMatchObject({
      reason: "idp_identifier_invalid",
    });
  });

  it("rejects IdpIdentifier entries that violate the Cognito regex", async () => {
    const manager = makeManager();
    await expect(
      manager.upsert({
        tenantId: "acme",
        issuer: "https://login.example.com",
        clientId: "client-123",
        clientSecretArn: "arn:aws:secretsmanager:us-east-1:1:secret:x-AbCdEf",
        idpIdentifiers: ["has/slash"],
      }),
    ).rejects.toThrow(/regex/);
  });

  it("populates a pinned SecretRef on the returned record (S-V2 round-trip)", async () => {
    cognitoMock
      .on(DescribeIdentityProviderCommand)
      .rejects(new ResourceNotFoundException({ message: "nope", $metadata: {} }));
    cognitoMock.on(CreateIdentityProviderCommand).resolves({});

    // Override the mock to return a specific version, then assert
    // the record's clientSecret carries that exact version.
    const ROTATION_VERSION = "99999999-aaaa-bbbb-cccc-dddddddddddd";
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: PLAINTEXT_SECRET,
      ARN: TEST_SECRET_ARN,
      VersionId: ROTATION_VERSION,
    });

    const manager = makeManager();
    const out = await manager.upsert({
      tenantId: "acme",
      issuer: "https://login.example.com/",
      clientId: "client-123",
      clientSecretArn: "arn:aws:secretsmanager:us-east-1:1:secret:x-AbCdEf",
    });

    expect(out.clientSecret).toBeDefined();
    expect(out.clientSecret!.versionId).toBe(ROTATION_VERSION);
    // The plaintext never appears on the record (only the pin does).
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT_SECRET);
  });

  it("reads the plaintext secret from Secrets Manager via package-internal path", async () => {
    cognitoMock
      .on(DescribeIdentityProviderCommand)
      .rejects(new ResourceNotFoundException({ message: "nope", $metadata: {} }));
    cognitoMock.on(CreateIdentityProviderCommand).resolves({});

    const manager = makeManager();
    await manager.upsert({
      tenantId: "acme",
      issuer: "https://login.example.com",
      clientId: "client-123",
      clientSecretArn: "arn:aws:secretsmanager:us-east-1:1:secret:x-AbCdEf",
    });

    // Exactly one GetSecretValue called; the SecretId is the
    // derived canonical name (not the ARN the consumer passed).
    expect(secretsMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
    const secretCall = secretsMock.commandCalls(GetSecretValueCommand)[0];
    expect(secretCall!.args[0].input.SecretId).toContain("/vestibulum/idp/test-app/");
    expect(secretCall!.args[0].input.SecretId).toContain("acme");
  });
});

describe("OidcIdpManager.constructor", () => {
  it("builds a default CognitoIdentityProviderClient when none supplied", () => {
    const secretsClient = new IdpSecretsClient({
      secretPrefix: "/vestibulum/idp/test-app/",
    });
    // Should not throw.
    const m = new OidcIdpManager({
      userPoolId: POOL_ID,
      region: "us-east-1",
      secretsClient,
    });
    expect(m).toBeInstanceOf(OidcIdpManager);
  });
});

describe("OidcIdpManager.get", () => {
  it("returns undefined when the IdP does not exist", async () => {
    cognitoMock
      .on(DescribeIdentityProviderCommand)
      .rejects(new ResourceNotFoundException({ message: "nope", $metadata: {} }));

    const manager = makeManager();
    const out = await manager.get("acme");
    expect(out).toBeUndefined();
  });

  it("returns the record when the IdP exists", async () => {
    const fixedDate = isoDate("2026-05-23T00:00:00Z");
    cognitoMock.on(DescribeIdentityProviderCommand).resolves({
      IdentityProvider: { ProviderName: "tenant-acme", LastModifiedDate: fixedDate },
    });

    const manager = makeManager();
    const out = await manager.get("acme");
    expect(out?.tenantId).toBe("acme");
    expect(out?.cognitoIdpName).toMatch(/^tenant-/);
    expect(out?.status).toBe("ACTIVE");
    expect(out?.lastSyncedAt).toEqual(fixedDate);
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

  it("returns undefined when describe returns no IdentityProvider", async () => {
    cognitoMock.on(DescribeIdentityProviderCommand).resolves({});

    const manager = makeManager();
    const out = await manager.get("acme");
    expect(out).toBeUndefined();
  });

  it("propagates non-NotFound errors from describe", async () => {
    cognitoMock.on(DescribeIdentityProviderCommand).rejects(new Error("throttled"));

    const manager = makeManager();
    await expect(manager.get("acme")).rejects.toThrow(/throttled/);
  });
});

describe("OidcIdpManager.delete", () => {
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
      UserPoolClient: {
        ClientId: "app-1",
        SupportedIdentityProviders: ["COGNITO"],
      },
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

  it("propagates non-NotFound errors during DeleteIdentityProvider", async () => {
    cognitoMock.on(DeleteIdentityProviderCommand).rejects(new Error("throttled"));

    const manager = makeManager();
    await expect(manager.delete("acme")).rejects.toThrow(/throttled/);
  });

  it("skips detach when describe returns an empty UserPoolClient field", async () => {
    cognitoMock.on(DescribeUserPoolClientCommand).resolves({});
    cognitoMock.on(DeleteIdentityProviderCommand).resolves({});

    const manager = makeManager();
    await manager.delete("acme", ["app-1"]);

    expect(cognitoMock.commandCalls(UpdateUserPoolClientCommand)).toHaveLength(0);
  });
});

describe("OidcIdpManager.attachToAppClients", () => {
  it("appends the IdP name to existing SupportedIdentityProviders", async () => {
    cognitoMock.on(DescribeUserPoolClientCommand).resolves({
      UserPoolClient: { ClientId: "app-1", SupportedIdentityProviders: ["COGNITO"] },
    });
    cognitoMock.on(UpdateUserPoolClientCommand).resolves({});

    const manager = makeManager();
    await manager.attachToAppClients("acme", ["app-1"]);

    const call = cognitoMock.commandCalls(UpdateUserPoolClientCommand)[0];
    expect(call!.args[0].input.ClientId).toBe("app-1");
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
    cognitoMock.on(DescribeUserPoolClientCommand).resolves({}); // no UserPoolClient

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

  it("treats undefined SupportedIdentityProviders as empty (detach skips)", async () => {
    cognitoMock.on(DescribeUserPoolClientCommand).resolves({
      UserPoolClient: { ClientId: "app-1" /* no SupportedIdentityProviders */ },
    });
    cognitoMock.on(DeleteIdentityProviderCommand).resolves({});

    const manager = makeManager();
    await manager.delete("acme", ["app-1"]);

    expect(cognitoMock.commandCalls(UpdateUserPoolClientCommand)).toHaveLength(0);
  });

  it("attaches across multiple app clients in one call", async () => {
    cognitoMock.on(DescribeUserPoolClientCommand).resolves({
      UserPoolClient: { ClientId: "app-1", SupportedIdentityProviders: ["COGNITO"] },
    });
    cognitoMock.on(UpdateUserPoolClientCommand).resolves({});

    const manager = makeManager();
    await manager.attachToAppClients("acme", ["app-1", "app-2", "app-3"]);

    expect(cognitoMock.commandCalls(UpdateUserPoolClientCommand)).toHaveLength(3);
  });
});
