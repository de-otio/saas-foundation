/**
 * `ClientConfig` DDB table helper for `SharedDistributionIdentity`.
 *
 * The table is the single source of truth for tenant configuration in
 * the shared-pool model. Its shape is defined in
 * [03-tenant-onboarding.md] § ClientConfig table shape:
 *
 * - PK: `clientId` (Cognito app-client ID).
 * - GSI `SubdomainIndex`: PK `subdomain`.
 * - GSI `TenantIdIndex`: PK `tenantId`.
 *
 * Encryption defaults to `AWS_MANAGED` (DDB-owned KMS key, visible in
 * the KMS console). Customer-managed via `tableKmsKey`.
 *
 * PITR enabled (per the design's default for stateful resources).
 * RemovalPolicy `RETAIN` so accidental stack deletion preserves tenant
 * data.
 *
 * The helper exposes IAM grant shortcuts so callers (trigger Lambdas,
 * admin Lambda) don't repeat `table.grantReadData(fn)` boilerplate
 * across the construct.
 */

import { RemovalPolicy } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";

export interface ClientConfigTableProps {
  /**
   * Optional customer-managed KMS key. When unset, the table uses
   * `AWS_MANAGED` encryption (DDB-owned KMS key, visible in the KMS
   * console). Per [03-tenant-onboarding.md] § ClientConfig table
   * shape: NOT `AWS_OWNED` (the silent default).
   */
  readonly tableKmsKey?: kms.IKey;
}

export const CLIENT_CONFIG_SUBDOMAIN_INDEX = "SubdomainIndex";
export const CLIENT_CONFIG_TENANT_ID_INDEX = "TenantIdIndex";

export class ClientConfigTable extends Construct {
  /** The underlying CDK DDB table. */
  readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: ClientConfigTableProps = {}) {
    super(scope, id);

    const encryption: dynamodb.TableEncryption = props.tableKmsKey
      ? dynamodb.TableEncryption.CUSTOMER_MANAGED
      : dynamodb.TableEncryption.AWS_MANAGED;

    this.table = new dynamodb.Table(this, "Table", {
      partitionKey: {
        name: "clientId",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption,
      ...(props.tableKmsKey ? { encryptionKey: props.tableKmsKey } : {}),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.table.addGlobalSecondaryIndex({
      indexName: CLIENT_CONFIG_SUBDOMAIN_INDEX,
      partitionKey: { name: "subdomain", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.table.addGlobalSecondaryIndex({
      indexName: CLIENT_CONFIG_TENANT_ID_INDEX,
      partitionKey: { name: "tenantId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
  }

  /**
   * Grant read access on the base table AND both GSIs. Trigger
   * handlers need GSI access (resolves subdomain → clientId during
   * the `auth-verify` flow), so granting only on the base table is
   * insufficient.
   */
  grantRead(grantee: iam.IGrantable): iam.Grant {
    return this.table.grantReadData(grantee);
  }

  /** Grant full read+write on the table + GSIs (for the admin Lambda). */
  grantReadWrite(grantee: iam.IGrantable): iam.Grant {
    return this.table.grantReadWriteData(grantee);
  }
}
