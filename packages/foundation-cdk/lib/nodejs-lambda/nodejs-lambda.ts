import { Annotations, Duration } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, type NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { createDurationAlarm, createErrorAlarm, createThrottleAlarm } from "./alarms.js";
import { addQueueIteratorAgeAlarm, type IteratorAgeAlarmOptions } from "./iterator-age-alarm.js";
import { buildPrismaCommandHooks, type PrismaBundlingOptions } from "./prisma-bundling.js";
import { HOUSE_CONSTRUCT_METADATA_KEY } from "../aspects/metadata-tags.js";

export class NodejsLambdaPropsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodejsLambdaPropsError";
  }
}

export interface NodejsLambdaProps {
  /**
   * Absolute path to the entry file. The consumer owns this path —
   * foundation-cdk does not assume a particular source layout.
   *
   * Typical pattern:
   *   entry: path.join(__dirname, '../../lambda/hourly-cron.ts'),
   */
  readonly entry: string;

  /**
   * Exported handler name. Default `'handler'`.
   */
  readonly handler?: string;

  /**
   * Physical Lambda function name. Required (not optional) because
   * downstream wiring — Grafana dashboard dimensions, EventBridge rule
   * targets, alarm dimensions — references the function by physical
   * name. Auto-generated names invalidate downstream references on
   * every replacement.
   *
   * Must be globally unique within the account+region; stage/env
   * prefix every name (e.g. `${appName}-${stage}-${role}`).
   */
  readonly functionName: string;

  /**
   * Reserved concurrent executions. Optional.
   *
   * Unset (default): the function uses the account's unreserved pool.
   * Set to a positive number: caps the function AND reserves that
   * capacity. AWS requires at least 100 units of unreserved
   * concurrency to remain in the account; the sum of every reservation
   * cannot exceed `accountQuota - 100`. Deploys that violate the floor
   * fail at CloudFormation apply.
   *
   * The construct does not validate the global sum; that check would
   * require walking the construct tree (deferred to a future
   * `AccountReservationBudgetAspect`).
   */
  readonly reservedConcurrentExecutions?: number;

  readonly environment?: Readonly<Record<string, string>>;
  /** Default: 256 MB. */
  readonly memorySize?: number;
  /** Default: 30 seconds. */
  readonly timeout?: Duration;

  readonly role?: iam.IRole;
  readonly vpc?: NodejsFunctionProps["vpc"];
  readonly vpcSubnets?: NodejsFunctionProps["vpcSubnets"];
  readonly securityGroups?: NodejsFunctionProps["securityGroups"];
  readonly logGroup?: NodejsFunctionProps["logGroup"];
  readonly layers?: ReadonlyArray<lambda.ILayerVersion>;

  /**
   * Optional KMS key for CloudWatch Logs encryption. When unset, the
   * CDK-managed log group is encrypted with the AWS-managed
   * CloudWatch key (adequate for most workloads). Set this for
   * EU-residency or customer-managed-key compliance postures.
   *
   * Ignored when `logGroup` is set (the consumer's pre-created group
   * carries its own encryption config).
   */
  readonly logsEncryptionKey?: kms.IKey;

  /**
   * CloudWatch Logs storage class for the construct-created log group.
   *
   * - `'standard'` (default): full Logs Insights query throughput.
   * - `'infrequent-access'`: storage is roughly half the price of
   *   Standard, with the trade-off that Logs Insights queries cost
   *   more per scanned GB. Pick this for log streams that are
   *   written constantly but queried rarely (audit, bounce-handler,
   *   security-event streams).
   *
   * Ignored when `logGroup` is set (the consumer's pre-created group
   * carries its own class).
   *
   * @default 'standard'
   */
  readonly logClass?: "standard" | "infrequent-access";

  /**
   * SNS topic for alarm actions. When set, the construct's
   * error / throttle / duration alarms wire to this topic. When unset,
   * alarms are still created but have no action — attach actions
   * later via the public alarm properties.
   */
  readonly alarmTopic?: sns.ITopic;

  /**
   * Disable specific alarms. Default: all three enabled. Setting an
   * entry to `false` skips that alarm (it is not created).
   */
  readonly alarms?: {
    readonly errors?: boolean;
    readonly throttles?: boolean;
    readonly duration?: boolean;
  };

