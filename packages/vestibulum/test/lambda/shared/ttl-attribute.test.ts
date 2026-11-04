/**
 * Expiry attribute agreement (01-evidence #4/#13: "the handler wrote `ttl`; the
 * table's TTL attribute was `expires_at`").
 *
 * The constructs name `expires_at` as the TTL attribute of every table with
 * expiring rows (checked at synth in vestibulum-cdk). This file checks the
 * handler side: every write of an expiry uses that name.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { describe, expect, it } from "vitest";

import { tryConsumeIpRateLimit } from "../../../src/lambda/handlers/auth-login/ip-rate-limit.js";
import { tryConsumeRateLimit } from "../../../src/lambda/handlers/create-auth-challenge/rate-limit.js";
import { createSharedCreateAuthChallengeHandler } from "../../../src/lambda/shared-distribution/triggers/create-auth-challenge.js";
import { TTL_ATTRIBUTE } from "../../../src/lambda/shared/signin.js";

const HANDLERS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/lambda/handlers",
);
const SHARED_DISTRIBUTION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/lambda/shared-distribution",
);

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(path.join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [path.join(dir, e.name)]
        : [],
  );
}

describe("expiry attribute name", () => {
  it("is expires_at", () => {
    expect(TTL_ATTRIBUTE).toBe("expires_at");
  });

  it("the per-address rate limiter writes it", async () => {
    const ddb = mockClient(DynamoDBClient);
    ddb.on(UpdateItemCommand).resolves({});
    await tryConsumeRateLimit({
      client: ddb as unknown as DynamoDBClient,
      tableName: "t",
      email: "a@example.com",
      hmacKey: "k",
      limit: 3,
      nowMs: 1_700_000_000_000,
    });
    const input = ddb.commandCalls(UpdateItemCommand)[0]!.args[0].input;
    expect(input.ExpressionAttributeNames?.["#ttl"]).toBe(TTL_ATTRIBUTE);
  });

  it("the per-IP rate limiter writes it", async () => {
    const ddb = mockClient(DynamoDBClient);
    ddb.on(UpdateItemCommand).resolves({});
    await tryConsumeIpRateLimit({
      client: ddb as unknown as DynamoDBClient,
      tableName: "t",
      ip: "203.0.113.7",
      limit: 10,
      nowMs: 1_700_000_000_000,
    });
    const input = ddb.commandCalls(UpdateItemCommand)[0]!.args[0].input;
    expect(input.ExpressionAttributeNames?.["#ttl"]).toBe(TTL_ATTRIBUTE);
  });

  it("no regional handler source names a literal `ttl` attribute any more", () => {
    // Covers pre-signup's counter, which has no focused test here.
    const offenders = sources(HANDLERS).filter((f) => {
      const code = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      return /["']ttl["']\s*[:,)\]}]|\bttl\s*:\s*\{\s*N\s*:/.test(code);
    });
    expect(offenders.map((f) => path.relative(HANDLERS, f))).toEqual([]);
  });

  it("nor does any shared-distribution source (it wrote `ttl` into a table whose TTL names expires_at)", () => {
    const offenders = sources(SHARED_DISTRIBUTION).filter((f) => {
      const code = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      return /["']ttl["']\s*[:,)\]}]|\bttl\s*:\s*\{\s*N\s*:/.test(code);
    });
    expect(offenders.map((f) => path.relative(SHARED_DISTRIBUTION, f))).toEqual([]);
  });

  it("nor an `expiresAt` DynamoDB attribute in the shared-distribution admin and trigger code", () => {
    // `expiresAt` is legitimate in the in-memory TTL cache; it must not name a table attribute.
    const offenders = sources(SHARED_DISTRIBUTION)
      .filter((f) => !f.endsWith("ttl-cache.ts"))
      .filter((f) => {
        const code = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
        return /expiresAt\s*:\s*\{\s*N\s*:|['"]expiresAt['"]/.test(code);
      });
    expect(offenders.map((f) => path.relative(SHARED_DISTRIBUTION, f))).toEqual([]);
  });
});

describe("the shared-distribution CreateAuthChallenge token row", () => {
  it("is written under expires_at, the attribute MagicLinkTokens' TTL names (and Verify compares)", async () => {
    const ddb = mockClient(DynamoDBClient);
    const ses = mockClient(SESClient);
    process.env["VESTIBULUM_CLIENT_CONFIG_TABLE"] = "ClientConfig";
    process.env["VESTIBULUM_TOKEN_TABLE"] = "MagicLinkTokens";
    process.env["VESTIBULUM_RATE_LIMIT_TABLE"] = "RateLimit";
    process.env["VESTIBULUM_DENYLIST_TABLE"] = "Denylist";
    process.env["VESTIBULUM_SES_FROM"] = "noreply@example.com";
    try {
      ddb
        .on(GetItemCommand)
        .resolvesOnce({
          Item: {
            clientId: { S: "ttl-test-client" },
            tenantId: { S: "tenant-a" },
            subdomain: { S: "acme" },
            siteBaseUrl: { S: "https://acme.tenants.example.com" },
            allowedEmailDomains: { SS: ["acme.com"] },
            createdAt: { S: "2024-01-01T00:00:00.000Z" },
          },
        })
        .resolves({});
      ddb.on(UpdateItemCommand).resolves({});
      ddb.on(PutItemCommand).resolves({});
      ses.on(SendEmailCommand).resolves({});
      const handler = createSharedCreateAuthChallengeHandler({
        dynamodb: ddb as unknown as DynamoDBClient,
        ses: ses as unknown as SESClient,
        nowMs: () => 1_700_000_000_000,
      });
      await handler({
        callerContext: { clientId: "ttl-test-client" },
        request: { userAttributes: { email: "user@acme.com" } },
        response: {},
      });
      const item = ddb.commandCalls(PutItemCommand)[0]!.args[0].input.Item!;
      expect(item[TTL_ATTRIBUTE]).toEqual({ N: String(1_700_000_000 + 15 * 60) });
      expect(item).not.toHaveProperty("ttl");
    } finally {
      for (const k of [
        "VESTIBULUM_CLIENT_CONFIG_TABLE",
        "VESTIBULUM_TOKEN_TABLE",
        "VESTIBULUM_RATE_LIMIT_TABLE",
        "VESTIBULUM_DENYLIST_TABLE",
        "VESTIBULUM_SES_FROM",
      ]) {
        Reflect.deleteProperty(process.env, k);
      }
    }
  });
});
