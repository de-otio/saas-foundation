/**
 * AdminLambda — CDK construct for the shared-distribution admin Lambda.
 *
 * Provisions:
 * - Lambda function backed by the pre-built admin bundle (P3 wires the
 *   actual bundle; the path is a placeholder until then).
 * - Function URL with AuthType: AWS_IAM.
 * - Dual IAM permission grant (Oct 2025 change): both `lambda:InvokeFunctionUrl`
 *   and `lambda:InvokeFunction` (the latter restricted to Function URL calls
 *   via `lambda:InvokedViaFunctionUrl` condition key).
 * - IAM grants to Cognito, ClientConfig table, MagicLinkTokens table (read),
 *   and Reservations table.
 * - CloudWatch alarms: AllowlistChanged-RealTime, TenantDeleted-RealTime,
 *   CompensationTriggered (all zero-delay, subscribed to alarmTopic if set).
 *
 * See doc/vestibulum/shared-distribution/03-tenant-onboarding.md and
 * doc/vestibulum/shared-distribution/08-observability-and-audit.md.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

// ---------------------------------------------------------------------------
// Bundle-path helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Resolve a bundle directory relative to the package root. */
function resolveBundlePath(bundleName: string): string {
  // From `lib/shared-distribution-identity/`, package root is two levels up.
  const packageRoot = path.resolve(__dirname, '..', '..');
  return path.join(packageRoot, 'lambda-bundles', bundleName);
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AdminLambdaProps {
  /** The shared Cognito user pool. */
  readonly userPool: cognito.IUserPool;

  /** The ClientConfig DynamoDB table (primary + GSIs). */
  readonly clientConfigTable: dynamodb.ITable;

  /** The MagicLinkTokens table — read-only access granted to the admin Lambda. */
  readonly magicLinkTokensTable: dynamodb.ITable;

  /** The Reservations table used for atomic subdomain/tenantId reservation. */
  readonly reservationsTable: dynamodb.ITable;

  /**
   * Parent DNS label used to derive `siteBaseUrl`.
   * E.g. `tenants.example.com` → subdomain `acme` → `https://acme.tenants.example.com`.
   */
  readonly tenantSubdomainParent: string;

  /**
   * Principal that will be granted permission to invoke the admin Function URL.
   * Receives both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`
   * (with `InvokedViaFunctionUrl` condition on the latter).
   */
  readonly adminInvokePrincipal: iam.IPrincipal;

  /**
   * Optional CORS options for the admin Function URL.
   * Default: no CORS (`AllowOrigins: []`).
   * Wildcard `['*']` is refused at synth time — IAM-auth'd Function URLs
   * must not be wildcard-CORS.
   */
  readonly adminFunctionUrlCors?: lambda.FunctionUrlCorsOptions;

  /** Optional SNS topic for alarm actions. */
  readonly alarmTopic?: sns.ITopic;
}

// ---------------------------------------------------------------------------
// Construct
// ---------------------------------------------------------------------------

/**
 * Construct error type for AdminLambda synth-time validation failures.
 */
export class AdminLambdaPropsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminLambdaPropsError';
  }
}

export class AdminLambda extends Construct {
  /** The underlying Lambda function. */
  readonly fn: lambda.IFunction;

  /** The Function URL (AWS_IAM auth). */
  readonly functionUrl: lambda.IFunctionUrl;

  constructor(scope: Construct, id: string, props: AdminLambdaProps) {
    super(scope, id);

    // -------------------------------------------------------------------------
    // Synth-time validation: refuse wildcard CORS
    // -------------------------------------------------------------------------
    if (props.adminFunctionUrlCors?.allowedOrigins?.includes('*') === true) {
      throw new AdminLambdaPropsError(
        '[vestibulum-cdk:AdminLambda] adminFunctionUrlCors.allowedOrigins may ' +
          'not include "*". IAM-auth\'d Function URLs called with SigV4 ' +
          'credentials must not be wildcard-CORS. Pass explicit origins or ' +
          'omit the CORS option entirely.',
      );
    }

    // -------------------------------------------------------------------------
    // Lambda function
    //
    // Bundle path points at the pre-built admin bundle directory.
    // P3 will wire the actual bundle; for now we use a placeholder path
    // (tests synth against it, P3 populates the bundle).
    // -------------------------------------------------------------------------
    const adminFn = new lambda.Function(this, 'Fn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      code: lambda.Code.fromAsset(resolveBundlePath('admin')),
      handler: 'index.handler',
      logRetention: logs.RetentionDays.THREE_MONTHS,
      environment: {
        VESTIBULUM_USER_POOL_ID: props.userPool.userPoolId,
        VESTIBULUM_CLIENT_CONFIG_TABLE: props.clientConfigTable.tableName,
        VESTIBULUM_IDEMPOTENCY_TABLE: props.clientConfigTable.tableName + '-idempotency',
        VESTIBULUM_RESERVATIONS_TABLE: props.reservationsTable.tableName,
        VESTIBULUM_TENANT_PARENT: props.tenantSubdomainParent,
      },
      timeout: Duration.seconds(30),
      memorySize: 256,
    });

