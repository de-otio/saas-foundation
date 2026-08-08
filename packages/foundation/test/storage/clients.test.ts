/**
 * Tests for the default S3 client factory.
 *
 * The load-bearing case is the credential pair. The SDK reads exactly one
 * credential pair from the environment, shared across services; on a platform
 * that issues separate credentials for object storage and for queues, the
 * ambient pair belongs to one of them and the other signs as the wrong
 * principal — a 403 that reads like a permissions bug rather than a
 * configuration one.
 *
 * The tests assert the RESOLVED client config (`client.config.credentials()`,
 * `forcePathStyle`), not the constructor arguments, so they would catch the
 * options being built correctly and then dropped.
 *
 * Every case injects `source`, so none of them touch `process.env` and they can
 * run in any order.
 */

import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import { createDefaultS3Client } from "../../src/storage/clients.js";

const empty = {};

describe("createDefaultS3Client", () => {
  it("returns an S3Client instance", () => {
    expect(createDefaultS3Client({ source: empty })).toBeInstanceOf(S3Client);
  });

  describe("region", () => {
    it("applies an explicit override", async () => {
      const client = createDefaultS3Client({ region: "eu-central-1", source: empty });
      await expect(client.config.region()).resolves.toBe("eu-central-1");
    });

    it("falls back to AWS_REGION", async () => {
      const client = createDefaultS3Client({
        source: { AWS_REGION: "eu-west-3" },
      });
      await expect(client.config.region()).resolves.toBe("eu-west-3");
    });

    it("lets an explicit override win over AWS_REGION", async () => {
      const client = createDefaultS3Client({
        region: "eu-central-1",
        source: { AWS_REGION: "eu-west-3" },
      });
      await expect(client.config.region()).resolves.toBe("eu-central-1");
    });
  });

  describe("credentials", () => {
    it("uses the S3-specific pair when both halves are set", async () => {
      const client = createDefaultS3Client({
        source: {
          S3_ACCESS_KEY_ID: "storage-principal",
          S3_SECRET_ACCESS_KEY: "storage-secret",
        },
      });

      const resolved = await client.config.credentials();
      expect(resolved.accessKeyId).toBe("storage-principal");
      expect(resolved.secretAccessKey).toBe("storage-secret");
    });

    it("does NOT read the ambient AWS_* pair into the S3-specific slot", async () => {
      // The whole point: the ambient pair may belong to a different service.
      // With no S3_* pair configured the SDK's own chain applies, and this
      // factory must not have pinned anything of its own.
      const client = createDefaultS3Client({
        source: {
          AWS_REGION: "eu-central-1",
          AWS_ACCESS_KEY_ID: "queue-principal",
          AWS_SECRET_ACCESS_KEY: "queue-secret",
        },
      });

      // `source` is injected, so the SDK's own env chain (real process.env) is
      // what resolves — never the queue principal handed in above.
      const resolved = await client.config.credentials().catch(() => null);
      expect(resolved?.accessKeyId).not.toBe("queue-principal");
    });

    it.each([
      ["only the key id", { S3_ACCESS_KEY_ID: "k" }],
      ["only the secret", { S3_SECRET_ACCESS_KEY: "s" }],
    ])("throws when %s is set", (_label, source) => {
      // Falling back to the ambient chain here would sign as the wrong
      // principal and surface as a 403 — indistinguishable from a genuine
      // permissions problem. Fail at construction, where the cause is nameable.
      expect(() => createDefaultS3Client({ source: source })).toThrow(
        /half-configured/i,
      );
    });

    it("treats an empty-string half as absent, not as a value", () => {
      // An unset key in a container manifest commonly arrives as "".
      expect(() =>
        createDefaultS3Client({
          source: { S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "" },
        }),
      ).toThrow(/half-configured/i);
    });
  });

  describe("addressing style", () => {
    it("defaults to virtual-hosted addressing", () => {
      // Correct for AWS and for any provider with wildcard bucket DNS.
      const client = createDefaultS3Client({ source: empty });
      expect(client.config.forcePathStyle).toBeFalsy();
    });

    it("enables path style on the exact string 'true'", () => {
      const client = createDefaultS3Client({
        source: { S3_FORCE_PATH_STYLE: "true" },
      });
      expect(client.config.forcePathStyle).toBe(true);
    });

    it.each([["1"], ["yes"], ["TRUE"], [""]])(
      "ignores the non-canonical value %j",
      (raw) => {
        // Addressing style changes the URL shape; a stray value must not flip
        // it silently.
        const client = createDefaultS3Client({
          source: { S3_FORCE_PATH_STYLE: raw },
        });
        expect(client.config.forcePathStyle).toBeFalsy();
      },
    );
  });

  describe("AWS default is unchanged", () => {
    it("pins nothing beyond region when no S3_* variable is set", async () => {
      const client = createDefaultS3Client({
        source: { AWS_REGION: "us-east-1" },
      });

      expect(client.config.forcePathStyle).toBeFalsy();
      await expect(client.config.region()).resolves.toBe("us-east-1");
    });
  });
});
