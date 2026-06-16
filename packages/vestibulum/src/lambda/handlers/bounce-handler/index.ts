/**
 * Bounce-handler Lambda — SES bounce/complaint circuit breaker.
 *
 * Subscribed to the SES bounce/complaint SNS topic. On receiving a hard
 * bounce or complaint notification:
 *
 *  1. Parses the SNS envelope to extract the SES `mail` + `bounce` or
 *     `complaint` structure.
 *  2. For each affected recipient:
 *     a. Attempts to set `custom:email_quarantined=true` via
 *        `AdminUpdateUserAttributes` on the Cognito User Pool.
 *     b. If the user is not found in Cognito, writes the email's HMAC-SHA-256
 *        hash to the standalone DenylistTable in DynamoDB.
 *  3. Emits `SesBounceRate` / `SesComplaintRate` CloudWatch metrics via EMF.
 *
 * Logging discipline:
 *   - Raw email addresses are NEVER written to logs.
 *   - All email-related log statements use the HMAC-SHA-256 hash keyed with
 *     `VESTIBULUM_BOUNCE_HMAC_SECRET`. This satisfies the "no PII in logs"
 *     CI gate.
 */

import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
  UserNotFoundException,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { hmacEmail, resolveEmailHmacKeyFromEnv } from "../../shared/email-hmac.js";
import { RuntimeEnv } from "../../shared/runtime-env.js";

// Re-exported for backward compatibility; the canonical implementation (which
// lowercases the address — the bounce-handler historically did not, so its
// denylist writes never matched the lowercasing quarantine-check reads) now
// lives in the shared module so write and read cannot drift.
export { hmacEmail };

/** SES notification type discriminant. */
type SesNotificationType = "Bounce" | "Complaint" | "Delivery";

/** Minimal SES bounce recipient shape. */
interface SesBounceRecipient {
  readonly emailAddress: string;
}

/** Minimal SES complaint recipient shape. */
interface SesComplainedRecipient {
  readonly emailAddress: string;
}

/** Minimal SES bounce structure. */
interface SesBounce {
  readonly bounceType: "Permanent" | "Transient" | "Undetermined";
  readonly bouncedRecipients: readonly SesBounceRecipient[];
}

/** Minimal SES complaint structure. */
interface SesComplaint {
  readonly complainedRecipients: readonly SesComplainedRecipient[];
}

/** Minimal SES mail structure (present in both bounce and complaint). */
interface SesMail {
  readonly destination: readonly string[];
}

/** Top-level SES notification envelope (wrapped inside the SNS Message). */
interface SesNotification {
  readonly notificationType: SesNotificationType;
  readonly mail: SesMail;
  readonly bounce?: SesBounce;
  readonly complaint?: SesComplaint;
}

/** SNS record as delivered by Lambda. */
interface SnsRecord {
  readonly EventSource: string;
  readonly Sns: {
    readonly Message: string;
  };
}

/** Lambda event for an SNS trigger. */
export interface SnsEvent {
  readonly Records: readonly SnsRecord[];
}

/** Namespace for Vestibulum custom CloudWatch metrics (EMF). */
const CW_NAMESPACE = "Vestibulum/Identity";

/**
 * Injectable dependencies for the bounce-handler.
 */
export interface BounceHandlerDeps {
  readonly cognitoClient?: CognitoIdentityProviderClient;
  readonly dynamoClient?: DynamoDBClient;
  /**
   * Resolve the email-HMAC key used for the denylist write and log redaction.
   * Defaults to fetching from Secrets Manager via the id in
   * `VESTIBULUM_BOUNCE_HMAC_SECRET` (cached per warm container). MUST resolve to
   * the same value quarantine-check uses, or denylisted addresses are never
   * matched. Injected in tests.
   */
  readonly resolveHmacKey?: () => Promise<string>;
}

/**
 * Emit a CloudWatch metric via the Lambda Embedded Metric Format (EMF).
 */
function emitMetric(metricName: string, value = 1, dimensions: Record<string, string> = {}): void {
  const emfPayload = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: CW_NAMESPACE,
          Dimensions: [Object.keys(dimensions)],
          Metrics: [{ Name: metricName, Unit: "Count" }],
        },
      ],
    },
    ...dimensions,
    [metricName]: value,
  };
  process.stdout.write(JSON.stringify(emfPayload) + "\n");
}

/**
 * Create a bounce-handler Lambda handler for SES bounce/complaint SNS events.
 *
 * Processes each SNS record independently; a single record failure does not
 * short-circuit processing of remaining records (partial success). Errors on
 * individual records are re-thrown after all records are processed, causing
 * Lambda to retry the batch.
 */
