/**
 * Cognito `VerifyAuthChallengeResponse` trigger — magic-link redemption.
 *
 * The answer is one of two forms (`signin_answer_compare_constant_time`): the
 * 43-character base64url link token, or the 8-digit code typed in the browser
 * that asked. Anything else is `answerCorrect: false` without throwing.
 *
 * Steps:
 *   1. Pull the submitted answer and classify it (token | code).
 *   2. Pull `email`, `token_hash`, `code_hash`, `quarantined` from
 *      `privateChallengeParameters` (set by `CreateAuthChallenge`).
 *   3. If quarantined, return `answerCorrect: false`. The challenge was
 *      issued solely to keep enumeration parity with normal sends.
 *   4. If the session already contains a failed challenge, refuse — one
 *      failure ends the session permanently.
 *   5. COMPARE FIRST: constant-time compare, on equal-length buffers, the hash
 *      of the submitted answer with this session's own stored hash for that
 *      form (`token_hash` or `code_hash`). A mismatch fails here, before the
 *      store is touched, so a valid link presented against another session is
 *      NOT burned (`signin_link_single_use`, 01-evidence #17).
 *   6. Look up the token row by this session's `token_hash`. Missing row →
 *      `answerCorrect: false`. For the code form the row's own `code_hash`
 *      must match as well.
 *   7. Cross-check the row's `email_hmac` against an HMAC of the email in
 *      `privateChallengeParameters` — defends against using a token issued
 *      for user A as a different user.
 *   8. Enforce expiry: the row's `expires_at` (epoch seconds) must be in the
 *      future. A missing or malformed `expires_at` fails closed. The table's
 *      DynamoDB TTL is cleanup only (`signin_link_expires_10min`).
 *   9. CONSUME: single-use enforcement via a single `DeleteItem` with
 *      `ConditionExpression: 'attribute_exists(token_hash)'`. The link and the
 *      code are two forms of ONE secret: whichever is used first spends both.
 *      A failed condition means a concurrent request already consumed it; that
 *      race loser returns `false` exactly like a missing row.
 *  10. RE-CHECK ELIGIBILITY (`signin_redeem_rechecks_eligibility`, admin-only
 *      mode): the subject must still be eligible NOW. A person disabled between
 *      request and click must not get in. This runs after the consume on
 *      purpose — an ineligible redemption has spent its link — and an
 *      unavailable allow-list is `false` (fail closed): the user requests a new
 *      link once it is back.
 *  11. Respond `answerCorrect: true`.
 *
 * Logging: regional CloudWatch only; closed-enum reasons only — never the
 * answer, the address or the subject.
 */

import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  type GetItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { timingSafeEqual } from "crypto";

import {
  createCognitoAllowList,
  eligible,
  type SignInAllowList,
} from "../../shared/allow-list.js";
import { hmacEmail, resolveEmailHmacKeyFromEnv } from "../../shared/email-hmac.js";
import { RuntimeEnv } from "../../shared/runtime-env.js";
import {
  MAX_ANSWER_LENGTH,
  TTL_ATTRIBUTE,
  classifyAnswer,
  parseEnrollment,
  sha256Hex,
} from "../../shared/signin.js";
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
  /** Used to build the default Cognito allow-list. */
  readonly cognitoClient?: CognitoIdentityProviderClient;
  /**
   * The sign-in allow-list, re-checked at redemption. Defaults to
   * {@link createCognitoAllowList} on this pool. Not consulted in
   * `self-signup` enrolment mode.
   */
  readonly allowList?: SignInAllowList;
  /**
   * Resolve the email-HMAC key (used for the per-row `email_hmac` cross-check).
   * Defaults to fetching from Secrets Manager via the id in
   * `VESTIBULUM_BOUNCE_HMAC_SECRET` (cached per warm container). MUST resolve to
   * the same value CreateAuthChallenge used, or every redemption fails the
   * email cross-check. Injected in tests.
   */
  readonly resolveHmacKey?: () => Promise<string>;
  /** Clock for the expiry check. Defaults to `Date.now()`. Injected in tests. */
  readonly nowMs?: () => number;
}