  /**
   * Acknowledge that this function runs in a VPC without an X-Ray VPC
   * interface endpoint configured. By default the construct fails synth
   * when `vpc` is set and X-Ray ACTIVE (the construct default) is paired
   * with no documented X-Ray reachability path — silent X-Ray trace
   * drops are a debug-the-debugger failure mode. Set to true to
   * suppress the check if you have verified reachability via another
   * route (NAT egress, separate VPC endpoint).
   *
   * @default false
   */
  readonly acknowledgeXrayVpcReachability?: boolean;

  /**
   * Bundle the Prisma client + Linux query engines into the Lambda
   * zip. When set, esbuild externalises `@prisma/client` and
   * afterBundling commands copy `node_modules/.prisma/client` +
   * engines into the output dir.
   *
   * Pass `true` for default options (rhel + linux-arm64). Default:
   * disabled.
   */
  readonly prismaBundling?: PrismaBundlingOptions | true;

  /**
   * Additional modules to mark as external in esbuild. Always
   * includes `@aws-sdk/*` (provided by the Lambda runtime). When
   * `prismaBundling` is set, `@prisma/client` is also added
   * automatically.
   */
  readonly externalModules?: ReadonlyArray<string>;
}

interface ResolvedAlarmFlags {
  readonly errors: boolean;
  readonly throttles: boolean;
  readonly duration: boolean;
}

function resolveAlarmFlags(alarms: NodejsLambdaProps["alarms"]): ResolvedAlarmFlags {
  return {
    errors: alarms?.errors ?? true,
    throttles: alarms?.throttles ?? true,
    duration: alarms?.duration ?? true,
  };
}

/**
 * `NodejsLambda` is the house wrapper around CDK's `NodejsFunction`:
 * ARM_64, Node 24, X-Ray active tracing, 30-day log retention, optional
 * Prisma client bundling, and three default alarms (errors / throttles /
 * p99-duration) attached to an optional SNS topic.
 *
 * See doc/foundation-cdk/02-nodejs-lambda.md for the full rationale.
 */
