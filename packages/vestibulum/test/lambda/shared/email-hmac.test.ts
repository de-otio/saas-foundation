/**
 * Regression tests for the canonical email-HMAC helper.
 *
 * These guard the two production bugs the shared module fixes:
 *   1. The HMAC was keyed on the Secrets Manager ARN (env held the id, not the
 *      value) — so the pepper was effectively public. The resolver must fetch
 *      the real value and cache it per warm container.
 *   2. The denylist write (bounce-handler) used a keyed HMAC without
 *      lowercasing, while the read (quarantine-check) used a plain unkeyed
 *      sha256 WITH lowercasing — so the two never matched. The one canonical
 *      `hmacEmail` keeps them in lockstep and always lowercases.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

import {
  __resetEmailHmacKeyCache,
  hmacEmail,
  resolveEmailHmacKeyFromEnv,
} from "../../../src/lambda/shared/email-hmac.js";

// RuntimeEnv.BOUNCE_HMAC_SECRET, inlined as a literal. `delete process.env[...]`
// must use a string literal to satisfy @typescript-eslint/no-dynamic-delete.
const HMAC_SECRET_ENV = "VESTIBULUM_BOUNCE_HMAC_SECRET";

const secretsMock = mockClient(SecretsManagerClient);

describe("hmacEmail", () => {
  it("lowercases the address so case never causes a mismatch", () => {
    // The exact regression: bounce-handler wrote without lowercasing, the
    // denylist read lowercased. Both now go through hmacEmail, which lowercases.
    expect(hmacEmail("User@Example.COM", "k")).toBe(hmacEmail("user@example.com", "k"));
  });

  it("is keyed — different keys yield different hashes for the same address", () => {
    // Proves the ARN-vs-value bug matters: swapping the key changes the output,
    // so a public ARN-as-key is not interchangeable with a real secret value.
    expect(hmacEmail("user@example.com", "secret-a")).not.toBe(
      hmacEmail("user@example.com", "secret-b"),
    );
  });

  it("is deterministic and hex-encoded (64 chars / 32 bytes)", () => {
    const out = hmacEmail("user@example.com", "k");
    expect(out).toBe(hmacEmail("user@example.com", "k"));
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("resolveEmailHmacKeyFromEnv", () => {
  beforeEach(() => {
    secretsMock.reset();
    __resetEmailHmacKeyCache();
    delete process.env["VESTIBULUM_BOUNCE_HMAC_SECRET"];
  });

  afterEach(() => {
    delete process.env["VESTIBULUM_BOUNCE_HMAC_SECRET"];
    __resetEmailHmacKeyCache();
  });

  it("returns '' (HMAC disabled) when the secret id env var is unset", async () => {
    const client = new SecretsManagerClient({});
    const key = await resolveEmailHmacKeyFromEnv({ client });
    expect(key).toBe("");
    // Must NOT call Secrets Manager when there is nothing to resolve.
    expect(secretsMock.commandCalls(GetSecretValueCommand)).toHaveLength(0);
  });

  it("resolves the secret VALUE from the id in the env var", async () => {
    process.env[HMAC_SECRET_ENV] =
      "arn:aws:secretsmanager:eu-central-1:000000000000:secret:vestibulum/hmac-AbCdEf";
    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: "the-real-pepper" });

    const client = new SecretsManagerClient({});
    const key = await resolveEmailHmacKeyFromEnv({ client });

    expect(key).toBe("the-real-pepper");
    // The SecretId passed to Secrets Manager is the env var's value (the id).
    const call = secretsMock.commandCalls(GetSecretValueCommand)[0];
    expect((call?.args[0].input as { SecretId?: string }).SecretId).toBe(
      process.env[HMAC_SECRET_ENV],
    );
  });

  it("caches the value — one GetSecretValue per warm container", async () => {
    process.env[HMAC_SECRET_ENV] = "secret-id-1";
    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: "pepper" });

    const client = new SecretsManagerClient({});
    const a = await resolveEmailHmacKeyFromEnv({ client });
    const b = await resolveEmailHmacKeyFromEnv({ client });
    const c = await resolveEmailHmacKeyFromEnv({ client });

    expect([a, b, c]).toEqual(["pepper", "pepper", "pepper"]);
    expect(secretsMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
  });

  it("re-fetches when the secret id changes (cache keyed on id)", async () => {
    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: "v1" });
    const client = new SecretsManagerClient({});

    process.env[HMAC_SECRET_ENV] = "id-1";
    await resolveEmailHmacKeyFromEnv({ client });
    process.env[HMAC_SECRET_ENV] = "id-2";
    await resolveEmailHmacKeyFromEnv({ client });

    expect(secretsMock.commandCalls(GetSecretValueCommand)).toHaveLength(2);
  });

  it("throws when the secret id is set but resolves to an empty value", async () => {
    process.env[HMAC_SECRET_ENV] = "secret-id-empty";
    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: "" });

    const client = new SecretsManagerClient({});
    await expect(resolveEmailHmacKeyFromEnv({ client })).rejects.toThrow(/empty value/);
  });
});
