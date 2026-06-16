/**
 * Cognito `VerifyAuthChallengeResponse` trigger — magic-link redemption.
 *
 * Steps:
 *   1. Pull the submitted token from the challenge answer.
 *   2. Pull `email`, `token_hash`, `quarantined` from
 *      `privateChallengeParameters` (set by `CreateAuthChallenge`).
 *   3. If quarantined, return `answerCorrect: false`. The challenge was
 *      issued solely to keep enumeration parity with normal sends.
 *   4. If the session already contains a failed challenge, refuse — one
 *      failure ends the session permanently.
 *   5. Look up the token row in DynamoDB by `SHA-256(submitted_token)`.
 *      Missing row → `answerCorrect: false`.
 *   6. Cross-check the row's `email_hmac` against an HMAC of the email in
 *      `privateChallengeParameters` — defends against using a token issued
 *      for user A as a different user.
 *   7. Single-use enforcement: a single `DeleteItem` with
 *      `ConditionExpression: 'attribute_exists(token_hash)'`. A failed
 *      condition means a concurrent request already consumed it; that race
 *      loser returns `false` exactly like a missing row.
 *   8. Constant-time compare the `token_hash` private param against the
 *      hash we computed for the submitted token.
 *   9. Respond `answerCorrect: true`.
 *
 * Logging: regional CloudWatch only. Never logs the raw token. The email
 * address (which we have in the private params, not derived from the token)
 * is HMAC-hashed before any log line.
 */

import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import { createHash, timingSafeEqual } from "crypto";

import { hmacEmail, resolveEmailHmacKeyFromEnv } from "../../shared/email-hmac.js";
import { RuntimeEnv } from "../../shared/runtime-env.js";
import { GENERIC_AUTH_ERROR } from "./errors.js";

/** Minimal Cognito `VerifyAuthChallengeResponse` event shape. */
export interface VerifyAuthChallengeEvent {
  readonly userPoolId: string;
  readonly userName: string;
  readonly request: {
    readonly userAttributes: Record<string, string>;
    readonly privateChallengeParameters: Record<string, string>;
    readonly challengeAnswer: string;
    readonly session?: ReadonlyArray<{
      readonly challengeName?: string;
      readonly challengeResult?: boolean;
    }>;
    readonly clientMetadata?: Record<string, string>;
  };
  response: {
    answerCorrect?: boolean;
  };
}

/**
 * Injectable dependencies for the VerifyAuthChallenge handler.
 */
export interface VerifyAuthChallengeHandlerDeps {
  readonly dynamodb?: DynamoDBClient;
  /**
   * Resolve the email-HMAC key (used for the per-row `email_hmac` cross-check
   * and log redaction). Defaults to fetching from Secrets Manager via the id in
   * `VESTIBULUM_BOUNCE_HMAC_SECRET` (cached per warm container). MUST resolve to
   * the same value CreateAuthChallenge used, or every redemption fails the
   * email cross-check. Injected in tests.
   */
  readonly resolveHmacKey?: () => Promise<string>;
}

function hmacEmailForLogs(email: string | undefined, hmacKey: string): string {
  if (email === undefined || email === "") return "email:none";
  if (hmacKey === "") return "email:hmac-disabled";
  return `email:${hmacEmail(email, hmacKey).slice(0, 16)}`;
}

function fail(
  event: VerifyAuthChallengeEvent,
  reason: string,
  hmacKey: string,
  emailForLog?: string,
): VerifyAuthChallengeEvent {
  event.response.answerCorrect = false;
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      msg: "verify_auth_challenge.failed",
      reason,
      email: hmacEmailForLogs(emailForLog, hmacKey),
    }),
  );
  return event;
}

/** sha256 of a string, hex-encoded. */
function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Constant-time compare of two equal-length hex hashes.
 *
 * Both inputs are SHA-256 outputs (64 hex chars / 32 bytes). If either input
 * is the wrong length, we still run `timingSafeEqual` against a zero buffer
 * to keep timing identical between length-mismatch and value-mismatch cases.
 */
