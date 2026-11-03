/**
 * Cognito `CreateAuthChallenge` trigger — magic-link issuance.
 *
 * Steps:
 *   1. Resolve recipient email from the Cognito event. An unknown address
 *      reaches this trigger as a phantom user with no `email` attribute.
 *   2. For EVERY caller, phantom included, do the same reads and writes: the
 *      denylist lookup and the per-address rate-limit counter. Only then decide
 *      (`signin_request_indistinguishable`: no early return that is faster than
 *      the real path).
 *   3. Silent path — phantom, quarantined (`custom:email_quarantined`),
 *      denylisted or rate-limited: build a challenge the verifier will reject,
 *      indistinguishable from a normal one, and send nothing.
 *   4. Otherwise generate a 32-byte random token, store `SHA-256(token)` in the
 *      token table with `expires_at` (the attribute the table's TTL names).
 *   5. Build the fragment-based magic-link URL and send via SES.
 *   6. Respond with private and public challenge parameters.
 *
 * Every path — including a thrown error — takes at least `CREATE_FLOOR_MS`, so
 * a caller that hits Cognito directly cannot tell the paths apart by latency.
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
import {
  DEFAULT_CREATE_FLOOR_MS,
  TTL_ATTRIBUTE,
  parseMs,
  parseTokenTtlMinutes,
  realSleep,
  withFloor,
} from "../../shared/signin.js";
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
  /** Sleep used to hold the response floor. Injected in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
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

/**
 * What InitiateAuth hands back to ANY caller, including one that talks to
 * Cognito directly (the app client id is public). It must be identical for
 * every caller class: it previously carried the address for real users and
 * Cognito's generated username for unknown ones, which let anyone tell them
 * apart (confirmed live). Nothing consumes it — auth-login keeps only
 * `ChallengeParameters.USERNAME`, which Cognito adds itself.
 */
const PUBLIC_CHALLENGE_PARAMETERS: Readonly<Record<string, string>> = { challenge: "MAGIC_LINK" };

/** Build the same "looks-normal but fails verify" response shape. */
function failClosedChallenge(
  event: CreateAuthChallengeEvent,
  email: string,
  reason: string,
  hmacKey: string,
): CreateAuthChallengeEvent {
  event.response.publicChallengeParameters = { ...PUBLIC_CHALLENGE_PARAMETERS };
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

  async function issue(event: CreateAuthChallengeEvent): Promise<CreateAuthChallengeEvent> {
    const attrs = event.request.userAttributes;
    const email = attrs.email;
    const isPhantom = email === undefined || email === "";
    // The phantom has no address: key its counters on the (random-looking)
    // username Cognito made up, so the writes happen but pollute nothing real.
    const subjectKey = isPhantom ? event.userName : email;

    const tokenTable = requiredEnv(RuntimeEnv.TOKEN_TABLE_NAME);
    const rateLimitTable = requiredEnv(RuntimeEnv.RATE_LIMIT_TABLE_NAME);
    const denylistTable = process.env[RuntimeEnv.DENYLIST_TABLE_NAME];
    const fromAddress = requiredEnv(RuntimeEnv.SES_FROM);
    const domain = requiredEnv(RuntimeEnv.DOMAIN);
    const configurationSetName = process.env[RuntimeEnv.SES_CONFIGURATION_SET];

    // A bad lifetime is a deployment error: fail closed rather than mail a link
    // whose real lifetime we cannot state (`signin_link_expires_10min`).
    const ttlMinutes = parseTokenTtlMinutes(process.env[RuntimeEnv.TOKEN_TTL_MINUTES]);
    if (ttlMinutes === undefined) {
      throw GENERIC_AUTH_ERROR();
    }
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
    // Resolved for the phantom too, so every path pays the same lookup.
    const hmacKey = await (deps.resolveHmacKey ?? resolveEmailHmacKeyFromEnv)();

    // -- 1. Same reads and writes for every caller ------------------------------
    const denylisted = await isDenylisted(dynamodb, denylistTable, subjectKey, hmacKey);
    const allowed = await tryConsumeRateLimit({
      client: dynamodb,
      tableName: rateLimitTable,
      email: subjectKey,
      limit: sendsPerWindow,
      nowMs: now,
    });

    // -- 2. Decide ----------------------------------------------------------------
    if (isPhantom) {
      return failClosedChallenge(event, event.userName, "unknown_user", "");
    }
    // `custom:email_quarantined` is written by the bounce-handler on a hard
    // bounce or complaint; reading it here is what makes that write matter.
    if (attrs["custom:email_quarantined"] === "true") {
      return failClosedChallenge(event, email, "quarantined", hmacKey);
    }
    if (denylisted) {
      return failClosedChallenge(event, email, "denylisted", hmacKey);
    }
    if (!allowed) {
      return failClosedChallenge(event, email, "rate_limited", hmacKey);
    }

    // -- 3. Generate token + store hash ----------------------------------------
    const tokenBuf = deps.randomToken?.() ?? randomBytes(32);
    const token = tokenBuf.toString("base64url");
    const hash = tokenHash(token);

    const nowSeconds = Math.floor(now / 1000);
    const expiresAtSeconds = nowSeconds + ttlMinutes * 60;
    const emailHmac = hmacKey ? hmacEmail(email, hmacKey) : "";

    await dynamodb.send(
      new PutItemCommand({
        TableName: tokenTable,
        Item: {
          token_hash: { S: hash },
          email_hmac: { S: emailHmac },
          created_at: { N: String(nowSeconds) },
          // Must be the attribute the table's TTL names, AND is checked in
          // Verify: the TTL only deletes, it does not refuse.
          [TTL_ATTRIBUTE]: { N: String(expiresAtSeconds) },
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
      ...(configurationSetName !== undefined && configurationSetName !== ""
        ? { configurationSetName }
        : {}),
    });

    // -- 5. Build response ------------------------------------------------------
    event.response.publicChallengeParameters = { ...PUBLIC_CHALLENGE_PARAMETERS };
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
  }

  return async function handler(
    event: CreateAuthChallengeEvent,
  ): Promise<CreateAuthChallengeEvent> {
    const floorMs = parseMs(process.env[RuntimeEnv.CREATE_FLOOR_MS], DEFAULT_CREATE_FLOOR_MS);
    return withFloor(floorMs, deps.nowMs ?? Date.now, deps.sleep ?? realSleep, () =>
      issue(event),
    );
  };
}
