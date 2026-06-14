/**
 * `resolveSecret` / `resolveParameter` unit tests.
 *
 * Mocks the AWS SDK at the boundary via `aws-sdk-client-mock`. No
 * real network. Determinism rules per doc/02-monorepo-layout.md.
 */

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SecretCache } from "../../src/secrets/cache.js";
import {
  ParameterAccessDeniedError,
  ParameterNotFoundError,
  SecretsAccessDeniedError,
  SecretsNotFoundError,
  SecretsResolveError,
  SecretsTransientError,
} from "../../src/secrets/errors.js";
import {
  _resetDefaultCacheForTests,
  resolveParameter,
  resolveSecret,
} from "../../src/secrets/resolve.js";
import { secretRef } from "../../src/types/frozen/secrets.js";

const TEST_ARN = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:my-secret-abcdef";
const TEST_PARAM = "/myapp/dev/some-param";

const secretsMock = mockClient(SecretsManagerClient);
const ssmMock = mockClient(SSMClient);

beforeEach(() => {
  secretsMock.reset();
  ssmMock.reset();
  _resetDefaultCacheForTests();
});

afterEach(() => {
  secretsMock.reset();
  ssmMock.reset();
});

/**
 * The aws-sdk-client-mock library returns a typed mock; we pass it
 * through as the client. `ResolveContext.secretsClient` is typed as
 * `SecretsManagerClient`, which our mock satisfies structurally.
 */
function makeContext(opts?: { cache?: SecretCache }): {
  readonly secretsClient: SecretsManagerClient;
  readonly ssmClient: SSMClient;
  readonly cache: SecretCache;
} {
  return {
    secretsClient: secretsMock as unknown as SecretsManagerClient,
    ssmClient: ssmMock as unknown as SSMClient,
    cache: opts?.cache ?? new SecretCache({ clock: () => 0 }),
  };
}