/** Closed set of failure reasons, logged (never per-caller data). */
type FailReason =
  | "quarantined"
  | "prior_failure"
  | "empty_answer"
  | "bad_answer"
  | "hash_mismatch"
  | "no_such_token"
  | "code_mismatch"
  | "email_mismatch"
  | "expired"
  | "already_consumed"
  | "delete_error"
  | "ineligible"
  | "allow_list_down"
  | "dependency_error";

function fail(event: VerifyAuthChallengeEvent, reason: FailReason): VerifyAuthChallengeEvent {
  event.response.answerCorrect = false;
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ msg: "verify.failed", reason }));
  return event;
}

/**
 * Constant-time compare of two equal-length hex hashes.
 *
 * Both inputs are SHA-256 outputs (64 hex chars / 32 bytes). If either input
 * is the wrong length, we still run `timingSafeEqual` against a zero buffer
 * to keep timing identical between length-mismatch and value-mismatch cases.
 */
function constantTimeHashEqual(a: string | undefined, b: string | undefined): boolean {
  const buf = Buffer.alloc(32);
  const aBuf = Buffer.from(a ?? "", "hex");
  const bBuf = Buffer.from(b ?? "", "hex");
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
  let defaultCognito: CognitoIdentityProviderClient | undefined;

  function getDynamoClient(): DynamoDBClient {
    if (deps.dynamodb) return deps.dynamodb;
    defaultDynamodb ??= new DynamoDBClient({});
    return defaultDynamodb;
  }

  function getAllowList(userPoolId: string): SignInAllowList {
    if (deps.allowList) return deps.allowList;
    if (deps.cognitoClient) return createCognitoAllowList({ client: deps.cognitoClient, userPoolId });
    defaultCognito ??= new CognitoIdentityProviderClient({});
    return createCognitoAllowList({ client: defaultCognito, userPoolId });
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
    const email = params.email;
    const quarantined = params.quarantined === "true";

    // Deployment configuration: a bad enrolment value fails the same way for
    // every caller.
    const enrollment = parseEnrollment(process.env[RuntimeEnv.ENROLLMENT]);
    if (enrollment === undefined) {
      throw GENERIC_AUTH_ERROR();
    }

    // Resolve the shared email-HMAC key once (cached per warm container). MUST
    // match the key CreateAuthChallenge used to write `email_hmac`.
    // A dependency error (Secrets Manager, DynamoDB) ends in `answerCorrect:
    // false` and a closed-enum log line — never a thrown SDK error, whose text
    // the Lambda runtime would write to the log (`signin_fails_closed`,
    // `signin_secrets_never_logged`).
    let hmacKey: string;
    try {
      hmacKey = await (deps.resolveHmacKey ?? resolveEmailHmacKeyFromEnv)();
    } catch {
      return fail(event, "dependency_error");
    }

    // -- 1. Quarantined challenge -----------------------------------------------
    if (quarantined) {
      return fail(event, "quarantined");
    }

    // -- 2. Single-failure-ends-session ----------------------------------------
    const prior = event.request.session ?? [];
    for (const entry of prior) {
      if (entry?.challengeResult === false) {
        return fail(event, "prior_failure");
      }
    }

    // -- 3. Validate submitted answer shape (bounded length, two accepted forms) ---
    const submitted = event.request.challengeAnswer;
    if (typeof submitted !== "string" || submitted.length === 0) {
      return fail(event, "empty_answer");
    }
    if (submitted.length > MAX_ANSWER_LENGTH) {
      return fail(event, "bad_answer");
    }
    const form = classifyAnswer(submitted);
    if (form === undefined) {
      return fail(event, "bad_answer");
    }

    const submittedHash = sha256Hex(submitted);
    // The token row is keyed by this SESSION's token hash whichever form was
    // typed: the link and the code are two forms of one secret.
    const rowKey = params.token_hash;
    const expectedHash = form === "token" ? params.token_hash : params.code_hash;

    // -- 4. COMPARE FIRST ----------------------------------------------------------
    // The session's own hash for this form (written by CreateAuthChallenge into
    // the private parameters) must equal the hash of what was submitted. This
    // runs before any store access so an answer that belongs to a DIFFERENT
    // session fails without being consumed: the real owner can still redeem it.
    if (!constantTimeHashEqual(expectedHash, submittedHash) || rowKey === undefined) {
      return fail(event, "hash_mismatch");
    }

    const tokenTable = requiredEnv(RuntimeEnv.TOKEN_TABLE_NAME);
    const dynamodb = getDynamoClient();

    // -- 5. Look up the token row by its hash -----------------------------------
    let lookup: GetItemCommandOutput;
    try {
      lookup = await dynamodb.send(
        new GetItemCommand({
          TableName: tokenTable,
          Key: { token_hash: { S: rowKey } },
          ConsistentRead: true,
        }),
      );
    } catch {
      return fail(event, "dependency_error");
    }
    if (!lookup.Item) {
      return fail(event, "no_such_token");
    }

    // The code form must also match the hash stored in the row itself.
    if (form === "code" && !constantTimeHashEqual(lookup.Item["code_hash"]?.S, submittedHash)) {
      return fail(event, "code_mismatch");
    }

    // -- 6. Email cross-check ---------------------------------------------------
    const storedEmailHmac = lookup.Item.email_hmac?.S ?? "";
    const expectedEmailHmac =
      hmacKey === "" || email === undefined || email === "" ? "" : hmacEmail(email, hmacKey);
    if (
      storedEmailHmac.length === 0 ||
      expectedEmailHmac.length === 0 ||
      storedEmailHmac.length !== expectedEmailHmac.length ||
      !timingSafeEqual(Buffer.from(storedEmailHmac, "hex"), Buffer.from(expectedEmailHmac, "hex"))
    ) {
      return fail(event, "email_mismatch");
    }

    // -- 7. Expiry (the table TTL is cleanup only) ---------------------------------
    // `expires_at` is epoch seconds. Missing / non-numeric fails closed. A row
    // written by an older release (attribute `ttl`) therefore fails too — the
    // link was issued before the upgrade and the user simply requests a new one.
    const expiresAtSeconds = Number(lookup.Item[TTL_ATTRIBUTE]?.N);
    const nowMs = (deps.nowMs ?? Date.now)();
    if (!Number.isFinite(expiresAtSeconds) || nowMs >= expiresAtSeconds * 1000) {
      return fail(event, "expired");
    }

    // -- 8. CONSUME: single-use via conditional DeleteItem ----------------------
    try {
      await dynamodb.send(
        new DeleteItemCommand({
          TableName: tokenTable,
          Key: { token_hash: { S: rowKey } },
          ConditionExpression: "attribute_exists(token_hash)",
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        // Lost the race or already redeemed — exactly one winner per token.
        return fail(event, "already_consumed");
      }
      return fail(event, "delete_error");
    }

    // -- 9. Re-check eligibility at redemption (I8) ---------------------------------
    if (enrollment === "admin-only") {
      let now: Awaited<ReturnType<SignInAllowList["get"]>>;
      try {
        now = await getAllowList(
          process.env[RuntimeEnv.COGNITO_USER_POOL_ID] ?? event.userPoolId,
        ).get(event.userName);
      } catch {
        return fail(event, "allow_list_down");
      }
      if (!now.ok) return fail(event, "allow_list_down");
      if (!eligible(now.value)) return fail(event, "ineligible");
    }

    event.response.answerCorrect = true;
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ msg: "verify.success" }));
    return event;
  };
}