function constantTimeHashEqual(a: string, b: string): boolean {
  const buf = Buffer.alloc(32);
  let aBuf: Buffer;
  let bBuf: Buffer;
  try {
    aBuf = Buffer.from(a, "hex");
    bBuf = Buffer.from(b, "hex");
  } catch {
    return timingSafeEqual(buf, buf) && false;
  }
  if (aBuf.length !== 32 || bBuf.length !== 32) {
    // Run a real timingSafeEqual to keep the syscall pattern identical, then
    // return false.
    timingSafeEqual(buf, buf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Create a `VerifyAuthChallengeResponse` Cognito trigger handler.
 */
export function createVerifyAuthChallengeResponseHandler(
  deps: VerifyAuthChallengeHandlerDeps = {},
) {
  let defaultDynamodb: DynamoDBClient | undefined;

  function getDynamoClient(): DynamoDBClient {
    if (deps.dynamodb) return deps.dynamodb;
    defaultDynamodb ??= new DynamoDBClient({});
    return defaultDynamodb;
  }

  function requiredEnv(name: string): string {
    const value = process.env[name];
    if (value === undefined || value === "") {
      throw GENERIC_AUTH_ERROR();
    }
    return value;
  }

  return async function handler(
    event: VerifyAuthChallengeEvent,
  ): Promise<VerifyAuthChallengeEvent> {
    // Default to false up front so any unhandled path leaves the response in
    // the "rejected" state, never "approved".
    event.response.answerCorrect = false;

    const params = event.request.privateChallengeParameters ?? {};
    const expectedHash = params.token_hash;
    const email = params.email;
    const quarantined = params.quarantined === "true";

    // Resolve the shared email-HMAC key once (cached per warm container). MUST
    // match the key CreateAuthChallenge used to write `email_hmac`.
    const hmacKey = await (deps.resolveHmacKey ?? resolveEmailHmacKeyFromEnv)();

    // -- 1. Quarantined challenge -----------------------------------------------
    if (quarantined) {
      return fail(event, "quarantined", hmacKey, email);
    }

    // -- 2. Single-failure-ends-session ----------------------------------------
    const prior = event.request.session ?? [];
    for (const entry of prior) {
      if (entry?.challengeResult === false) {
        return fail(event, "prior_failure", hmacKey, email);
      }
    }

    // -- 3. Validate submitted token shape --------------------------------------
    const submitted = event.request.challengeAnswer;
    if (typeof submitted !== "string" || submitted.length === 0) {
      return fail(event, "empty_answer", hmacKey, email);
    }

    const submittedHash = sha256Hex(submitted);
    const tokenTable = requiredEnv(RuntimeEnv.TOKEN_TABLE_NAME);
    const dynamodb = getDynamoClient();

    // -- 4. Look up the token row by its hash -----------------------------------
    const lookup = await dynamodb.send(
      new GetItemCommand({
        TableName: tokenTable,
        Key: { token_hash: { S: submittedHash } },
        ConsistentRead: true,
      }),
    );
    if (!lookup.Item) {
      return fail(event, "no_such_token", hmacKey, email);
    }

    // -- 5. Email cross-check ---------------------------------------------------
    const storedEmailHmac = lookup.Item.email_hmac?.S ?? "";
    const expectedEmailHmac =
      hmacKey === "" || email === undefined || email === "" ? "" : hmacEmail(email, hmacKey);
    if (
      storedEmailHmac.length === 0 ||
      expectedEmailHmac.length === 0 ||
      storedEmailHmac.length !== expectedEmailHmac.length ||
      !timingSafeEqual(Buffer.from(storedEmailHmac, "hex"), Buffer.from(expectedEmailHmac, "hex"))
    ) {
      return fail(event, "email_mismatch", hmacKey, email);
    }

    // -- 6. Single-use enforcement via conditional DeleteItem ------------------
    try {
      await dynamodb.send(
        new DeleteItemCommand({
          TableName: tokenTable,
          Key: { token_hash: { S: submittedHash } },
          ConditionExpression: "attribute_exists(token_hash)",
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        // Lost the race or already redeemed — exactly one winner per token.
        return fail(event, "already_consumed", hmacKey, email);
      }
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          msg: "verify_auth_challenge.delete_error",
          email: hmacEmailForLogs(email, hmacKey),
        }),
      );
      return fail(event, "delete_error", hmacKey, email);
    }

    // -- 7. Constant-time compare of the issued hash to the submitted hash ----
    if (
      expectedHash === undefined ||
      expectedHash === "" ||
      !constantTimeHashEqual(expectedHash, submittedHash)
    ) {
      return fail(event, "hash_mismatch", hmacKey, email);
    }

    event.response.answerCorrect = true;
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        msg: "verify_auth_challenge.success",
        email: hmacEmailForLogs(email, hmacKey),
      }),
    );
    return event;
  };
}