    this.fn = adminFn;

    // -------------------------------------------------------------------------
    // Function URL — AWS_IAM auth
    // -------------------------------------------------------------------------
    const funcUrl = adminFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      cors: props.adminFunctionUrlCors ?? { allowedOrigins: [] },
    });

    this.functionUrl = funcUrl;

    // -------------------------------------------------------------------------
    // IAM grants for the invoke principal (Oct 2025 dual-permission pattern)
    //
    // 1. `lambda:InvokeFunctionUrl` — required for Function URL invocations.
    // 2. `lambda:InvokeFunction` with `lambda:InvokedViaFunctionUrl` condition
    //    — restricts direct Lambda invocations to those originating from the
    //    Function URL only (no naked `lambda:InvokeFunction` from CLI/SDK).
    // -------------------------------------------------------------------------
    adminFn.addPermission('AdminInvokeUrl', {
      principal: props.adminInvokePrincipal,
      action: 'lambda:InvokeFunctionUrl',
      functionUrlAuthType: lambda.FunctionUrlAuthType.AWS_IAM,
    });

    // Restrict lambda:InvokeFunction to Function URL calls only via the
    // `lambda:InvokedViaFunctionUrl` condition key (Oct 2025 change).
    // CDK exposes this as the `invokedViaFunctionUrl: true` boolean prop.
    adminFn.addPermission('AdminInvokeFn', {
      principal: props.adminInvokePrincipal,
      action: 'lambda:InvokeFunction',
      invokedViaFunctionUrl: true,
    });

    // -------------------------------------------------------------------------
    // IAM grants for the Lambda execution role
    // -------------------------------------------------------------------------

    // Cognito: manage app clients + sign-out users
    adminFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:CreateUserPoolClient',
          'cognito-idp:DeleteUserPoolClient',
          'cognito-idp:ListUserPoolClients',
          'cognito-idp:AdminUserGlobalSignOut',
          'cognito-idp:ListUsers',
        ],
        resources: [props.userPool.userPoolArn],
      }),
    );

    // ClientConfig table — full read/write + GSI queries
    props.clientConfigTable.grantReadWriteData(adminFn);

    // MagicLinkTokens — read-only (for user-by-client queries if needed)
    props.magicLinkTokensTable.grantReadData(adminFn);

    // Reservations — TransactWriteItems + DeleteItem
    props.reservationsTable.grantReadWriteData(adminFn);

    // -------------------------------------------------------------------------
    // CloudWatch alarms (zero-delay, per 08 § CloudWatch alarms)
    // -------------------------------------------------------------------------
    const namespace = 'Vestibulum/SharedDistribution';

    const allowlistChangedAlarm = new cloudwatch.Alarm(this, 'AllowlistChangedAlarm', {
      alarmName: `${id}-AllowlistChanged-RealTime`,
      alarmDescription:
        'Real-time: allowedEmailDomains changed on a tenant. High-blast-radius operation.',
      metric: new cloudwatch.Metric({
        namespace,
        metricName: 'AllowlistChanged',
        period: Duration.minutes(1),
        statistic: 'Sum',
      }),
      threshold: 0,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const tenantDeletedAlarm = new cloudwatch.Alarm(this, 'TenantDeletedAlarm', {
      alarmName: `${id}-TenantDeleted-RealTime`,
      alarmDescription: 'Real-time: a tenant was deleted.',
      metric: new cloudwatch.Metric({
        namespace,
        metricName: 'TenantDeleted',
        period: Duration.minutes(1),
        statistic: 'Sum',
      }),
      threshold: 0,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const compensationAlarm = new cloudwatch.Alarm(this, 'CompensationAlarm', {
      alarmName: `${id}-CompensationTriggered`,
      alarmDescription:
        'Real-time: createTenant compensation step triggered (Cognito client created but DDB write failed).',
      metric: new cloudwatch.Metric({
        namespace,
        metricName: 'CompensationTriggered',
        period: Duration.minutes(1),
        statistic: 'Sum',
      }),
      threshold: 0,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Subscribe alarms to SNS topic if provided
    if (props.alarmTopic) {
      const snsAction = new cloudwatchActions.SnsAction(props.alarmTopic);
      allowlistChangedAlarm.addAlarmAction(snsAction);
      tenantDeletedAlarm.addAlarmAction(snsAction);
      compensationAlarm.addAlarmAction(snsAction);
    }
  }
}
