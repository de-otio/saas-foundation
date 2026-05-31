import { beforeEach, describe, it, expect } from "vitest";
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceExistsException,
  ResourceNotFoundException,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";

import { VestibulumRuntimeError } from "../../src/errors.js";
import { getSecretValue } from "../../src/secrets/read-internal.js";
import { INTERNAL_CLIENT, IdpSecretsClient } from "../../src/secrets/secrets-client.js";

const sm = mockClient(SecretsManagerClient);

beforeEach(() => {
  sm.reset();
});

/**
 * Convenience builder for a valid client. The injected SDK client
 * uses the same mock instance so `sm.on(...)` works.
 */
function newClient(
  overrides: { secretPrefix?: string; region?: string; accountId?: string } = {},
): IdpSecretsClient {
  return new IdpSecretsClient({
    secretPrefix: overrides.secretPrefix ?? "/vestibulum/idp/test/",
    region: overrides.region ?? "eu-central-1",
    accountId: overrides.accountId ?? "123456789012",
    secretsClient: sm as unknown as SecretsManagerClient,
  });
}

describe("IdpSecretsClient — construction & validation", () => {
  it("requires secretPrefix to be a non-empty string", () => {
    expect(
      () =>
        new IdpSecretsClient({
          secretPrefix: "",
          secretsClient: sm as unknown as SecretsManagerClient,
        }),
    ).toThrow(VestibulumRuntimeError);
  });

  it("requires secretPrefix to start with /", () => {
    expect(
      () =>
        new IdpSecretsClient({
          secretPrefix: "vestibulum/",
          secretsClient: sm as unknown as SecretsManagerClient,
        }),
    ).toThrow(/must start with/);
  });

  it("requires secretPrefix to end with /", () => {
    expect(
      () =>
        new IdpSecretsClient({
          secretPrefix: "/vestibulum",
          secretsClient: sm as unknown as SecretsManagerClient,
        }),
    ).toThrow(/must end with/);
  });

  it("rejects secretPrefix with Secrets-Manager-disallowed characters", () => {
    expect(
      () =>
        new IdpSecretsClient({
          secretPrefix: "/vestibulum idp/",
          secretsClient: sm as unknown as SecretsManagerClient,
        }),
    ).toThrow(/Secrets Manager does not allow/);
  });

  it("falls back to AWS_REGION when region is not supplied", () => {
    const previous = process.env.AWS_REGION;
    process.env.AWS_REGION = "us-west-2";
    try {
      const c = new IdpSecretsClient({
        secretPrefix: "/vestibulum/idp/test/",
        accountId: "999999999999",
        secretsClient: sm as unknown as SecretsManagerClient,
      });
      expect(c.region).toBe("us-west-2");
    } finally {
      if (previous === undefined) delete process.env.AWS_REGION;
      else process.env.AWS_REGION = previous;
    }
  });

  it("falls back to us-east-1 when no region is configured", () => {
    const previous = process.env.AWS_REGION;
    delete process.env.AWS_REGION;
    try {
      const c = new IdpSecretsClient({
        secretPrefix: "/vestibulum/idp/test/",
        accountId: "999999999999",
        secretsClient: sm as unknown as SecretsManagerClient,
      });
      expect(c.region).toBe("us-east-1");
    } finally {
      if (previous !== undefined) process.env.AWS_REGION = previous;
    }
  });

  it("constructs an SDK client when none is injected", () => {
    // We don't make any network calls; we only check construction
    // succeeds and the symbol-keyed client exists.
    const c = new IdpSecretsClient({
      secretPrefix: "/vestibulum/idp/test/",
      region: "eu-central-1",
      accountId: "123456789012",
    });
    expect(c[INTERNAL_CLIENT]).toBeInstanceOf(SecretsManagerClient);
  });

  it("exposes the same SDK client via the INTERNAL_CLIENT symbol", () => {
    const c = newClient();
    expect(c[INTERNAL_CLIENT]).toBe(sm as unknown as SecretsManagerClient);
  });
});

describe("IdpSecretsClient.arnFor", () => {
  it("returns the canonical ARN without a network call", () => {
    const c = newClient();
    const arn = c.arnFor("tenant-acme");
    expect(arn).toBe(
      "arn:aws:secretsmanager:eu-central-1:123456789012:secret:/vestibulum/idp/test/oidc-client-secret/tenant-acme",
    );
    // No SDK call should have happened.
    expect(sm.calls()).toHaveLength(0);
  });

  it("uses a non-default kind when supplied", () => {
    const c = newClient();
    const arn = c.arnFor("tenant-acme", "scim-bearer-token");
    expect(arn).toContain("/scim-bearer-token/tenant-acme");
  });

  it("sanitises an unsafe tenantId before embedding", () => {
    const c = newClient();
    const arn = c.arnFor("a tenant!!");
    expect(arn).toContain("/a_tenant__");
  });

  it("throws when accountId is missing", () => {
    const c = new IdpSecretsClient({
      secretPrefix: "/vestibulum/idp/test/",
      region: "eu-central-1",
      secretsClient: sm as unknown as SecretsManagerClient,
    });
    expect(() => c.arnFor("tenant-acme")).toThrow(/accountId/);
  });

  it("rejects an empty tenantId", () => {
    const c = newClient();
    expect(() => c.arnFor("")).toThrow(/tenantId must be a non-empty string/);
  });

  it("rejects an empty kind", () => {
    const c = newClient();
    expect(() => c.arnFor("tenant-acme", "")).toThrow(/kind must be a non-empty string/);
  });

  it("rejects a kind with disallowed characters", () => {
    const c = newClient();
    expect(() => c.arnFor("tenant-acme", "bad kind")).toThrow(/Secrets Manager does not allow/);
  });
});

