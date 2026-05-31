import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatch_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as kms from "aws-cdk-lib/aws-kms";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { HOUSE_CONSTRUCT_METADATA_KEY } from "../aspects/metadata-tags.js";

export interface QueueWithDlqProps {
  /**
   * Physical queue name. The DLQ is named `${queueName}-dlq`.
   */
  readonly queueName: string;

  /**
   * Visibility timeout (seconds). Should exceed the maximum expected
   * consumer processing time. Default: 30.
   */
  readonly visibilityTimeoutSeconds?: number;

  /**
   * Main-queue retention (days). Default: 3.
   * AWS allows 1 minute–14 days.
   */
  readonly retentionPeriodDays?: number;

  /**
   * DLQ retention (days). Default: 14 (maximum).
   * Long retention because DLQ investigation often happens days after the failure.
   */
  readonly dlqRetentionDays?: number;

  /**
   * After how many failed receives a message moves to the DLQ. Default: 3.
   */
  readonly maxReceiveCount?: number;

  /**
   * Encryption. Defaults to SQS-managed. Pass a KMS key for
   * customer-managed encryption.
   */
  readonly encryption?:
    | { readonly kind: "sqs-managed" }
    | { readonly kind: "kms-managed" }
    | { readonly kind: "customer-managed"; readonly key: kms.IKey };

  /**
   * Alarm topic for the DLQ-non-empty alarm. When unset, the alarm
   * is still created but has no action.
   */
  readonly alarmTopic?: sns.ITopic;
}

function resolveEncryption(
  encryption: QueueWithDlqProps["encryption"],
): Pick<sqs.QueueProps, "encryption" | "encryptionMasterKey"> {
  if (encryption === undefined || encryption.kind === "sqs-managed") {
    return { encryption: sqs.QueueEncryption.SQS_MANAGED };
  }
  if (encryption.kind === "kms-managed") {
    return { encryption: sqs.QueueEncryption.KMS_MANAGED };
  }
  // customer-managed
  return {
    encryption: sqs.QueueEncryption.KMS,
    encryptionMasterKey: encryption.key,
  };
}

export class QueueWithDlq extends Construct {
  public readonly queue: sqs.Queue;
  public readonly dlq: sqs.Queue;
  public readonly dlqAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: QueueWithDlqProps) {
    super(scope, id);

    // Mark this construct so HouseDefaultsAspect can identify managed queues.
    this.node.addMetadata(HOUSE_CONSTRUCT_METADATA_KEY, "QueueWithDlq");

    const encryptionProps = resolveEncryption(props.encryption);

    this.dlq = new sqs.Queue(this, "Dlq", {
      queueName: `${props.queueName}-dlq`,
      retentionPeriod: cdk.Duration.days(props.dlqRetentionDays ?? 14),
      ...encryptionProps,
    });
    this.dlq.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    this.queue = new sqs.Queue(this, "Queue", {
      queueName: props.queueName,
      visibilityTimeout: cdk.Duration.seconds(props.visibilityTimeoutSeconds ?? 30),
      retentionPeriod: cdk.Duration.days(props.retentionPeriodDays ?? 3),
      ...encryptionProps,
      deadLetterQueue: {
        queue: this.dlq,
        maxReceiveCount: props.maxReceiveCount ?? 3,
      },
    });
    this.queue.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    // Alarm when any message lands in DLQ — indicates repeated processing failures
    this.dlqAlarm = new cloudwatch.Alarm(this, "DlqAlarm", {
      alarmDescription: `DLQ for ${props.queueName} has messages — indicates repeated processing failures`,
      metric: this.dlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    if (props.alarmTopic !== undefined) {
      this.dlqAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(props.alarmTopic));
    }
  }
}