export class NodejsLambda extends NodejsFunction {
  public readonly errorAlarm?: cloudwatch.Alarm;
  public readonly throttleAlarm?: cloudwatch.Alarm;
  public readonly durationAlarm?: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: NodejsLambdaProps) {
    NodejsLambda.validate(props);

    const timeout = props.timeout ?? Duration.seconds(30);
    const memorySize = props.memorySize ?? 256;

    const externalModules = NodejsLambda.buildExternals(props);
    const bundling = NodejsLambda.buildBundling(props, externalModules);

    const logGroup = NodejsLambda.resolveLogGroup(scope, id, props);

    super(scope, id, {
      functionName: props.functionName,
      entry: props.entry,
      handler: props.handler ?? "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      tracing: lambda.Tracing.ACTIVE,
      memorySize,
      timeout,
      bundling,
      ...(logGroup !== undefined ? { logGroup } : {}),
      ...(props.reservedConcurrentExecutions !== undefined
        ? { reservedConcurrentExecutions: props.reservedConcurrentExecutions }
        : {}),
      ...(props.environment !== undefined ? { environment: { ...props.environment } } : {}),
      ...(props.role !== undefined ? { role: props.role } : {}),
      ...(props.vpc !== undefined ? { vpc: props.vpc } : {}),
      ...(props.vpcSubnets !== undefined ? { vpcSubnets: props.vpcSubnets } : {}),
      ...(props.securityGroups !== undefined ? { securityGroups: props.securityGroups } : {}),
      ...(props.layers !== undefined ? { layers: [...props.layers] } : {}),
    });

    this.node.addMetadata(HOUSE_CONSTRUCT_METADATA_KEY, "NodejsLambda");

    const flags = resolveAlarmFlags(props.alarms);

    if (flags.errors) {
      this.errorAlarm = createErrorAlarm(this, this, {
        ...(props.alarmTopic !== undefined ? { alarmTopic: props.alarmTopic } : {}),
      });
    }
    if (flags.throttles) {
      this.throttleAlarm = createThrottleAlarm(this, this, {
        ...(props.alarmTopic !== undefined ? { alarmTopic: props.alarmTopic } : {}),
      });
    }
    if (flags.duration) {
      this.durationAlarm = createDurationAlarm(this, this, {
        timeout,
        ...(props.alarmTopic !== undefined ? { alarmTopic: props.alarmTopic } : {}),
      });
    }
  }

  /**
   * Add a CloudWatch alarm on the SQS event source's IteratorAge —
   * the canonical "queue consumer is falling behind" signal. Pair with
   * {@link QueueWithDlq}; the DLQ alarm tells you the consumer gave
   * up, this one tells you it is struggling.
   *
   * Default threshold: 5 minutes. Workload-dependent; override based
   * on the consumer's SLO.
   */
  public addQueueIteratorAgeAlarm(
    queue: sqs.IQueue,
    opts: IteratorAgeAlarmOptions = {},
  ): cloudwatch.Alarm {
    return addQueueIteratorAgeAlarm(this, queue, opts);
  }

  private static validate(props: NodejsLambdaProps): void {
    if (props.functionName.length === 0) {
      throw new NodejsLambdaPropsError("functionName must be a non-empty string");
    }
    if (
      props.reservedConcurrentExecutions !== undefined &&
      props.reservedConcurrentExecutions < 0
    ) {
      throw new NodejsLambdaPropsError(
        `reservedConcurrentExecutions must be >= 0 (got ${String(props.reservedConcurrentExecutions)})`,
      );
    }

    // X-Ray reachability gate: VPC + ACTIVE tracing (the construct
    // default) without an explicit acknowledgement means silent trace
    // drops. Fail loudly at synth.
    if (props.vpc !== undefined && props.acknowledgeXrayVpcReachability !== true) {
      throw new NodejsLambdaPropsError(
        `NodejsLambda "${props.functionName}" is configured with a VPC but X-Ray ACTIVE ` +
          `tracing (the construct default) has no documented reachability path. ` +
          `Without a com.amazonaws.<region>.xray VPC interface endpoint or NAT egress, ` +
          `X-Ray traces are silently dropped. Either configure the VPC interface ` +
          `endpoint (see https://docs.aws.amazon.com/xray/latest/devguide/xray-services-vpc.html) ` +
          `and set acknowledgeXrayVpcReachability: true, or set acknowledgeXrayVpcReachability: ` +
          `true if reachability is provided by another route (NAT, transit gateway, ` +
          `out-of-construct VPC endpoint).`,
      );
    }
  }

  private static buildExternals(props: NodejsLambdaProps): ReadonlyArray<string> {
    const seen = new Set<string>(["@aws-sdk/*"]);
    if (props.prismaBundling !== undefined) {
      seen.add("@prisma/client");
    }
    for (const m of props.externalModules ?? []) {
      seen.add(m);
    }
    return Array.from(seen);
  }

  private static buildBundling(
    props: NodejsLambdaProps,
    externalModules: ReadonlyArray<string>,
  ): NonNullable<NodejsFunctionProps["bundling"]> {
    if (props.prismaBundling === undefined) {
      return { externalModules: [...externalModules] };
    }
    const prismaOpts: PrismaBundlingOptions =
      props.prismaBundling === true ? {} : props.prismaBundling;
    return {
      externalModules: [...externalModules],
      commandHooks: buildPrismaCommandHooks(prismaOpts),
    };
  }

  private static resolveLogGroup(
    scope: Construct,
    id: string,
    props: NodejsLambdaProps,
  ): logs.ILogGroupRef | undefined {
    // If the consumer pre-created the log group, honour it as-is.
    if (props.logGroup !== undefined) {
      return props.logGroup;
    }
    // Otherwise create one with the house defaults: 30-day retention,
    // optional CMK encryption. The CDK auto-named pattern keeps the
    // group tied to the function lifecycle (DESTROY on stack delete).
    const logClass = props.logClass ?? "standard";
    const logGroup = new logs.LogGroup(scope, `${id}LogGroup`, {
      logGroupName: `/aws/lambda/${props.functionName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      logGroupClass:
        logClass === "infrequent-access"
          ? logs.LogGroupClass.INFREQUENT_ACCESS
          : logs.LogGroupClass.STANDARD,
      ...(props.logsEncryptionKey !== undefined ? { encryptionKey: props.logsEncryptionKey } : {}),
    });
    if (logClass === "infrequent-access") {
      Annotations.of(logGroup).addInfo(
        `NodejsLambda "${props.functionName}": logClass='infrequent-access' selected. ` +
          `IA storage is ~50% cheaper than Standard but Logs Insights queries cost ` +
          `more per scanned GB. Prefer IA for write-heavy/read-rare streams (audit, ` +
          `bounce-handler, security events); keep Standard for app code that is ` +
          `actively queried during incidents.`,
      );
    }
    return logGroup;
  }
}
