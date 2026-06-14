/**
 * Reconciler — CDK construct for the hourly orphan-detection Lambda.
 *
 * Provisions:
 * - Lambda function backed by the pre-built reconciler bundle.
 * - EventBridge scheduled rule: `rate(1 hour)`.
 * - IAM: ListUserPoolClients on the user pool + ReadData on ClientConfig.
 * - CloudWatch alarms:
 *   - `OrphanedAppClients-Sustained`: count > 0, sustained 1 hour.
 *   - `OrphanedConfigRows-Sustained`: count > 0, sustained 1 hour.
 *
 * See doc/vestibulum/shared-distribution/03-tenant-onboarding.md § Reconciler Lambda.
 * See doc/vestibulum/shared-distribution/08-observability-and-audit.md § CloudWatch alarms.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

// ---------------------------------------------------------------------------
// Bundle-path helper
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveBundlePath(bundleName: string): string {
  const packageRoot = path.resolve(__dirname, '..', '..');
  return path.join(packageRoot, 'lambda-bundles', bundleName);
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ReconcilerProps {
  /** The shared Cognito user pool. */
  readonly userPool: cognito.IUserPool;

  /** The ClientConfig DynamoDB table. */
  readonly clientConfigTable: dynamodb.ITable;

  /** Optional SNS topic for alarm actions. */
  readonly alarmTopic?: sns.ITopic;
}

// ---------------------------------------------------------------------------
// Construct
// ---------------------------------------------------------------------------

export class Reconciler extends Construct {
  /** The reconciler Lambda function. */
  readonly fn: lambda.IFunction;

  /** The hourly EventBridge rule. */
  readonly schedule: events.Rule;

  constructor(scope: Construct, id: string, props: ReconcilerProps) {
    super(scope, id);

    // -------------------------------------------------------------------------
    // Lambda function
    // -------------------------------------------------------------------------
    const reconcilerFn = new lambda.Function(this, 'Fn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      code: lambda.Code.fromAsset(resolveBundlePath('reconciler')),
      handler: 'index.handler',
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        VESTIBULUM_USER_POOL_ID: props.userPool.userPoolId,
        VESTIBULUM_CLIENT_CONFIG_TABLE: props.clientConfigTable.tableName,
      },
      timeout: Duration.seconds(300), // 5 min — generous for large pools
      memorySize: 256,
    });

    this.fn = reconcilerFn;

    // -------------------------------------------------------------------------
    // Hourly EventBridge schedule
    // -------------------------------------------------------------------------
    this.schedule = new events.Rule(this, 'Schedule', {
      schedule: events.Schedule.rate(Duration.hours(1)),
      description: 'Hourly orphan detection for shared-distribution ClientConfig',
    });

    this.schedule.addTarget(new eventsTargets.LambdaFunction(reconcilerFn));

    // -------------------------------------------------------------------------
    // IAM: list app clients + read ClientConfig
    // -------------------------------------------------------------------------
    reconcilerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:ListUserPoolClients'],
        resources: [props.userPool.userPoolArn],
      }),
    );

    props.clientConfigTable.grantReadData(reconcilerFn);

    // -------------------------------------------------------------------------
    // CloudWatch alarms (1-hour sustain, per 08 § CloudWatch alarms)
    //
    // 1-hour sustain absorbs onboarding-burst false positives while
    // catching genuine orphan accumulation within one operator-action window.
    // -------------------------------------------------------------------------
    const namespace = 'Vestibulum/SharedDistribution';

    // OrphanedAppClients: > 0 sustained for 1 hour (4 × 15-min evaluation
    // periods are more reliable than 1 × 1-hour period for EMF metrics).
    const orphanedAppClientsAlarm = new cloudwatch.Alarm(this, 'OrphanedAppClientsAlarm', {
      alarmName: `${id}-OrphanedAppClients-Sustained`,
      alarmDescription:
        'Orphaned Cognito app clients (clients with no matching ClientConfig row) ' +
        'detected for more than 1 hour. Operator action required.',
      metric: new cloudwatch.Metric({
        namespace,
        metricName: 'OrphanedAppClients',
        period: Duration.minutes(60),
        statistic: 'Sum',
      }),
      threshold: 0,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const orphanedConfigRowsAlarm = new cloudwatch.Alarm(this, 'OrphanedConfigRowsAlarm', {
      alarmName: `${id}-OrphanedConfigRows-Sustained`,
      alarmDescription:
        'Orphaned ClientConfig rows (rows with no matching Cognito app client) ' +
        'detected for more than 1 hour. Operator action required.',
      metric: new cloudwatch.Metric({
        namespace,
        metricName: 'OrphanedConfigRows',
        period: Duration.minutes(60),
        statistic: 'Sum',
      }),
      threshold: 0,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Subscribe to SNS topic if provided
    if (props.alarmTopic) {
      const snsAction = new cloudwatchActions.SnsAction(props.alarmTopic);
      orphanedAppClientsAlarm.addAlarmAction(snsAction);
      orphanedConfigRowsAlarm.addAlarmAction(snsAction);
    }
  }
}
