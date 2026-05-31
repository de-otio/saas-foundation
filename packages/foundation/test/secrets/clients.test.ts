/**
 * Smoke tests for the default client factories.
 *
 * Verifies the factories construct the expected client class with the
 * region override applied when present. We do NOT call any real SDK
 * methods here — that's covered by `resolve.test.ts` with mocks.
 */

import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SSMClient } from "@aws-sdk/client-ssm";
import { describe, expect, it } from "vitest";

import {
  createDefaultSecretsManagerClient,
  createDefaultSsmClient,
} from "../../src/secrets/clients.js";

describe("createDefaultSecretsManagerClient", () => {
  it("returns a SecretsManagerClient instance", () => {
    const client = createDefaultSecretsManagerClient();
    expect(client).toBeInstanceOf(SecretsManagerClient);
  });

  it("applies the region override when supplied", async () => {
    const client = createDefaultSecretsManagerClient({ region: "eu-central-1" });
    const region = await client.config.region();
    expect(region).toBe("eu-central-1");
  });
});

describe("createDefaultSsmClient", () => {
  it("returns an SSMClient instance", () => {
    const client = createDefaultSsmClient();
    expect(client).toBeInstanceOf(SSMClient);
  });

  it("applies the region override when supplied", async () => {
    const client = createDefaultSsmClient({ region: "us-west-2" });
    const region = await client.config.region();
    expect(region).toBe("us-west-2");
  });
});