describe("IdpSecretsClient.store", () => {
  it("creates a new secret on first call", async () => {
    sm.on(CreateSecretCommand).resolves({
      ARN: "arn:aws:secretsmanager:eu-central-1:123456789012:secret:/vestibulum/idp/test/oidc-client-secret/tenant-acme-abcdef",
      VersionId: "v1",
      Name: "/vestibulum/idp/test/oidc-client-secret/tenant-acme",
    });
    const c = newClient();
    const out = await c.store("tenant-acme", "s3cret");
    expect(out.arn).toContain(":secret:/vestibulum/idp/test/oidc-client-secret/tenant-acme");
    expect(out.versionId).toBe("v1");

    const created = sm.commandCalls(CreateSecretCommand);
    expect(created).toHaveLength(1);
    expect(created[0]!.args[0].input).toMatchObject({
      Name: "/vestibulum/idp/test/oidc-client-secret/tenant-acme",
      SecretString: "s3cret",
    });
    expect(sm.commandCalls(PutSecretValueCommand)).toHaveLength(0);
  });

  it("falls back to PutSecretValue on ResourceExistsException", async () => {
    const existsErr = new ResourceExistsException({
      $metadata: {},
      message: "exists",
    });
    sm.on(CreateSecretCommand).rejects(existsErr);
    sm.on(PutSecretValueCommand).resolves({
      ARN: "arn:aws:secretsmanager:eu-central-1:123456789012:secret:/vestibulum/idp/test/oidc-client-secret/tenant-acme-abcdef",
      VersionId: "v2",
    });
    const c = newClient();
    const out = await c.store("tenant-acme", "rotated");
    expect(out.versionId).toBe("v2");
    expect(sm.commandCalls(PutSecretValueCommand)).toHaveLength(1);
  });

  it("propagates non-ResourceExistsException errors from CreateSecret", async () => {
    sm.on(CreateSecretCommand).rejects(new Error("AccessDenied"));
    const c = newClient();
    await expect(c.store("tenant-acme", "val")).rejects.toThrow("AccessDenied");
  });

  it("rejects an empty secret value", async () => {
    const c = newClient();
    await expect(c.store("tenant-acme", "")).rejects.toThrow(
      /secretValue must be a non-empty string/,
    );
  });

  it("throws on missing ARN/VersionId in CreateSecret response", async () => {
    sm.on(CreateSecretCommand).resolves({});
    const c = newClient();
    await expect(c.store("tenant-acme", "val")).rejects.toThrow(/CreateSecret did not return/);
  });

  it("throws on missing ARN/VersionId in PutSecretValue response", async () => {
    sm.on(CreateSecretCommand).rejects(
      new ResourceExistsException({ $metadata: {}, message: "x" }),
    );
    sm.on(PutSecretValueCommand).resolves({});
    const c = newClient();
    await expect(c.store("tenant-acme", "val")).rejects.toThrow(/PutSecretValue did not return/);
  });

  it("uses the requested kind in the secret name", async () => {
    sm.on(CreateSecretCommand).resolves({
      ARN: "arn:aws:secretsmanager:eu-central-1:123456789012:secret:/vestibulum/idp/test/scim-bearer-token/tenant-acme-abcdef",
      VersionId: "v1",
    });
    const c = newClient();
    await c.store("tenant-acme", "val", "scim-bearer-token");
    const created = sm.commandCalls(CreateSecretCommand);
    expect(created[0]!.args[0].input.Name).toContain("/scim-bearer-token/tenant-acme");
  });
});

describe("IdpSecretsClient.delete", () => {
  it("schedules deletion with a 7-day recovery window", async () => {
    sm.on(DeleteSecretCommand).resolves({});
    const c = newClient();
    await c.delete("tenant-acme");
    const deleted = sm.commandCalls(DeleteSecretCommand);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.args[0].input).toMatchObject({
      SecretId: "/vestibulum/idp/test/oidc-client-secret/tenant-acme",
      RecoveryWindowInDays: 7,
    });
  });

  it("is a no-op when the secret does not exist", async () => {
    sm.on(DeleteSecretCommand).rejects(
      new ResourceNotFoundException({ $metadata: {}, message: "no such" }),
    );
    const c = newClient();
    await expect(c.delete("tenant-acme")).resolves.toBeUndefined();
  });

  it("propagates other errors", async () => {
    sm.on(DeleteSecretCommand).rejects(new Error("AccessDenied"));
    const c = newClient();
    await expect(c.delete("tenant-acme")).rejects.toThrow("AccessDenied");
  });

  it("respects the requested kind", async () => {
    sm.on(DeleteSecretCommand).resolves({});
    const c = newClient();
    await c.delete("tenant-acme", "scim-bearer-token");
    const deleted = sm.commandCalls(DeleteSecretCommand);
    expect(deleted[0]!.args[0].input.SecretId).toContain("/scim-bearer-token/tenant-acme");
  });
});

