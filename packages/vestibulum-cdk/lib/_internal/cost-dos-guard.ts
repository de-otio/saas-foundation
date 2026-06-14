/**
 * Cost-DoS guard for the SES outbound side (cost-pillar review S7).
 *
 * Purpose: the WAF rate-limit + reserved-concurrency caps on
 * `auth-verify` defend the *inbound* request path. They do not defend
 * the *outbound* side — a `/auth-verify` call that clears the
 * rate-limit triggers a magic-link send via SES. An attacker rotating
 * through residential proxies with unique addresses costs them little
 * and costs the operator at:
 *
 *   - SES sends: ~$0.10 per 1,000 outbound (above the EU free tier).
 *   - Reputation damage if bounce rate climbs (Cognito feature plan /
 *     sandbox revocation).
 *   - Customer-support volume.
 *
 * This module bolts on two opt-in layers, gated by the
 * {@link CostDosGuardProps} prop on `MagicLinkIdentity` and
 * `SharedDistributionIdentity`:
 *
 *   1. A CloudWatch alarm on the `AWS/SES` `Send` metric scoped to the
 *      pool's SES domain identity, with threshold `sendsPerHourCap`.
 *      Wires to an SNS topic (consumer-supplied or auto-created).
 *
 *   2. (Optional) A self-defence Lambda subscribed to the alarm's SNS
 *      topic that calls Cognito `UpdateUserPool` to flip
 *      `AdminCreateUserConfig.AllowAdminCreateUserOnly: true` — this
 *      disables self-sign-up pool-wide so the PreSignUp trigger never
 *      runs and no further magic-link sends are emitted. Reversible
 *      via the AWS console / API.
 *
 * **Self-defence design choice — admin Cognito action (not feature flag):**
 * the alternative was a feature-flag env var on the existing PreSignUp
 * trigger. Mutating a deployed Lambda's environment in response to a
 * runtime signal creates IaC drift (the next `cdk deploy` resets it)
 * and is intrusive. Disabling self-sign-up via `UpdateUserPool` is the
 * canonical Cognito admin action for exactly this scenario, leaves a
 * single auditable CloudTrail event, and is undone with one further
 * admin call when the attack subsides.
 *
 * See {@link https://github.com/de-otio/saas-foundation/blob/main/doc/vestibulum-cdk/04-magic-link-auth-site.md#ses-cost-dos-guard-cost-pillar-s7}.
 */

import { Duration } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Optional cost-DoS guard configuration brought inside the documented
 * envelope on `MagicLinkIdentity` and `SharedDistributionIdentity`.
 *
 * Default (prop unset / `enabled: false`): no alarm, no handler — current
 * behaviour preserved.
 */
export interface CostDosGuardProps {
  /**
   * Activate the cost-DoS guard. When `false` (or the prop is omitted),
   * neither the alarm nor the self-defence handler is provisioned.
   */
  readonly enabled: boolean;

  /**
   * Threshold for the per-pool SES `Send` alarm, in sends per hour.
   *
   * Worked example: for an auth flow seeing N legitimate sends/hour at
   * peak, set `sendsPerHourCap` to 5-10× N. Tune well above any
   * plausible legitimate spike, well below any cost-disaster level.
   * Required when `enabled: true`.
   */
  readonly sendsPerHourCap: number;

  /**
   * When `true`, deploy the self-defence handler that disables Cognito
   * self-sign-up on alarm. Operators re-enable via the AWS console /
   * `UpdateUserPool`. Default `false` — alarm-only.
   */
  readonly selfDefence?: boolean;

  /**
   * SNS topic to receive the alarm. When omitted, an internal topic is
   * created and exposed as `costDosGuard.alarmTopic` on the construct.
   * Reuse an existing operator alarm topic where one exists.
   */
  readonly alarmTopic?: sns.ITopic;
}

/**
 * Resources created by {@link installCostDosGuard}. Surfaces to allow
 * the caller to expose them on the public construct API.
 */
export interface CostDosGuardResources {
  /** The CloudWatch alarm watching SES `Send` per hour. */
  readonly alarm: cloudwatch.Alarm;

  /** The SNS topic the alarm publishes to (created or consumer-supplied). */
  readonly alarmTopic: sns.ITopic;

  /**
   * The self-defence handler — present only when `selfDefence: true`.
   */
  readonly selfDefenceHandler?: lambda.Function;
}

