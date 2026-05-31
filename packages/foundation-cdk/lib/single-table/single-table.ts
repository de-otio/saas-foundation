import * as cdk from "aws-cdk-lib";
import { Annotations } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatch_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import { HOUSE_CONSTRUCT_METADATA_KEY } from "../aspects/metadata-tags.js";

export interface SingleTableProps {
  /**
   * Physical table name. Required for downstream wiring.
   */
  readonly tableName: string;

  /**
   * Alarm topic for the read/write-spike alarms. Optional.
   */
  readonly alarmTopic?: sns.ITopic;

  /**
   * Removal policy. Default RETAIN (stateful resource).
   */
  readonly removalPolicy?: cdk.RemovalPolicy;

  /**
   * Enable point-in-time recovery. Default: true.
   *
   * COST: billed continuously by table size (~$0.20/GB-month in us-east-1).
   * Opt out for ephemeral / non-production tables.
   */
  readonly pointInTimeRecovery?: boolean;

  /**
   * PITR recovery window in days. Range 1–35; default 7.
   *
   * 7 days covers the "noticed corruption on Monday, it started over
   * the weekend" scenario and is the conventional recovery-window
   * starting point. Billing scales with table size and the retention
   * window — a 35-day window costs roughly 5× more on the PITR line
   * than a 7-day window for an identical table. Override to 35 for
   * compliance regimes that mandate a longer window. A synth-time
   * annotation fires when this value exceeds 14, mirroring the
   * Advanced Security annotation pattern.
   *
   * Ignored when pointInTimeRecovery is false.
   */
  readonly pointInTimeRecoveryDays?: number;

  /**
   * Include the canonical reverse-lookup GSI (gsi1pk / gsi1sk, ALL projection).
   * Default: true.
   *
   * COST: roughly doubles write cost and adds storage proportional to indexed items.
   */
  readonly enableGsi1?: boolean;

  /**
   * Enable DynamoDB Streams. Optional.
   * Set this when downstream consumers need change-data-capture.
   */
  readonly stream?: dynamodb.StreamViewType;

  /**
   * Write-spike alarm threshold in WCU/min (Sum statistic). Default: 200.
   */
  readonly writeSpikeThreshold?: number;

  /**
   * Read-spike alarm threshold in RCU/min (Sum statistic). Default: 500.
   */
  readonly readSpikeThreshold?: number;

  /**
   * Disable specific alarms. Default: both enabled.
   */
  readonly alarms?: {
    readonly writeSpike?: boolean;
    readonly readSpike?: boolean;
  };
}

export class SingleTablePropsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SingleTablePropsError";
  }
}

export class SingleTable extends Construct {
  public readonly table: dynamodb.Table;
  public readonly writeSpikeAlarm?: cloudwatch.Alarm;
  public readonly readSpikeAlarm?: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: SingleTableProps) {
    super(scope, id);

    // Mark this construct so HouseDefaultsAspect can identify managed tables.
    this.node.addMetadata(HOUSE_CONSTRUCT_METADATA_KEY, "SingleTable");

    const pitrEnabled = props.pointInTimeRecovery ?? true;
    const pitrDays = props.pointInTimeRecoveryDays ?? 7;

    if (pitrEnabled && (pitrDays < 1 || pitrDays > 35)) {
      throw new SingleTablePropsError(
        `pointInTimeRecoveryDays must be between 1 and 35 (got ${pitrDays})`,
      );
    }

    if (pitrEnabled && pitrDays > 14) {
      // Cost disclosure: emit a synth annotation so the extended window is
      // visible in `cdk synth` output and review. A 35-day window costs
      // roughly 5× more on the PITR line than the 7-day default.
      Annotations.of(this).addInfo(
        `[foundation-cdk:SingleTable] pointInTimeRecoveryDays=${pitrDays} exceeds 14. ` +
          `PITR billing scales with table size and the retention window — ` +
          `a ${pitrDays}-day window costs roughly ${(pitrDays / 7).toFixed(1)}× the 7-day default ` +
          `on the PITR line item (~$0.20/GB-month per 7-day increment in us-east-1). ` +
          `Set pointInTimeRecoveryDays to 7 to use the cost-pillar default.`,
      );
    }

    const enableGsi1 = props.enableGsi1 ?? true;
    const writeSpikeThreshold = props.writeSpikeThreshold ?? 200;
    const readSpikeThreshold = props.readSpikeThreshold ?? 500;
    const writeAlarmEnabled = props.alarms?.writeSpike ?? true;
    const readAlarmEnabled = props.alarms?.readSpike ?? true;

    this.table = new dynamodb.Table(this, "Table", {
      tableName: props.tableName,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: pitrEnabled
        ? {
            pointInTimeRecoveryEnabled: true,
            recoveryPeriodInDays: pitrDays,
          }
        : { pointInTimeRecoveryEnabled: false },
      ...(props.stream !== undefined ? { stream: props.stream } : {}),
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.RETAIN,
    });

    if (enableGsi1) {
      this.table.addGlobalSecondaryIndex({
        indexName: "gsi1",
        partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
        sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
        projectionType: dynamodb.ProjectionType.ALL,
      });
    }

    if (writeAlarmEnabled) {
      this.writeSpikeAlarm = new cloudwatch.Alarm(this, "WriteSpikeAlarm", {
        alarmDescription: `DynamoDB write throughput sustained above ${writeSpikeThreshold} WCU/min — possible runaway loop`,
        metric: this.table.metricConsumedWriteCapacityUnits({
          period: cdk.Duration.minutes(1),
          statistic: "Sum",
        }),
        threshold: writeSpikeThreshold,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });

      if (props.alarmTopic !== undefined) {
        this.writeSpikeAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(props.alarmTopic));
      }
    }

    if (readAlarmEnabled) {
      this.readSpikeAlarm = new cloudwatch.Alarm(this, "ReadSpikeAlarm", {
        alarmDescription: `DynamoDB read throughput sustained above ${readSpikeThreshold} RCU/min`,
        metric: this.table.metricConsumedReadCapacityUnits({
          period: cdk.Duration.minutes(1),
          statistic: "Sum",
        }),
        threshold: readSpikeThreshold,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });

      if (props.alarmTopic !== undefined) {
        this.readSpikeAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(props.alarmTopic));
      }
    }
  }
}
