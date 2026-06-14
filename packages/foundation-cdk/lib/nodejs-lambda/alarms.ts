import { Duration } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatch_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sns from "aws-cdk-lib/aws-sns";
import type { Construct } from "constructs";

/**
 * Shared alarm-creation helpers for {@link NodejsLambda}.
 *
 * Each helper is a pure factory: given a Lambda function reference and
 * the threshold options, it constructs the alarm under the function's
 * scope. The construct itself wires actions / stores the alarm reference.
 *
 * Alarm names are intentionally not set — CDK auto-generates them from
 * the logical ID so cross-stack collisions on the alarm namespace cannot
 * happen. See doc/foundation-cdk/02-nodejs-lambda.md § Naming.
 */

export interface AlarmActionOptions {
  /**
   * Optional SNS topic for the alarm action. When unset, the alarm is
   * created without an action; consumers can attach actions later via
   * the public alarm property.
   */
  readonly alarmTopic?: sns.ITopic;
}

function maybeAttachAction(alarm: cloudwatch.Alarm, topic: sns.ITopic | undefined): void {
  if (topic !== undefined) {
    alarm.addAlarmAction(new cloudwatch_actions.SnsAction(topic));
  }
}

/**
 * Errors > 5 in any 5-minute window. Tuned to avoid noise from background
 * retry storms.
 */
export function createErrorAlarm(
  scope: Construct,
  fn: lambda.IFunction,
  opts: AlarmActionOptions = {},
): cloudwatch.Alarm {
  const alarm = new cloudwatch.Alarm(scope, "ErrorAlarm", {
    alarmDescription: `Lambda ${fn.functionName} errored more than 5 times in 5 minutes`,
    metric: fn.metricErrors({
      statistic: "Sum",
      period: Duration.minutes(5),
    }),
    threshold: 5,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    evaluationPeriods: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  maybeAttachAction(alarm, opts.alarmTopic);
  return alarm;
}

/**
 * Any throttle within a 1-minute window. Direct port of trellis's
 * {@code addThrottleAlarm}: a throttled invocation means the function hit
 * its reserved-concurrency cap or the account pool is exhausted.
 */
export function createThrottleAlarm(
  scope: Construct,
  fn: lambda.IFunction,
  opts: AlarmActionOptions = {},
): cloudwatch.Alarm {
  const alarm = new cloudwatch.Alarm(scope, "ThrottleAlarm", {
    alarmDescription: `Lambda ${fn.functionName} is being throttled (concurrency limit reached)`,
    metric: fn.metricThrottles({
      statistic: "Sum",
      period: Duration.minutes(1),
    }),
    threshold: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    evaluationPeriods: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  maybeAttachAction(alarm, opts.alarmTopic);
  return alarm;
}

export interface DurationAlarmOptions extends AlarmActionOptions {
  /**
   * The function's configured timeout. Used to derive the alarm threshold
   * (0.8 × timeout). Required because the duration alarm only makes sense
   * relative to the timeout.
   */
  readonly timeout: Duration;
}

/**
 * p99 duration consistently within 20% of the timeout. Early signal that
 * timeouts will start being hit; lets the operator tune memory/code
 * before the timeout-related Errors fire.
 */
export function createDurationAlarm(
  scope: Construct,
  fn: lambda.IFunction,
  opts: DurationAlarmOptions,
): cloudwatch.Alarm {
  const thresholdMillis = Math.floor(opts.timeout.toMilliseconds() * 0.8);
  const alarm = new cloudwatch.Alarm(scope, "DurationAlarm", {
    alarmDescription: `Lambda ${fn.functionName} p99 duration is within 20% of the configured timeout`,
    metric: fn.metricDuration({
      statistic: "p99",
      period: Duration.minutes(5),
    }),
    threshold: thresholdMillis,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    evaluationPeriods: 2,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  maybeAttachAction(alarm, opts.alarmTopic);
  return alarm;
}
