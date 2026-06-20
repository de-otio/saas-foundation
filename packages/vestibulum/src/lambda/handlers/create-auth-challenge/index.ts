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
import { createHash, randomBytes } from "crypto";

import { hmacEmail, resolveEmailHmacKeyFromEnv } from "../../shared/email-hmac.js";
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
  /**
   * Resolve the email-HMAC key. Defaults to reading the secret id from
   * `VESTIBULUM_BOUNCE_HMAC_SECRET` and fetching the value from Secrets Manager
   * (cached per warm container). Injected in tests to avoid a real fetch.
   */
  readonly resolveHmacKey?: () => Promise<string>;
}

function hmacEmailForLogs(email: string, hmacKey: string): string {
  if (hmacKey === "") {
    // No secret configured — log a fixed placeholder rather than the address.
    // This keeps the log line shape stable for grep-based PII tests without
    // ever emitting the raw email.
    return "email:hmac-disabled";
  }
  return `email:${hmacEmail(email, hmacKey).slice(0, 16)}`;
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
  hmacKey: string,
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
      email: hmacEmailForLogs(email, hmacKey),
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
      // Enumeration hardening. When the app client has
      // PreventUserExistenceErrors enabled, Cognito invokes this trigger with a
      // phantom user (no `email` attribute) for an address that does NOT exist.
      // Throwing here surfaces a 400 (UserLambdaValidationException) for unknown
      // addresses while real ones get 200 — a user-existence oracle on the
      // public InitiateAuth endpoint. Instead return a normal-looking challenge
      // that the verifier rejects, exactly as the denylist / rate-limit paths
      // do. Real users always carry the email attribute (SignUp ran first), so
      // this only ever fires for unknown addresses — and crucially no mail is
      // sent (we return before the SES call).
      return failClosedChallenge(event, event.userName, "unknown_user", "");
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

    // Resolve the shared email-HMAC key once (cached per warm container). Used
    // for the denylist key, the token-row `email_hmac`, and log redaction —
    // they MUST all agree on this key, so resolve it here and thread it down.
    const hmacKey = await (deps.resolveHmacKey ?? resolveEmailHmacKeyFromEnv)();

    // -- 1. Denylist (bounce circuit breaker) ----------------------------------
    if (await isDenylisted(dynamodb, denylistTable, email, hmacKey)) {
      return failClosedChallenge(event, email, "denylisted", hmacKey);
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
      return failClosedChallenge(event, email, "rate_limited", hmacKey);
    }

    // -- 3. Generate token + store hash ----------------------------------------
    const tokenBuf = deps.randomToken?.() ?? randomBytes(32);
    const token = tokenBuf.toString("base64url");
    const hash = tokenHash(token);

    const ttlEpochSeconds = Math.floor(now / 1000) + ttlMinutes * 60;
    const emailHmac = hmacKey ? hmacEmail(email, hmacKey) : "";

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
        email: hmacEmailForLogs(email, hmacKey),
      }),
    );

    return event;
  };
}