// ---------------------------------------------------------------------------
// Inline handler source
// ---------------------------------------------------------------------------

/**
 * Self-defence handler. Subscribed to the alarm's SNS topic; on every
 * `ALARM`-state notification, calls Cognito `UpdateUserPool` to flip
 * `AdminCreateUserConfig.AllowAdminCreateUserOnly: true` on the pool
 * identified by the `VESTIBULUM_USER_POOL_ID` env var.
 *
 * Idempotent — subsequent invocations while sign-up is already disabled
 * are no-ops (the API accepts the redundant update).
 *
 * Kept inline (rather than in the bundle pipeline) because:
 *   - The dependency surface is tiny (AWS SDK only, already on the
 *     Lambda runtime).
 *   - The code is short enough to read in-place at synth time.
 *   - Avoiding the bundle pipeline keeps `costDosGuard` opt-in without
 *     forcing a rebuild of the package's lock manifest.
 */
const SELF_DEFENCE_HANDLER_SOURCE = `
const {
  CognitoIdentityProviderClient,
  DescribeUserPoolCommand,
  UpdateUserPoolCommand,
} = require("@aws-sdk/client-cognito-identity-provider");

const client = new CognitoIdentityProviderClient({});
const POOL_ID = process.env.VESTIBULUM_USER_POOL_ID;

exports.handler = async (event) => {
  if (!POOL_ID) {
    throw new Error("VESTIBULUM_USER_POOL_ID env var not set");
  }
  // SNS event payload — one Records[].Sns.Message per topic delivery.
  // We only care that *some* alarm fired; we don't gate on the state
  // string because OK transitions go through a separate action.
  const records = Array.isArray(event && event.Records) ? event.Records : [];
  if (records.length === 0) {
    return { disabled: false, reason: "no SNS records" };
  }

  // DescribeUserPool returns the full pool spec; UpdateUserPool then
  // requires the entire spec back (it is a replacement update). Carry
  // the current settings through and only flip the one field.
  const described = await client.send(
    new DescribeUserPoolCommand({ UserPoolId: POOL_ID }),
  );
  const pool = described.UserPool || {};
  const currentAdminConfig = pool.AdminCreateUserConfig || {};

  if (currentAdminConfig.AllowAdminCreateUserOnly === true) {
    return { disabled: true, reason: "already disabled" };
  }

  await client.send(
    new UpdateUserPoolCommand({
      UserPoolId: POOL_ID,
      AdminCreateUserConfig: {
        ...currentAdminConfig,
        AllowAdminCreateUserOnly: true,
      },
      // Carry over fields that the API requires on update. Omitting any
      // of these resets them to defaults — explicitly preserve.
      ...(pool.Policies ? { Policies: pool.Policies } : {}),
      ...(pool.AutoVerifiedAttributes
        ? { AutoVerifiedAttributes: pool.AutoVerifiedAttributes }
        : {}),
      ...(pool.UserAttributeUpdateSettings
        ? { UserAttributeUpdateSettings: pool.UserAttributeUpdateSettings }
        : {}),
      ...(pool.MfaConfiguration
        ? { MfaConfiguration: pool.MfaConfiguration }
        : {}),
      ...(pool.DeviceConfiguration
        ? { DeviceConfiguration: pool.DeviceConfiguration }
        : {}),
      ...(pool.EmailConfiguration
        ? { EmailConfiguration: pool.EmailConfiguration }
        : {}),
      ...(pool.SmsConfiguration
        ? { SmsConfiguration: pool.SmsConfiguration }
        : {}),
      ...(pool.UserPoolTags ? { UserPoolTags: pool.UserPoolTags } : {}),
      ...(pool.AccountRecoverySetting
        ? { AccountRecoverySetting: pool.AccountRecoverySetting }
        : {}),
    }),
  );

  return { disabled: true, reason: "alarm fired", recordCount: records.length };
};
`;

// ---------------------------------------------------------------------------
// Installer
// ---------------------------------------------------------------------------

/**
 * Inputs for {@link installCostDosGuard}. The caller (`MagicLinkIdentity`
 * or `SharedDistributionIdentity`) supplies its own SES identity name,
 * Cognito pool ARN, and pool ID.
 */