describe("resolveSecret", () => {
  it("resolves a SecretString payload to a Buffer", async () => {
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: "plaintext-value",
    });
    const ctx = makeContext();
    const out = await resolveSecret(secretRef(TEST_ARN), ctx);
    expect(out.toString("utf-8")).toBe("plaintext-value");
  });

  it("resolves a SecretBinary payload to a Buffer", async () => {
    const bin = new Uint8Array([0x01, 0x02, 0x03, 0xff]);
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretBinary: bin,
    });
    const ctx = makeContext();
    const out = await resolveSecret(secretRef(TEST_ARN), ctx);
    expect(Array.from(out)).toEqual(Array.from(bin));
  });

  it("returns the cached value on the second call (no SDK round-trip)", async () => {
    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: "v1" });
    const ctx = makeContext();
    const ref = secretRef(TEST_ARN);
    const a = await resolveSecret(ref, ctx);
    const b = await resolveSecret(ref, ctx);
    expect(a.toString("utf-8")).toBe("v1");
    expect(b.toString("utf-8")).toBe("v1");
    expect(secretsMock.calls()).toHaveLength(1);
  });

  it("bypasses the cache when { fresh: true }", async () => {
    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: "v1" });
    const ctx = makeContext();
    const ref = secretRef(TEST_ARN);
    await resolveSecret(ref, ctx);
    secretsMock.reset();
    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: "v2" });
    const out = await resolveSecret(ref, ctx, { fresh: true });
    expect(out.toString("utf-8")).toBe("v2");
  });

  it("re-fetches after the TTL expires", async () => {
    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: "v1" });
    const clockRef = { current: 0 };
    const cache = new SecretCache({ ttlSeconds: 60, clock: () => clockRef.current });
    const ctx = makeContext({ cache });
    const ref = secretRef(TEST_ARN);
    await resolveSecret(ref, ctx);
    clockRef.current = 60_000;
    secretsMock.reset();
    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: "v2" });
    const out = await resolveSecret(ref, ctx);
    expect(out.toString("utf-8")).toBe("v2");
  });

  it("passes the VersionId when the SecretRef is version-pinned", async () => {
    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: "pinned" });
    const ctx = makeContext();
    const ref = secretRef(TEST_ARN, "00000000-0000-0000-0000-000000000001");
    await resolveSecret(ref, ctx);
    const call = secretsMock.call(0);
    const input = call.args[0].input as {
      readonly SecretId: string;
      readonly VersionId?: string;
    };
    expect(input.SecretId).toBe(TEST_ARN);
    expect(input.VersionId).toBe("00000000-0000-0000-0000-000000000001");
  });

  it("throws SecretsNotFoundError on ResourceNotFoundException", async () => {
    const sdkErr = new Error("not found");
    sdkErr.name = "ResourceNotFoundException";
    secretsMock.on(GetSecretValueCommand).rejects(sdkErr);
    const ctx = makeContext();
    await expect(resolveSecret(secretRef(TEST_ARN), ctx)).rejects.toBeInstanceOf(
      SecretsNotFoundError,
    );
  });

  it("throws SecretsAccessDeniedError on AccessDeniedException", async () => {
    const sdkErr = new Error("denied");
    sdkErr.name = "AccessDeniedException";
    secretsMock.on(GetSecretValueCommand).rejects(sdkErr);
    const ctx = makeContext();
    await expect(resolveSecret(secretRef(TEST_ARN), ctx)).rejects.toBeInstanceOf(
      SecretsAccessDeniedError,
    );
  });

  it("throws SecretsAccessDeniedError on DecryptionFailure", async () => {
    const sdkErr = new Error("decryption failure");
    sdkErr.name = "DecryptionFailure";
    secretsMock.on(GetSecretValueCommand).rejects(sdkErr);
    const ctx = makeContext();
    await expect(resolveSecret(secretRef(TEST_ARN), ctx)).rejects.toBeInstanceOf(
      SecretsAccessDeniedError,
    );
  });

  it("throws SecretsTransientError on ThrottlingException after retries", async () => {
    const sdkErr = new Error("throttled");
    sdkErr.name = "ThrottlingException";
    secretsMock.on(GetSecretValueCommand).rejects(sdkErr);
    const ctx = makeContext();
    await expect(resolveSecret(secretRef(TEST_ARN), ctx)).rejects.toBeInstanceOf(
      SecretsTransientError,
    );
    // cockatiel attempts the call up to 3 times — verify we retried.
    expect(secretsMock.calls().length).toBeGreaterThan(1);
  }, 20_000);

  it("retries on transient failure and succeeds on the second attempt", async () => {
    const sdkErr = new Error("throttled");
    sdkErr.name = "ThrottlingException";
    secretsMock
      .on(GetSecretValueCommand)
      .rejectsOnce(sdkErr)
      .resolves({ SecretString: "recovered" });
    const ctx = makeContext();
    const out = await resolveSecret(secretRef(TEST_ARN), ctx);
    expect(out.toString("utf-8")).toBe("recovered");
    expect(secretsMock.calls()).toHaveLength(2);
  }, 20_000);

  it("throws SecretsAccessDeniedError on UnrecognizedClientException", async () => {
    const sdkErr = new Error("creds");
    sdkErr.name = "UnrecognizedClientException";
    secretsMock.on(GetSecretValueCommand).rejects(sdkErr);
    const ctx = makeContext();
    await expect(resolveSecret(secretRef(TEST_ARN), ctx)).rejects.toBeInstanceOf(
      SecretsAccessDeniedError,
    );
  });

  it("throws SecretsTransientError on InternalServiceErrorException", async () => {
    const sdkErr = new Error("internal");
    sdkErr.name = "InternalServiceErrorException";
    secretsMock.on(GetSecretValueCommand).rejects(sdkErr);
    const ctx = makeContext();
    await expect(resolveSecret(secretRef(TEST_ARN), ctx)).rejects.toBeInstanceOf(
      SecretsTransientError,
    );
  }, 20_000);

  it("classifies an unknown thrown value (non-Error) as the base SecretsResolveError", async () => {
    secretsMock.on(GetSecretValueCommand).rejects("not-an-error" as unknown as Error);
    const ctx = makeContext();
    await expect(resolveSecret(secretRef(TEST_ARN), ctx)).rejects.toBeInstanceOf(
      SecretsResolveError,
    );
  });

  it("throws SecretsResolveError for unclassified errors", async () => {
    const sdkErr = new Error("weird");
    sdkErr.name = "SomeOtherException";
    secretsMock.on(GetSecretValueCommand).rejects(sdkErr);
    const ctx = makeContext();
    await expect(resolveSecret(secretRef(TEST_ARN), ctx)).rejects.toBeInstanceOf(
      SecretsResolveError,
    );
  });

  it("throws SecretsResolveError when neither SecretString nor SecretBinary is set", async () => {
    secretsMock.on(GetSecretValueCommand).resolves({});
    const ctx = makeContext();
    await expect(resolveSecret(secretRef(TEST_ARN), ctx)).rejects.toBeInstanceOf(
      SecretsResolveError,
    );
  });
});