export function createBounceHandler(deps: BounceHandlerDeps = {}) {
  let defaultCognitoClient: CognitoIdentityProviderClient | undefined;
  let defaultDynamoClient: DynamoDBClient | undefined;

  function getCognitoClient(): CognitoIdentityProviderClient {
    if (deps.cognitoClient) return deps.cognitoClient;
    defaultCognitoClient ??= new CognitoIdentityProviderClient({});
    return defaultCognitoClient;
  }

  function getDynamoClient(): DynamoDBClient {
    if (deps.dynamoClient) return deps.dynamoClient;
    defaultDynamoClient ??= new DynamoDBClient({});
    return defaultDynamoClient;
  }

  async function quarantineEmail(
    email: string,
    emailHash: string,
    userPoolId: string,
    denylistTableName: string,
  ): Promise<void> {
    try {
      await getCognitoClient().send(
        new AdminUpdateUserAttributesCommand({
          UserPoolId: userPoolId,
          Username: email,
          UserAttributes: [{ Name: "custom:email_quarantined", Value: "true" }],
        }),
      );
      console.info(`bounce-handler: quarantined Cognito user (hash=${emailHash})`);
    } catch (err) {
      if (err instanceof UserNotFoundException) {
        // User not in Cognito — write HMAC hash to the denylist table.
        const ttlSecs = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
        await getDynamoClient().send(
          new PutItemCommand({
            TableName: denylistTableName,
            Item: {
              // PK attribute is `email_hmac` — must match the DenylistTable
              // schema (and the read key in quarantine-check).
              email_hmac: { S: emailHash },
              quarantined_at: { S: new Date().toISOString() },
              ttl: { N: String(ttlSecs) },
            },
          }),
        );
        console.info(
          `bounce-handler: wrote denylist entry for non-Cognito address (hash=${emailHash})`,
        );
      } else {
        throw err;
      }
    }
  }

  async function processBounce(
    notification: SesNotification,
    userPoolId: string,
    denylistTableName: string,
    hmacSecret: string,
  ): Promise<void> {
    const bounce = notification.bounce;
    if (!bounce) return;

    emitMetric("SesBounceRate", bounce.bouncedRecipients.length, {
      BounceType: bounce.bounceType,
    });

    if (bounce.bounceType !== "Permanent") {
      console.info(
        `bounce-handler: non-permanent bounce type=${bounce.bounceType}, skipping quarantine`,
      );
      return;
    }

    for (const recipient of bounce.bouncedRecipients) {
      const email = recipient.emailAddress;
      const emailHash = hmacEmail(email, hmacSecret);
      await quarantineEmail(email, emailHash, userPoolId, denylistTableName);
    }
  }

  async function processComplaint(
    notification: SesNotification,
    userPoolId: string,
    denylistTableName: string,
    hmacSecret: string,
  ): Promise<void> {
    const complaint = notification.complaint;
    if (!complaint) return;

    emitMetric("SesComplaintRate", complaint.complainedRecipients.length);

    for (const recipient of complaint.complainedRecipients) {
      const email = recipient.emailAddress;
      const emailHash = hmacEmail(email, hmacSecret);
      await quarantineEmail(email, emailHash, userPoolId, denylistTableName);
    }
  }

  return async function handler(event: SnsEvent): Promise<void> {
    const userPoolId = process.env[RuntimeEnv.COGNITO_USER_POOL_ID];
    const denylistTableName = process.env[RuntimeEnv.DENYLIST_TABLE_NAME];
    // Resolve the actual secret value (the env var holds the Secrets Manager id,
    // not the value). Empty means the secret id env var is unset.
    const hmacSecret = await (deps.resolveHmacKey ?? resolveEmailHmacKeyFromEnv)();

    if (
      userPoolId === undefined ||
      userPoolId === "" ||
      denylistTableName === undefined ||
      denylistTableName === "" ||
      hmacSecret === ""
    ) {
      throw new Error(
        "bounce-handler: missing required env vars " +
          "(VESTIBULUM_USER_POOL_ID, VESTIBULUM_DENYLIST_TABLE, VESTIBULUM_BOUNCE_HMAC_SECRET)",
      );
    }

    const errors: unknown[] = [];

    for (const record of event.Records) {
      try {
        const notification = JSON.parse(record.Sns.Message) as SesNotification;

        if (notification.notificationType === "Bounce") {
          await processBounce(notification, userPoolId, denylistTableName, hmacSecret);
        } else if (notification.notificationType === "Complaint") {
          await processComplaint(notification, userPoolId, denylistTableName, hmacSecret);
        } else {
          console.info(
            `bounce-handler: ignoring notification type=${notification.notificationType}`,
          );
        }
      } catch (err) {
        console.error(`bounce-handler: error processing record: ${String(err)}`);
        errors.push(err);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, "bounce-handler: one or more records failed");
    }
  };
}
