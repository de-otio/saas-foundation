/**
 * H-1 enforcement: source-level grep over the DynamoAuditStore
 * implementation. Fails CI if forbidden DynamoDB mutation commands
 * appear in the file.
 *
 * Why a grep test? Three reasons:
 *
 *   1. **IAM is defence-in-depth, not the primary guard.** A consumer
 *      who provisions the audit table with the documented PutItem-only
 *      grant gets the strong protection (even an attacker with RCE
 *      cannot delete rows). But if some future commit inside
 *      foundation accidentally adds an UpdateItem call, the IAM grant
 *      would deny it — and the application would surface a confusing
 *      "AccessDenied" error in production. A source-level guard
 *      catches the regression in CI before it ships.
 *
 *   2. **Lint can't see it.** ESLint rules at the import level
 *      wouldn't fire — the SDK module is legitimately imported (we
 *      use PutItemCommand). What we want to forbid is a *usage*
 *      pattern, and a grep is the simplest way to express it.
 *
 *   3. **Audit integrity is binary.** Letting one "harmless update"
 *      slip in defeats the append-only contract for every row the
 *      class ever writes. The test is paranoid because the property
 *      being protected is the integrity foundation of the security
 *      story.
 *
 * The companion file `src/audit/prisma.ts` is checked by an analogous
 * test inside `prisma.test.ts` for `prisma.auditEvent.update`,
 * `delete`, etc.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("H-1 IAM-shape: DynamoAuditStore source", () => {
  const sourcePath = resolve(__dirname, "../../src/audit/dynamo-store.ts");
  const source = readFileSync(sourcePath, "utf-8");

  /**
   * Strip line and block comments before scanning. The file documents
   * the forbidden commands in its header as part of the explanation
   * for the rule, so comment-stripping prevents false positives.
   */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  const code = stripComments(source);

  it("does not call UpdateItemCommand", () => {
    expect(code).not.toMatch(/\bUpdateItemCommand\b/);
  });

  it("does not call DeleteItemCommand", () => {
    expect(code).not.toMatch(/\bDeleteItemCommand\b/);
  });

  it("does not call BatchWriteItemCommand", () => {
    expect(code).not.toMatch(/\bBatchWriteItemCommand\b/);
  });

  it("does not call TransactWriteItemsCommand (which can include deletes)", () => {
    expect(code).not.toMatch(/\bTransactWriteItemsCommand\b/);
  });

  it("does use PutItemCommand", () => {
    // Positive control: if PutItemCommand stops appearing, the file
    // has been refactored and this test needs reviewing.
    expect(code).toMatch(/\bPutItemCommand\b/);
  });
});

describe("H-1 IAM-shape: PostgresAuditStore source", () => {
  const sourcePath = resolve(__dirname, "../../src/audit/prisma.ts");
  const source = readFileSync(sourcePath, "utf-8");

  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  const code = stripComments(source);

  it("does not call auditEvent.update", () => {
    expect(code).not.toMatch(/auditEvent\s*\.\s*update\b/);
  });

  it("does not call auditEvent.delete", () => {
    expect(code).not.toMatch(/auditEvent\s*\.\s*delete\b/);
  });

  it("does not call auditEvent.upsert", () => {
    expect(code).not.toMatch(/auditEvent\s*\.\s*upsert\b/);
  });

  it("does not call auditEvent.updateMany", () => {
    expect(code).not.toMatch(/auditEvent\s*\.\s*updateMany\b/);
  });

  it("does not call auditEvent.deleteMany", () => {
    expect(code).not.toMatch(/auditEvent\s*\.\s*deleteMany\b/);
  });

  it("does call auditEvent.create", () => {
    expect(code).toMatch(/auditEvent\s*\.\s*create\b/);
  });
});