describe("resolveParameter", () => {
  it("resolves a plain parameter Value to a Buffer", async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: "param-value" },
    });
    const ctx = makeContext();
    const out = await resolveParameter(TEST_PARAM, ctx);
    expect(out.toString("utf-8")).toBe("param-value");
  });

  it("returns the cached value on the second call", async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: "param-value" },
    });
    const ctx = makeContext();
    await resolveParameter(TEST_PARAM, ctx);
    await resolveParameter(TEST_PARAM, ctx);
    expect(ssmMock.calls()).toHaveLength(1);
  });

  it("requests decryption by default", async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: "decrypted-value" },
    });
    const ctx = makeContext();
    await resolveParameter(TEST_PARAM, ctx);
    const call = ssmMock.call(0);
    const input = call.args[0].input as {
      readonly Name: string;
      readonly WithDecryption?: boolean;
    };
    expect(input.WithDecryption).toBe(true);
  });

  it("disables decryption when withDecryption: false", async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: "raw" },
    });
    const ctx = makeContext();
    await resolveParameter(TEST_PARAM, ctx, { withDecryption: false });
    const call = ssmMock.call(0);
    const input = call.args[0].input as {
      readonly Name: string;
      readonly WithDecryption?: boolean;
    };
    expect(input.WithDecryption).toBe(false);
  });

  it("throws ParameterNotFoundError on ParameterNotFound", async () => {
    const sdkErr = new Error("missing");
    sdkErr.name = "ParameterNotFound";
    ssmMock.on(GetParameterCommand).rejects(sdkErr);
    const ctx = makeContext();
    await expect(resolveParameter(TEST_PARAM, ctx)).rejects.toBeInstanceOf(ParameterNotFoundError);
  });

  it("throws ParameterAccessDeniedError on AccessDeniedException", async () => {
    const sdkErr = new Error("denied");
    sdkErr.name = "AccessDeniedException";
    ssmMock.on(GetParameterCommand).rejects(sdkErr);
    const ctx = makeContext();
    await expect(resolveParameter(TEST_PARAM, ctx)).rejects.toBeInstanceOf(
      ParameterAccessDeniedError,
    );
  });

  it("throws SecretsTransientError on ThrottlingException after retries", async () => {
    const sdkErr = new Error("throttled");
    sdkErr.name = "ThrottlingException";
    ssmMock.on(GetParameterCommand).rejects(sdkErr);
    const ctx = makeContext();
    await expect(resolveParameter(TEST_PARAM, ctx)).rejects.toBeInstanceOf(SecretsTransientError);
  }, 20_000);

  it("throws SecretsResolveError for an unclassified SSM error", async () => {
    const sdkErr = new Error("weird");
    sdkErr.name = "SomeOtherException";
    ssmMock.on(GetParameterCommand).rejects(sdkErr);
    const ctx = makeContext();
    await expect(resolveParameter(TEST_PARAM, ctx)).rejects.toBeInstanceOf(SecretsResolveError);
  });

  it("throws SecretsTransientError on InternalServerError", async () => {
    const sdkErr = new Error("internal");
    sdkErr.name = "InternalServerError";
    ssmMock.on(GetParameterCommand).rejects(sdkErr);
    const ctx = makeContext();
    await expect(resolveParameter(TEST_PARAM, ctx)).rejects.toBeInstanceOf(SecretsTransientError);
  }, 20_000);

  it("throws ParameterNotFoundError when Parameter.Value is missing", async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: {} });
    const ctx = makeContext();
    await expect(resolveParameter(TEST_PARAM, ctx)).rejects.toBeInstanceOf(ParameterNotFoundError);
  });

  it("bypasses cache with { fresh: true }", async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: "v1" },
    });
    const ctx = makeContext();
    await resolveParameter(TEST_PARAM, ctx);
    ssmMock.reset();
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: "v2" },
    });
    const out = await resolveParameter(TEST_PARAM, ctx, { fresh: true });
    expect(out.toString("utf-8")).toBe("v2");
  });
});

describe("default cache (no injected context)", () => {
  it("falls back to the module-scoped default cache", async () => {
    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: "v" });
    const ref = secretRef(TEST_ARN);
    // Provide the mocked client but no cache — exercises the default-cache
    // path.
    const ctx = { secretsClient: secretsMock as unknown as SecretsManagerClient };
    const a = await resolveSecret(ref, ctx);
    const b = await resolveSecret(ref, ctx);
    expect(a.toString("utf-8")).toBe("v");
    expect(b.toString("utf-8")).toBe("v");
    expect(secretsMock.calls()).toHaveLength(1);
  });
});