describe("secrets/read-internal — getSecretValue (package-internal)", () => {
  // S-V2: getSecretValue now returns `{plaintext, versionId, arn}` so
  // the OIDC manager can populate `OidcIdpRecord.clientSecret` with a
  // pinned `SecretRef`. Mocks must supply ARN and VersionId.
  const FIXTURE_ARN =
    "arn:aws:secretsmanager:us-east-1:111111111111:secret:/vestibulum/idp/test/oidc-client-secret/tenant-acme-AbCdEf";
  const FIXTURE_VERSION = "11111111-2222-3333-4444-555555555555";

  it("returns the plaintext + pinned SecretRef metadata for an existing secret", async () => {
    sm.on(GetSecretValueCommand).resolves({
      SecretString: "s3cret",
      ARN: FIXTURE_ARN,
      VersionId: FIXTURE_VERSION,
    });
    const c = newClient();
    const read = await getSecretValue(c, "tenant-acme");
    expect(read.plaintext).toBe("s3cret");
    expect(read.versionId).toBe(FIXTURE_VERSION);
    expect(read.arn).toBe(FIXTURE_ARN);
    const calls = sm.commandCalls(GetSecretValueCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toMatchObject({
      SecretId: "/vestibulum/idp/test/oidc-client-secret/tenant-acme",
    });
  });

  it("throws not_found when the secret does not exist", async () => {
    sm.on(GetSecretValueCommand).rejects(
      new ResourceNotFoundException({ $metadata: {}, message: "missing" }),
    );
    const c = newClient();
    await expect(getSecretValue(c, "tenant-acme")).rejects.toMatchObject({
      code: "secrets_client.not_found",
    });
  });

  it("throws empty_value when the record has no SecretString", async () => {
    sm.on(GetSecretValueCommand).resolves({});
    const c = newClient();
    await expect(getSecretValue(c, "tenant-acme")).rejects.toMatchObject({
      code: "secrets_client.empty_value",
    });
  });

  it("throws empty_value when SecretString is empty", async () => {
    sm.on(GetSecretValueCommand).resolves({ SecretString: "" });
    const c = newClient();
    await expect(getSecretValue(c, "tenant-acme")).rejects.toMatchObject({
      code: "secrets_client.empty_value",
    });
  });

  it("throws empty_value when VersionId is missing (S-V2 cannot pin)", async () => {
    sm.on(GetSecretValueCommand).resolves({
      SecretString: "s3cret",
      ARN: FIXTURE_ARN,
    });
    const c = newClient();
    await expect(getSecretValue(c, "tenant-acme")).rejects.toMatchObject({
      code: "secrets_client.empty_value",
    });
  });

  it("throws empty_value when ARN is missing (S-V2 cannot pin)", async () => {
    sm.on(GetSecretValueCommand).resolves({
      SecretString: "s3cret",
      VersionId: FIXTURE_VERSION,
    });
    const c = newClient();
    await expect(getSecretValue(c, "tenant-acme")).rejects.toMatchObject({
      code: "secrets_client.empty_value",
    });
  });

  it("propagates other errors", async () => {
    sm.on(GetSecretValueCommand).rejects(new Error("AccessDenied"));
    const c = newClient();
    await expect(getSecretValue(c, "tenant-acme")).rejects.toThrow("AccessDenied");
  });

  it("honours the requested kind", async () => {
    const scimArn =
      "arn:aws:secretsmanager:us-east-1:111111111111:secret:/vestibulum/idp/test/scim-bearer-token/tenant-acme-GhIjKl";
    sm.on(GetSecretValueCommand).resolves({
      SecretString: "scim-tok",
      ARN: scimArn,
      VersionId: FIXTURE_VERSION,
    });
    const c = newClient();
    const read = await getSecretValue(c, "tenant-acme", "scim-bearer-token");
    expect(read.plaintext).toBe("scim-tok");
    expect(read.arn).toBe(scimArn);
    const calls = sm.commandCalls(GetSecretValueCommand);
    expect(calls[0]!.args[0].input.SecretId).toContain("/scim-bearer-token/tenant-acme");
  });
});

describe("package boundary check", () => {
  it("does not expose getSecretValue from the package index", async () => {
    // The package index re-exports only the public surface; the
    // read path is package-internal.
    const index = await import("../../src/index.js");
    expect((index as Record<string, unknown>).getSecretValue).toBeUndefined();
  });

  it("does not expose IdpSecretsClient#get(...)", () => {
    const c = newClient();
    expect((c as unknown as Record<string, unknown>).get).toBeUndefined();
  });
});
