/**
 * Test-only mock of `IMagicLinkIdentity`. Provides just enough surface
 * to let `MagicLinkAuthSite` synth without depending on Agent A's
 * concrete `MagicLinkIdentity` construct.
 *
 * Each resource is a CDK L2 instance attached to the test stack so
 * cross-stack token resolution behaves like the real composition.
 */

import {
  RemovalPolicy,
  Stack,
  aws_cognito as cognito,
  aws_dynamodb as dynamodb,
  aws_sns as sns,
} from "aws-cdk-lib";
import { Construct } from "constructs";

import type { AddAppClientProps, IMagicLinkIdentity } from "../../lib/_internal/identity-handle.js";

/**
 * Minimal mock implementing IMagicLinkIdentity. Construct inside the
 * test stack; pass into `MagicLinkAuthSite` via the `identity` prop.
 */
export class MockIdentity extends Construct implements IMagicLinkIdentity {
  public readonly cognitoPool: cognito.IUserPool;
  public readonly tokenTable: dynamodb.ITable;
  public readonly rateLimitTable: dynamodb.ITable;
  public readonly denylistTable: dynamodb.ITable;
  public readonly bounceTopic: sns.ITopic;
  public readonly preTokenGeneration: undefined = undefined;
  public readonly postConfirmation: undefined = undefined;
  public readonly federationEnabled: boolean = false;

  private readonly pool: cognito.UserPool;

  public constructor(scope: Construct, id: string) {
    super(scope, id);
    this.pool = new cognito.UserPool(this, "Pool", {
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.cognitoPool = this.pool;
    // Cast through unknown — `Table` is structurally `ITable` but
    // `exactOptionalPropertyTypes` rejects implicit `string` →
    // `string | undefined` widening on `tableStreamArn`.
    this.tokenTable = new dynamodb.Table(this, "TokenTable", {
      partitionKey: {
        name: "tokenHash",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    }) as unknown as dynamodb.ITable;
    this.rateLimitTable = new dynamodb.Table(this, "RateLimitTable", {
      partitionKey: { name: "key", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    }) as unknown as dynamodb.ITable;
    this.denylistTable = new dynamodb.Table(this, "DenylistTable", {
      partitionKey: {
        name: "emailHash",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    }) as unknown as dynamodb.ITable;
    this.bounceTopic = new sns.Topic(this, "BounceTopic");
  }

  public addAppClient(id: string, props: AddAppClientProps): cognito.UserPoolClient {
    void Stack.of(this); // align with real implementation's region reach.
    return this.pool.addClient(id, {
      generateSecret: props.generateSecret ?? false,
      ...(props.oauth && { oAuth: props.oauth }),
      ...(props.idTokenValidity && { idTokenValidity: props.idTokenValidity }),
      ...(props.refreshTokenValidity && {
        refreshTokenValidity: props.refreshTokenValidity,
      }),
      authFlows: { custom: true },
    });
  }
}
