import { describe, it, expect } from "vitest";
import { App, Stack } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import {
  validateCustomAttributeDeclarations,
  toCognitoCustomAttributes,
  MAX_CUSTOM_ATTRIBUTES_PER_POOL,
  MAX_CUSTOM_ATTRIBUTE_NAME_LENGTH,
  CUSTOM_ATTRIBUTE_NAME_REGEX,
  type CustomAttributeDeclaration,
} from "../../lib/custom-attributes/index.js";

describe("custom-attributes", () => {
  describe("constants", () => {
    it("MAX_CUSTOM_ATTRIBUTES_PER_POOL is 50", () => {
      expect(MAX_CUSTOM_ATTRIBUTES_PER_POOL).toBe(50);
    });
    it("MAX_CUSTOM_ATTRIBUTE_NAME_LENGTH is 20", () => {
      expect(MAX_CUSTOM_ATTRIBUTE_NAME_LENGTH).toBe(20);
    });
    it("CUSTOM_ATTRIBUTE_NAME_REGEX matches valid names", () => {
      expect(CUSTOM_ATTRIBUTE_NAME_REGEX.test("tenantId")).toBe(true);
      expect(CUSTOM_ATTRIBUTE_NAME_REGEX.test("tenant_Id_123")).toBe(true);
    });
    it("CUSTOM_ATTRIBUTE_NAME_REGEX rejects invalid names", () => {
      expect(CUSTOM_ATTRIBUTE_NAME_REGEX.test("tenant-id")).toBe(false);
      expect(CUSTOM_ATTRIBUTE_NAME_REGEX.test("tenant id")).toBe(false);
      expect(CUSTOM_ATTRIBUTE_NAME_REGEX.test("")).toBe(false);
    });
  });

  describe("validateCustomAttributeDeclarations", () => {
    it("accepts a valid declaration array", () => {
      const decls: CustomAttributeDeclaration[] = [
        { name: "tenantId", dataType: "String", maxLength: 64 },
        { name: "role", dataType: "String", maxLength: 32 },
      ];
      expect(() => validateCustomAttributeDeclarations(decls)).not.toThrow();
    });

    it("throws on invalid name characters", () => {
      const decls: CustomAttributeDeclaration[] = [{ name: "tenant-id", dataType: "String" }];
      expect(() => validateCustomAttributeDeclarations(decls)).toThrow(/tenant-id/);
    });

    it("throws on name exceeding 20 chars", () => {
      const longName = "a".repeat(21);
      const decls: CustomAttributeDeclaration[] = [{ name: longName, dataType: "String" }];
      expect(() => validateCustomAttributeDeclarations(decls)).toThrow(/21.*char|char.*21/);
    });

    it("throws on duplicate names", () => {
      const decls: CustomAttributeDeclaration[] = [
        { name: "tenantId", dataType: "String" },
        { name: "tenantId", dataType: "String" },
      ];
      expect(() => validateCustomAttributeDeclarations(decls)).toThrow(/duplicate/i);
    });

    it("throws on required + immutable combination", () => {
      const decls: CustomAttributeDeclaration[] = [
        { name: "handle", dataType: "String", required: true, mutable: false },
      ];
      expect(() => validateCustomAttributeDeclarations(decls)).toThrow(
        /required.*immutable|immutable.*required/i,
      );
    });

    it("throws on minLength/maxLength for non-String types", () => {
      const decls: CustomAttributeDeclaration[] = [
        { name: "score", dataType: "Number", maxLength: 10 },
      ];
      expect(() => validateCustomAttributeDeclarations(decls)).toThrow(/minLength|maxLength/);
    });

    it("throws when minLength > maxLength", () => {
      const decls: CustomAttributeDeclaration[] = [
        { name: "tag", dataType: "String", minLength: 10, maxLength: 5 },
      ];
      expect(() => validateCustomAttributeDeclarations(decls)).toThrow(
        /minLength.*maxLength|greater/i,
      );
    });

    it("throws when count exceeds 50", () => {
      const decls: CustomAttributeDeclaration[] = Array.from({ length: 51 }, (_, i) => ({
        name: `attr${i}`,
        dataType: "String" as const,
      }));
      expect(() => validateCustomAttributeDeclarations(decls)).toThrow(/50/);
    });

    it("accepts exactly 50 attributes", () => {
      const decls: CustomAttributeDeclaration[] = Array.from({ length: 50 }, (_, i) => ({
        name: `attr${i.toString().padStart(2, "0")}`,
        dataType: "String" as const,
      }));
      expect(() => validateCustomAttributeDeclarations(decls)).not.toThrow();
    });
  });

  describe("toCognitoCustomAttributes", () => {
    it("produces a map with the correct keys", () => {
      const decls: CustomAttributeDeclaration[] = [
        { name: "tenantId", dataType: "String", maxLength: 64, mutable: true },
        { name: "role", dataType: "String", maxLength: 32, mutable: true },
        { name: "score", dataType: "Number", mutable: true },
        { name: "active", dataType: "Boolean", mutable: true },
        { name: "joinDate", dataType: "DateTime", mutable: true },
      ];
      const result = toCognitoCustomAttributes(decls);
      expect(Object.keys(result).sort()).toEqual([
        "active",
        "joinDate",
        "role",
        "score",
        "tenantId",
      ]);
    });

    it("produces the correct CDK attribute types", () => {
      const decls: CustomAttributeDeclaration[] = [
        { name: "myStr", dataType: "String", mutable: true },
        { name: "myNum", dataType: "Number", mutable: true },
        { name: "myBool", dataType: "Boolean", mutable: true },
        { name: "myDate", dataType: "DateTime", mutable: true },
      ];
      const result = toCognitoCustomAttributes(decls);

      // Check that each attribute is the correct CDK class.
      expect(result["myStr"]).toBeInstanceOf(cognito.StringAttribute);
      expect(result["myNum"]).toBeInstanceOf(cognito.NumberAttribute);
      expect(result["myBool"]).toBeInstanceOf(cognito.BooleanAttribute);
      expect(result["myDate"]).toBeInstanceOf(cognito.DateTimeAttribute);
    });

    it("integrates with CDK UserPool without error", () => {
      const app = new App();
      const stack = new Stack(app, "TestStack", {
        env: { account: "123456789012", region: "eu-west-1" },
      });

      const decls: CustomAttributeDeclaration[] = [
        { name: "tenantId", dataType: "String", maxLength: 64, mutable: true },
      ];

      new cognito.UserPool(stack, "Pool", {
        customAttributes: toCognitoCustomAttributes(decls),
      });

      expect(() => app.synth()).not.toThrow();
    });
  });
});
