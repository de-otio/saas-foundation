/**
 * Reservations table for shared-distribution onboarding.
 *
 * Per [03-tenant-onboarding.md] § Why the reservation step: the admin
 * Lambda atomically reserves both `subdomain#...` and `tenantId#...`
 * before calling Cognito, closing the race between two concurrent
 * `createTenant` calls.
 *
 * Shape:
 *   - PK `key` (`subdomain#<subdomain>` or `tenantId#<id>`).
 *   - TTL attribute `expiresAt` — 60-second window so a crashed admin
 *     Lambda doesn't leave the namespace permanently blocked.
 *   - Encryption AWS_MANAGED (short-lived, not sensitive — no
 *     customer-managed-KMS knob on this one).
 *
 * RemovalPolicy `RETAIN` is overkill for a table whose every row
 * expires in 60s, but the design's blanket policy for stateful
 * resources is RETAIN, and an empty table is cheap.
 */

import { RemovalPolicy } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

export class ReservationsTable extends Construct {
  /** The underlying CDK DDB table. */
  readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.table = new dynamodb.Table(this, "Table", {
      partitionKey: {
        name: "key",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Always AWS_MANAGED — short-lived rows, no customer-managed
      // KMS knob exposed.
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "expiresAt",
      // PITR is overkill for a 60-second-TTL table; skip to save cost.
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }

  /** Grant transactional read+write — needed by the admin Lambda. */
  grantReadWrite(grantee: iam.IGrantable): iam.Grant {
    return this.table.grantReadWriteData(grantee);
  }
}
