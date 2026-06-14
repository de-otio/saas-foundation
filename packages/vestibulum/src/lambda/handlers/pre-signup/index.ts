/**
 * PreSignUp Cognito trigger — domain allowlist + rate-limit guard.
 *
 * Security design:
 * - Domain allowlist check: rejects any email whose domain is not in
 *   `VESTIBULUM_ALLOWED_EMAIL_DOMAINS`. Always throws the same generic
 *   `Error("Signup not allowed")` regardless of the rejection reason so
 *   callers cannot enumerate which domains are allowed.
 * - Rate-limit check: prevents mailbomb and user enumeration attacks by
 *   limiting signups per email to `VESTIBULUM_SIGN_UPS_PER_WINDOW` in a
 *   15-minute sliding window. Enforced via a conditional `UpdateItem` that
 *   is race-safe under concurrent signup attempts.
 * - Logging: logs the *domain only* (never the full email) for forensic
 *   CloudWatch queries. This satisfies the "no PII in logs" gate.
 * - Metrics: emits a `PreSignUpRejections` custom metric in the
 *   `Vestibulum/Identity` namespace on every rejection.
 */

import {
  DynamoDBClient,
  UpdateItemCommand,
  ConditionalCheckFailedException,
} from "@aws-sdk/client-dynamodb";
import { RuntimeEnv } from "../../shared/runtime-env.js";

/**
 * Cognito PreSignUp trigger sources. The trigger fires for self-signup
 * (`PreSignUp_SignUp`), admin-created users (`PreSignUp_AdminCreateUser`),
 * and the first sign-in of a federated user (`PreSignUp_ExternalProvider`).
 * Invite-only mode rejects only the first; the other two pass through.
 */
type PreSignUpTriggerSource =
  | "PreSignUp_SignUp"
  | "PreSignUp_AdminCreateUser"
  | "PreSignUp_ExternalProvider"
  // Open string union — Cognito may add new trigger sources without notice.
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {});

/** Cognito PreSignUp trigger event (minimal shape we need). */
export interface PreSignUpEvent {
  readonly triggerSource: PreSignUpTriggerSource;
  readonly request: {
    readonly userAttributes: {
      readonly email: string;
    };
    /** Source IP forwarded by CloudFront. May be undefined in local test. */
    readonly clientMetadata?: Record<string, string>;
  };
  readonly response: Record<string, unknown>;
}

/** Rate-limit window duration in milliseconds (15 minutes). */
const WINDOW_MS = 15 * 60 * 1000;

/** Namespace for Vestibulum custom CloudWatch metrics (EMF). */
const CW_NAMESPACE = "Vestibulum/Identity";

/**
 * Injectable dependencies for the PreSignUp handler.
 * Production callers pass `undefined` to use module-level defaults.
 */
export interface PreSignUpHandlerDeps {
  readonly dynamodb?: DynamoDBClient;
}

/**
 * Emit a CloudWatch metric via the Lambda Embedded Metric Format (EMF).
 * No extra SDK dependency — Lambda's log agent ingests the structured JSON
 * and converts it to a CloudWatch metric automatically.
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
  // EMF requires a single-line JSON followed by a newline.
  process.stdout.write(JSON.stringify(emfPayload) + "\n");
}

/**
 * Rate-limit a signup attempt using a conditional DynamoDB UpdateItem.
 *
 * The table is keyed on `<email>#<window_start_epoch_ms>`. The condition
 * enforces an atomic counter that fails if the count already equals or
 * exceeds the limit, making the operation race-safe.
 *
 * @returns `true` if under limit (signup allowed), `false` if limit hit.
 */
async function checkAndIncrementRateLimit(
  dynamoClient: DynamoDBClient,
  tableName: string,
  email: string,
  limit: number,
): Promise<boolean> {
  const windowStart = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  const pk = `${email}#${windowStart}`;
  const ttlSecs = Math.floor((windowStart + WINDOW_MS * 2) / 1000);

  try {
    await dynamoClient.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { pk: { S: pk } },
        UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :one, #ttl = :ttl",
        ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
        ExpressionAttributeNames: {
          "#count": "count",
          "#ttl": "ttl",
        },
        ExpressionAttributeValues: {
          ":zero": { N: "0" },
          ":one": { N: "1" },
          ":limit": { N: String(limit) },
          ":ttl": { N: String(ttlSecs) },
        },
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return false;
    }
    throw err;
  }
}

/**
 * Create a PreSignUp Cognito trigger handler.
 *
 * Validates the email domain against the allowlist and enforces per-email
 * signup rate limiting. On any rejection, throws `Error("Signup not allowed")`
 * — the same string regardless of the rejection reason (enumeration hardening).
 */
export function createPreSignupHandler(deps: PreSignUpHandlerDeps = {}) {
  let defaultDynamodb: DynamoDBClient | undefined;

  function getDynamoClient(): DynamoDBClient {
    if (deps.dynamodb) return deps.dynamodb;
    defaultDynamodb ??= new DynamoDBClient({});
    return defaultDynamodb;
  }

  return async function handler(event: PreSignUpEvent): Promise<PreSignUpEvent> {
    const email = event.request.userAttributes.email ?? "";
    const atIndex = email.lastIndexOf("@");
    const domain = atIndex >= 0 ? email.slice(atIndex + 1).toLowerCase() : "";

    // --- Invite-only mode (signupMode: 'admin-invite-only') ---
    // When the site's signupMode is admin-invite-only, reject any
    // PreSignUp_SignUp event (the self-registration trigger).
    // AdminCreateUser and ExternalProvider triggers continue past
    // this guard to the domain/rate-limit checks below; federation
    // and admin invites remain functional.
    const signupMode = process.env[RuntimeEnv.SIGNUP_MODE];
    if (signupMode === "admin-invite-only" && event.triggerSource === "PreSignUp_SignUp") {
      console.info(`PreSignUp: self-signup rejected (invite-only mode), domain: ${domain}`);
      emitMetric("PreSignUpRejections", 1, { Reason: "InviteOnlyMode" });
      throw new Error("Signup not allowed");
    }

    // --- Domain allowlist check ---
    const rawDomains = process.env[RuntimeEnv.ALLOWED_EMAIL_DOMAINS] ?? "[]";
    let allowedDomains: string[];
    try {
      allowedDomains = JSON.parse(rawDomains) as string[];
    } catch {
      allowedDomains = [];
    }

    if (!allowedDomains.map((d) => d.toLowerCase()).includes(domain)) {
      // Log domain only — never the full email (no PII in logs).
      console.info(`PreSignUp: domain rejected: ${domain}`);
      emitMetric("PreSignUpRejections", 1, { Reason: "DomainNotAllowed" });
      throw new Error("Signup not allowed");
    }

    // --- Rate-limit check ---
    const rateLimitTableName = process.env[RuntimeEnv.RATE_LIMIT_TABLE_NAME];
    if (rateLimitTableName !== undefined && rateLimitTableName !== "") {
      const rawLimit = process.env[RuntimeEnv.SIGN_UPS_PER_WINDOW] ?? "3";
      const limit = parseInt(rawLimit, 10);
      const allowed = await checkAndIncrementRateLimit(
        getDynamoClient(),
        rateLimitTableName,
        email,
        isNaN(limit) ? 3 : limit,
      );
      if (!allowed) {
        // Log domain only — not email.
        console.info(`PreSignUp: rate limit hit for domain: ${domain}`);
        emitMetric("PreSignUpRejections", 1, { Reason: "RateLimitHit" });
        throw new Error("Signup not allowed");
      }
    }

    return event;
  };
}
