/**
 * Cognito `CreateAuthChallenge` trigger — magic-link issuance.
 *
 * Steps:
 *   1. Resolve recipient email from the Cognito event.
 *   2. Check the bounce/complaint denylist (Mitigation: bounce circuit
 *      breaker). On hit: build a challenge that the verifier will reject,
 *      but DO NOT differentiate the response from a normal challenge
 *      (no user enumeration).
 *   3. Consume one slot of the per-email rate limit. On limit hit: same
 *      "challenge that fails verification" trick.
 *   4. Generate a 32-byte random token, store `SHA-256(token)` in the
 *      token table with a TTL.
 *   5. Build the fragment-based magic-link URL and send via SES.
 *   6. Respond with private and public challenge parameters.
 *
 * Logging: regional CloudWatch only. Never logs the raw token. Emails are
 * HMAC-hashed (via the BOUNCE_HMAC_SECRET shared key) before logging.
 *
 * Any failure path that surfaces to the caller uses the generic
 * `Error("Authentication failed")` — never specifics. Server-side logs
 * carry the cause.
 */

import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { SESClient } from "@aws-sdk/client-ses";
import { createHash, createHmac, randomBytes } from "crypto";

import { RuntimeEnv } from "../../shared/runtime-env.js";
import { GENERIC_AUTH_ERROR } from "../verify-auth-challenge/errors.js";
import { sendMagicLinkEmail } from "./magic-link-email.js";
import { isDenylisted } from "./quarantine-check.js";
import { DEFAULT_SENDS_PER_WINDOW, tryConsumeRateLimit } from "./rate-limit.js";

/**
 * Minimal Cognito `CreateAuthChallenge` event shape.
 */
export interface CreateAuthChallengeEvent {
  readonly userPoolId: string;
  readonly userName: string;
  readonly request: {
    readonly userAttributes: Record<string, string>;
    readonly challengeName?: string;
    readonly session?: ReadonlyArray<unknown>;
  };
  response: {
    publicChallengeParameters?: Record<string, string>;
    privateChallengeParameters?: Record<string, string>;
    challengeMetadata?: string;
  };
}

/**
 * Injectable dependencies for the CreateAuthChallenge handler.
 */
export interface CreateAuthChallengeHandlerDeps {
  readonly dynamodb?: DynamoDBClient;
  readonly ses?: SESClient;
  readonly nowMs?: () => number;
  readonly randomToken?: () => Buffer;
}

/**
 * Name of the env var holding the HMAC secret used to hash emails before
 * they hit any log line or the `email_hmac` token-row attribute.
 * Uses `RuntimeEnv.BOUNCE_HMAC_SECRET` for the env-var name.
 */
const HMAC_SECRET_ENV = RuntimeEnv.BOUNCE_HMAC_SECRET;

function hmacEmailForLogs(email: string): string {
  const secret = process.env[HMAC_SECRET_ENV];
  if (secret === undefined || secret === "") {
    // No secret configured — log a fixed placeholder rather than the address.
    // This keeps the log line shape stable for grep-based PII tests without
    // ever emitting the raw email.
    return "email:hmac-disabled";
  }
  return `email:${createHmac("sha256", secret).update(email.toLowerCase()).digest("hex").slice(0, 16)}`;
}

/** sha256 of the token, hex-encoded. */
function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Build the same "looks-normal but fails verify" response shape. */
function failClosedChallenge(
  event: CreateAuthChallengeEvent,
  email: string,
  reason: string,
): CreateAuthChallengeEvent {
  event.response.publicChallengeParameters = {
    email,
  };
  event.response.privateChallengeParameters = {
    email,
    token_hash: "denied",
    quarantined: "true",
  };
  event.response.challengeMetadata = "MAGIC_LINK";
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      msg: "create_auth_challenge.fail_closed",
      reason,
      email: hmacEmailForLogs(email),
    }),
  );
  return event;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw GENERIC_AUTH_ERROR();
  }
  return value;
}

/**
 * Create a `CreateAuthChallenge` Cognito trigger handler.
 */
