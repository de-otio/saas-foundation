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
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";

import { tryConsumeIpRateLimit } from "../../../src/lambda/handlers/auth-login/ip-rate-limit.js";
import { tryConsumeRateLimit } from "../../../src/lambda/handlers/create-auth-challenge/rate-limit.js";
import { TTL_ATTRIBUTE } from "../../../src/lambda/shared/signin.js";

const HANDLERS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/lambda/handlers",
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
});
