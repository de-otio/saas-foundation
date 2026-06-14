import { Duration } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatch_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

export interface IteratorAgeAlarmOptions {
  /**
   * Threshold in minutes. Default: 5. Override based on the consumer's
   * SLO for the queue consumer.
   */
  readonly thresholdMinutes?: number;

  /**
   * Optional SNS topic for the alarm action. When unset the alarm is
   * still created; the consumer can attach actions later.
   */
  readonly alarmTopic?: sns.ITopic;
}

/**
 * Build a CloudWatch alarm on the SQS event-source mapping's
 * IteratorAge — the canonical "queue consumer is falling behind"
 * signal. The alarm is created under {@code fn}'s scope so its
 * removal tracks the function lifecycle.
 *
 * Pair with {@code QueueWithDlq}: the DLQ alarm tells you the consumer
 * gave up; this alarm tells you it is struggling.
 *
 * @internal Used by NodejsLambda#addQueueIteratorAgeAlarm. Exported as
 *   a standalone function so the construct doesn't grow the public
 *   surface beyond the documented method.
 */
export function addQueueIteratorAgeAlarm(
  fn: lambda.IFunction,
  queue: sqs.IQueue,
  opts: IteratorAgeAlarmOptions = {},
): cloudwatch.Alarm {
  const thresholdMinutes = opts.thresholdMinutes ?? 5;
  // IFunction is always also an IConstruct (IFunction extends IResource
  // extends IConstruct); fall back to the queue's scope if the type
  // narrowing ever fails (defensive).
  const scope: Construct = Construct.isConstruct(fn) ? fn : (queue as unknown as Construct);
  // Suffix the construct id with the queue's node id to keep multiple
  // iterator-age alarms (one per consumed queue) unique under the same
  // function scope.
  const alarmId = `IteratorAgeAlarm-${queue.node.id}`;

  const alarm = new cloudwatch.Alarm(scope, alarmId, {
    alarmDescription:
      `Lambda ${fn.functionName} iterator age exceeded ${thresholdMinutes} minutes on ` +
      `queue ${queue.queueName} (consumer falling behind)`,
    metric: new cloudwatch.Metric({
      namespace: "AWS/Lambda",
      metricName: "IteratorAge",
      dimensionsMap: {
        FunctionName: fn.functionName,
        Resource: fn.functionName,
        EventSourceArn: queue.queueArn,
      },
      statistic: "Maximum",
      period: Duration.minutes(1),
    }),
    threshold: Duration.minutes(thresholdMinutes).toMilliseconds(),
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    evaluationPeriods: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });

  if (opts.alarmTopic !== undefined) {
    alarm.addAlarmAction(new cloudwatch_actions.SnsAction(opts.alarmTopic));
  }

  return alarm;
}
