/**
 * Coverage tests for the internal `ClientConfigTable` and
 * `ReservationsTable` helpers — exercises grant methods and the
 * customer-managed-KMS branch.
 */

import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { describe, expect, it } from "vitest";

import {
  CLIENT_CONFIG_SUBDOMAIN_INDEX,
  CLIENT_CONFIG_TENANT_ID_INDEX,
  ClientConfigTable,
  ReservationsTable,
} from "../../lib/shared-distribution-identity/index.js";

interface DdbTableResource {
  Properties?: {
    SSESpecification?: { SSEEnabled?: boolean; SSEType?: string; KMSMasterKeyId?: unknown };
  };
}

function findDdbTables(template: Template): Record<string, DdbTableResource> {
  return template.findResources("AWS::DynamoDB::Table");
}

function makeStack(name: string): cdk.Stack {
  const app = new cdk.App();
  return new cdk.Stack(app, name, {
    env: { account: "123456789012", region: "us-east-1" },
    stackName: name,
  });
}

function makeConsumerFn(stack: cdk.Stack, id: string): lambda.Function {
  return new lambda.Function(stack, id, {
    runtime: lambda.Runtime.NODEJS_22_X,
    code: lambda.Code.fromInline("exports.handler = async () => {};"),
    handler: "index.handler",
  });
}

// ---------------------------------------------------------------------------
// ClientConfigTable
// ---------------------------------------------------------------------------

describe("ClientConfigTable", () => {
  it("creates a table with PK clientId and two GSIs", () => {
    const stack = makeStack("ClientConfigBasicStack");
    new ClientConfigTable(stack, "Table");

    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [{ AttributeName: "clientId", KeyType: "HASH" }],
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: CLIENT_CONFIG_SUBDOMAIN_INDEX }),
        Match.objectLike({ IndexName: CLIENT_CONFIG_TENANT_ID_INDEX }),
      ]),
    });
  });

  it("uses AWS_MANAGED encryption when no kms key is supplied", () => {
    const stack = makeStack("ClientConfigDefaultEncStack");
    new ClientConfigTable(stack, "Table");
    const template = Template.fromStack(stack);
    const tables = findDdbTables(template);
    for (const [, t] of Object.entries(tables)) {
      expect(t.Properties?.SSESpecification?.KMSMasterKeyId).toBeUndefined();
    }
  });

  it("uses customer-managed KMS encryption when a key is supplied", () => {
    const stack = makeStack("ClientConfigCmkEncStack");
    const key = new kms.Key(stack, "TableKey", { enableKeyRotation: true });
    new ClientConfigTable(stack, "Table", { tableKmsKey: key });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      SSESpecification: Match.objectLike({
        SSEEnabled: true,
        SSEType: "KMS",
      }),
    });
  });

  it("retains the table on stack deletion", () => {
    const stack = makeStack("ClientConfigRetainStack");
    new ClientConfigTable(stack, "Table");
    Template.fromStack(stack).hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  it("grantRead emits a read-only policy", () => {
    const stack = makeStack("ClientConfigGrantReadStack");
    const table = new ClientConfigTable(stack, "Table");
    const fn = makeConsumerFn(stack, "Consumer");
    const grant = table.grantRead(fn);
    expect(grant).toBeDefined();

    const template = Template.fromStack(stack);
    const policies = template.findResources("AWS::IAM::Policy");
    const readPolicies = Object.values(policies).filter((p) =>
      JSON.stringify(p).includes("dynamodb:GetItem"),
    );
    expect(readPolicies.length).toBeGreaterThan(0);
  });

  it("grantReadWrite emits a read+write policy", () => {
    const stack = makeStack("ClientConfigGrantReadWriteStack");
    const table = new ClientConfigTable(stack, "Table");
    const fn = makeConsumerFn(stack, "Consumer");
    const grant = table.grantReadWrite(fn);
    expect(grant).toBeDefined();

    const template = Template.fromStack(stack);
    const policies = template.findResources("AWS::IAM::Policy");
    const rwPolicies = Object.values(policies).filter((p) =>
      JSON.stringify(p).includes("dynamodb:PutItem"),
    );
    expect(rwPolicies.length).toBeGreaterThan(0);
  });

  it("accepts an IGrantable that is not a Function (e.g. a Role)", () => {
    const stack = makeStack("ClientConfigRoleGrantStack");
    const table = new ClientConfigTable(stack, "Table");
    const role = new iam.Role(stack, "TestRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    expect(() => table.grantRead(role)).not.toThrow();
    expect(() => table.grantReadWrite(role)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ReservationsTable
// ---------------------------------------------------------------------------

describe("ReservationsTable", () => {
  it("creates a table with PK 'key' and TTL 'expiresAt'", () => {
    const stack = makeStack("ReservationsBasicStack");
    new ReservationsTable(stack, "Reservations");

    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [{ AttributeName: "key", KeyType: "HASH" }],
      TimeToLiveSpecification: {
        AttributeName: "expiresAt",
        Enabled: true,
      },
    });
  });

  it("uses AWS_MANAGED encryption (no customer-managed knob)", () => {
    const stack = makeStack("ReservationsEncStack");
    new ReservationsTable(stack, "Reservations");
    const template = Template.fromStack(stack);
    const tables = findDdbTables(template);
    for (const [, t] of Object.entries(tables)) {
      // AWS_MANAGED: SSEEnabled is true but no KMSMasterKeyId.
      expect(t.Properties?.SSESpecification?.KMSMasterKeyId).toBeUndefined();
    }
  });

  it("uses PAY_PER_REQUEST billing", () => {
    const stack = makeStack("ReservationsBillingStack");
    new ReservationsTable(stack, "Reservations");
    Template.fromStack(stack).hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
    });
  });

  it("retains on stack deletion", () => {
    const stack = makeStack("ReservationsRetainStack");
    new ReservationsTable(stack, "Reservations");
    Template.fromStack(stack).hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  it("grantReadWrite emits a read+write policy", () => {
    const stack = makeStack("ReservationsGrantStack");
    const table = new ReservationsTable(stack, "Reservations");
    const fn = makeConsumerFn(stack, "Consumer");
    const grant = table.grantReadWrite(fn);
    expect(grant).toBeDefined();

    const template = Template.fromStack(stack);
    const policies = template.findResources("AWS::IAM::Policy");
    const rwPolicies = Object.values(policies).filter((p) =>
      JSON.stringify(p).includes("dynamodb:PutItem"),
    );
    expect(rwPolicies.length).toBeGreaterThan(0);
  });
});