export interface InstallCostDosGuardInput {
  /**
   * SES domain identity name (e.g. `example.com`) used as the
   * `EmailIdentity` dimension on the `AWS/SES` `Send` metric.
   *
   * This is the *domain* of the sender, not the full email address.
   */
  readonly sesIdentityName: string;

  /** Cognito User Pool ARN — used to scope the IAM grant on `UpdateUserPool`. */
  readonly cognitoPoolArn: string;

  /** Cognito User Pool ID — injected into the handler's env. */
  readonly cognitoPoolId: string;

  /** Guard configuration from props. */
  readonly guard: CostDosGuardProps;
}

/**
 * Provision the cost-DoS guard layers on the supplied construct scope.
 *
 * Always creates the alarm + topic when `guard.enabled === true`. The
 * self-defence handler is created when `guard.selfDefence === true`.
 *
 * Throws when `guard.enabled === true` but `sendsPerHourCap` is not a
 * positive finite number — better caught at synth than at the first
 * legitimate spike.
 */
export function installCostDosGuard(
  scope: Construct,
  input: InstallCostDosGuardInput,
): CostDosGuardResources {
  const { guard, sesIdentityName, cognitoPoolArn, cognitoPoolId } = input;

  if (!guard.enabled) {
    throw new Error(
      `[vestibulum-cdk:CostDosGuard] installCostDosGuard called with ` +
        `enabled: false — the caller should only invoke when ` +
        `props.costDosGuard?.enabled is true.`,
    );
  }
  if (
    !Number.isFinite(guard.sendsPerHourCap) ||
    guard.sendsPerHourCap <= 0
  ) {
    throw new Error(
      `[vestibulum-cdk:CostDosGuard] 'sendsPerHourCap' must be a positive ` +
        `finite number when costDosGuard.enabled is true; got ` +
        `${String(guard.sendsPerHourCap)}.`,
    );
  }

  // SNS topic — reuse consumer-supplied or auto-create a dedicated one.
  const alarmTopic =
    guard.alarmTopic ??
    new sns.Topic(scope, "CostDosAlarmTopic", {
      displayName: "Vestibulum SES cost-DoS guard alarm topic",
    });

  // CloudWatch alarm on the AWS/SES `Send` metric, dimensioned by the
  // pool's SES domain identity. Threshold = sendsPerHourCap; period =
  // 1 hour; one evaluation period (immediate trigger when crossed).
  const alarm = new cloudwatch.Alarm(scope, "CostDosSendRateAlarm", {
    alarmDescription:
      `Vestibulum cost-DoS guard: SES Send count for identity ` +
      `'${sesIdentityName}' exceeded ${guard.sendsPerHourCap} per hour. ` +
      `This is the outbound-side complement to the WAF rate-limit and ` +
      `reserved-concurrency caps. Review traffic and consider tightening ` +
      `WAF rules or temporarily disabling self-sign-up.`,
    metric: new cloudwatch.Metric({
      namespace: "AWS/SES",
      metricName: "Send",
      dimensionsMap: {
        EmailIdentity: sesIdentityName,
      },
      period: Duration.hours(1),
      statistic: "Sum",
    }),
    threshold: guard.sendsPerHourCap,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    evaluationPeriods: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  alarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));

  // Self-defence handler — opt-in.
  let selfDefenceHandler: lambda.Function | undefined;
  if (guard.selfDefence === true) {
    selfDefenceHandler = new lambda.Function(scope, "CostDosSelfDefenceFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(30),
      handler: "index.handler",
      code: lambda.Code.fromInline(SELF_DEFENCE_HANDLER_SOURCE),
      reservedConcurrentExecutions: 1,
      logRetention: logs.RetentionDays.ONE_MONTH,
      description:
        "Vestibulum cost-DoS guard: on SES Send alarm, disables Cognito " +
        "self-sign-up via UpdateUserPool. Reversible via console / API.",
      environment: {
        VESTIBULUM_USER_POOL_ID: cognitoPoolId,
      },
    });

    selfDefenceHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cognito-idp:DescribeUserPool",
          "cognito-idp:UpdateUserPool",
        ],
        resources: [cognitoPoolArn],
      }),
    );

    alarmTopic.addSubscription(
      new snsSubscriptions.LambdaSubscription(selfDefenceHandler),
    );
  }

  return {
    alarm,
    alarmTopic,
    ...(selfDefenceHandler ? { selfDefenceHandler } : {}),
  };
}