export function createCreateAuthChallengeHandler(deps: CreateAuthChallengeHandlerDeps = {}) {
  let defaultDynamodb: DynamoDBClient | undefined;
  let defaultSes: SESClient | undefined;

  function getDynamoClient(): DynamoDBClient {
    if (deps.dynamodb) return deps.dynamodb;
    defaultDynamodb ??= new DynamoDBClient({});
    return defaultDynamodb;
  }

  function getSesClient(): SESClient {
    if (deps.ses) return deps.ses;
    const sesRegion = process.env[RuntimeEnv.SES_REGION] ?? process.env.AWS_REGION;
    defaultSes ??= new SESClient(sesRegion !== undefined ? { region: sesRegion } : {});
    return defaultSes;
  }

  return async function handler(
    event: CreateAuthChallengeEvent,
  ): Promise<CreateAuthChallengeEvent> {
    const email = event.request.userAttributes.email;
    if (email === undefined || email === "") {
      throw GENERIC_AUTH_ERROR();
    }

    const tokenTable = requiredEnv(RuntimeEnv.TOKEN_TABLE_NAME);
    const rateLimitTable = requiredEnv(RuntimeEnv.RATE_LIMIT_TABLE_NAME);
    const denylistTable = process.env[RuntimeEnv.DENYLIST_TABLE_NAME];
    const fromAddress = requiredEnv(RuntimeEnv.SES_FROM);
    const domain = requiredEnv(RuntimeEnv.DOMAIN);

    const ttlMinutes = Number.parseInt(process.env[RuntimeEnv.TOKEN_TTL_MINUTES] ?? "15", 10);
    const sendsPerWindow = Number.parseInt(
      process.env[RuntimeEnv.TOKEN_SENDS_PER_WINDOW] ?? String(DEFAULT_SENDS_PER_WINDOW),
      10,
    );

    const dynamodb = getDynamoClient();
    const ses = getSesClient();
    const now = deps.nowMs?.() ?? Date.now();

    // -- 1. Denylist (bounce circuit breaker) ----------------------------------
    if (await isDenylisted(dynamodb, denylistTable, email)) {
      return failClosedChallenge(event, email, "denylisted");
    }

    // -- 2. Rate limit ---------------------------------------------------------
    const allowed = await tryConsumeRateLimit({
      client: dynamodb,
      tableName: rateLimitTable,
      email,
      limit: sendsPerWindow,
      nowMs: now,
    });
    if (!allowed) {
      return failClosedChallenge(event, email, "rate_limited");
    }

    // -- 3. Generate token + store hash ----------------------------------------
    const tokenBuf = deps.randomToken?.() ?? randomBytes(32);
    const token = tokenBuf.toString("base64url");
    const hash = tokenHash(token);

    const ttlEpochSeconds = Math.floor(now / 1000) + ttlMinutes * 60;
    const emailHmacSecret = process.env[HMAC_SECRET_ENV] ?? "";
    const emailHmac = emailHmacSecret
      ? createHmac("sha256", emailHmacSecret).update(email.toLowerCase()).digest("hex")
      : "";

    await dynamodb.send(
      new PutItemCommand({
        TableName: tokenTable,
        Item: {
          token_hash: { S: hash },
          email_hmac: { S: emailHmac },
          created_at: { N: String(Math.floor(now / 1000)) },
          ttl: { N: String(ttlEpochSeconds) },
        },
        // Cheap defence against PK collision — 32 random bytes makes this
        // effectively impossible, but the cost of asserting it is zero.
        ConditionExpression: "attribute_not_exists(token_hash)",
      }),
    );

    // -- 4. Send the magic-link email ------------------------------------------
    await sendMagicLinkEmail({
      sesClient: ses,
      fromAddress,
      toAddress: email,
      domain,
      token,
      ttlMinutes,
    });

    // -- 5. Build response ------------------------------------------------------
    event.response.publicChallengeParameters = { email };
    event.response.privateChallengeParameters = {
      email,
      token_hash: hash,
      quarantined: "false",
    };
    event.response.challengeMetadata = "MAGIC_LINK";

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        msg: "create_auth_challenge.sent",
        email: hmacEmailForLogs(email),
      }),
    );

    return event;
  };
}
