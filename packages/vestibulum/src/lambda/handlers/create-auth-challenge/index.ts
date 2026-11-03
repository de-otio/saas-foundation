/**
 * Cognito `CreateAuthChallenge` trigger — magic-link issuance.
 *
 * Steps:
 *   1. Resolve the recipient from the Cognito event. An unknown address reaches
 *      this trigger as a phantom user with no `email` attribute. The address is
 *      normalised (U18) before anything uses it.
 *   2. For EVERY caller, phantom included, do the same reads and writes: the
 *      allow-list `get(event.userName)` (admin-only mode), the denylist lookup
 *      and the per-address rate-limit counter. Only then decide
 *      (`signin_request_indistinguishable`: no early return that is faster than
 *      the real path).
 *   3. Silent path — phantom, not on the allow-list, ineligible, quarantined
 *      (`custom:email_quarantined`), denylisted, over a cap, or ANY dependency
 *      error (`signin_fails_closed`): build a challenge the verifier will reject,
 *      indistinguishable from a normal one, send nothing and emit one
 *      `SignInSuppressed{reason}` metric. No exception reaches Cognito.
 *   4. Otherwise generate a 32-byte token and an 8-digit code, store only their
 *      SHA-256 hashes (`signin_token_at_rest_hashed`) — the token hash keys the
 *      token row with `expires_at` (the attribute the table's TTL names), the
 *      code hash rides next to it — and send the mail with the fragment link
 *      (primary) and the code (fallback for another browser).
 *   5. Respond with private and public challenge parameters.
 *
 * Every path — including a thrown configuration error — takes at least
 * `CREATE_FLOOR_MS`, so a caller that hits Cognito directly cannot tell the
 * paths apart by latency. The silent path generates and hashes a token and a
 * code it never sends, so its work has the same shape as the real one.
 *
 * Logging: regional CloudWatch only; closed enums only. Never an address, a
 * subject, a token, a code or a session (`signin_secrets_never_logged`).
 *
 * A deployment error (a required environment variable missing, an invalid
 * lifetime or enrolment value) is thrown as the generic
 * `Error("Authentication failed")`: it is the same for every caller and so
 * reveals nothing about any address.
 */

import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { SESClient } from "@aws-sdk/client-ses";
import { randomBytes } from "crypto";

import {
  createCognitoAllowList,
  eligible,
  type Eligibility,
  type SignInAllowList,
} from "../../shared/allow-list.js";
import { hmacEmail, resolveEmailHmacKeyFromEnv } from "../../shared/email-hmac.js";
import { normalizeEmail } from "../../shared/normalize-email.js";
import { RuntimeEnv } from "../../shared/runtime-env.js";
import {
  DEFAULT_CREATE_FLOOR_MS,
  TTL_ATTRIBUTE,
  emitSigninMetric,
  newSigninCode,
  parseEnrollment,
  parseMs,
  parseTokenTtlMinutes,
  realSleep,
  sha256Hex,
  withFloor,
} from "../../shared/signin.js";
import { GENERIC_AUTH_ERROR } from "../verify-auth-challenge/errors.js";
import { sendMagicLinkEmail } from "./magic-link-email.js";
import { isDenylisted } from "./quarantine-check.js";
import { DEFAULT_SENDS_PER_DAY, tryConsumeDailyCap } from "./daily-cap.js";
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
  /** Used to build the default Cognito allow-list. */
  readonly cognitoClient?: CognitoIdentityProviderClient;
  /**
   * The sign-in allow-list (`signin_mail_only_to_eligible`). Defaults to
   * {@link createCognitoAllowList} on this pool. Not consulted in
   * `self-signup` enrolment mode.
   */
  readonly allowList?: SignInAllowList;
  readonly nowMs?: () => number;
  /** Sleep used to hold the response floor. Injected in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly randomToken?: () => Buffer;
  /** The 8-digit code generator. Injected in tests. */
  readonly randomCode?: () => string;
  /**
   * Resolve the email-HMAC key. Defaults to reading the secret id from
   * `VESTIBULUM_BOUNCE_HMAC_SECRET` and fetching the value from Secrets Manager
   * (cached per warm container). Injected in tests to avoid a real fetch.
   */
  readonly resolveHmacKey?: () => Promise<string>;
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

/**
 * Closed set of reasons a challenge is unanswerable. Emitted as the
 * `SignInSuppressed{reason}` metric; never a per-caller value. Each name is
 * kept under 20 characters so the log-hygiene scan for base64url-looking runs
 * (`signin_secrets_never_logged`) can stay strict.
 */
export type SuppressionReason =
  | "unknown_user"
  | "ineligible"
  | "allow_list_down"
  | "quarantined"
  | "denylisted"
  | "denylist_down"
  | "rate_limited"
  | "daily_cap"
  | "dependency_error";

/** A read that either produced a value or failed — never throws. */
type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

async function settle<T>(read: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await read() };
  } catch {
    return { ok: false };
  }
}

/**
 * Build the "looks-normal but fails verify" response shape. The private
 * parameters have the same keys and value shapes as a real challenge: two
 * SHA-256 hashes of values nobody holds, and `quarantined: "true"`, which the
 * verifier refuses unconditionally. The code that was hashed is never sent and
 * never stored.
 */
function unanswerableChallenge(
  event: CreateAuthChallengeEvent,
  reason: SuppressionReason,
  email: string,
  generatedCode: string,
): CreateAuthChallengeEvent {
  event.response.publicChallengeParameters = { ...PUBLIC_CHALLENGE_PARAMETERS };
  event.response.privateChallengeParameters = {
    email,
    token_hash: sha256Hex(randomBytes(32).toString("base64url")),
    code_hash: sha256Hex(generatedCode),
    quarantined: "true",
  };
  event.response.challengeMetadata = "MAGIC_LINK";
  emitSigninMetric("SignInSuppressed", { reason });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ msg: "create.fail_closed", reason }));
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
  let defaultCognito: CognitoIdentityProviderClient | undefined;

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

  function getAllowList(userPoolId: string): SignInAllowList {
    if (deps.allowList) return deps.allowList;
    if (deps.cognitoClient) return createCognitoAllowList({ client: deps.cognitoClient, userPoolId });
    defaultCognito ??= new CognitoIdentityProviderClient({});
    return createCognitoAllowList({ client: defaultCognito, userPoolId });
  }

  async function issue(event: CreateAuthChallengeEvent): Promise<CreateAuthChallengeEvent> {
    const attrs = event.request.userAttributes;
    const rawEmail = attrs.email;
    // A phantom has no address; a stored address that does not normalise is
    // treated the same (it can never be a valid recipient).
    const email =
      typeof rawEmail === "string" && rawEmail !== "" ? normalizeEmail(rawEmail) : undefined;
    const isPhantom = email === undefined;
    // The phantom has no address: key its counters on the (random-looking)
    // username Cognito made up, so the writes happen but pollute nothing real.
    const subjectKey = email ?? event.userName;

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
    // An unknown enrolment value must neither open self-signup nor guess.
    const enrollment = parseEnrollment(process.env[RuntimeEnv.ENROLLMENT]);
    if (enrollment === undefined) {
      throw GENERIC_AUTH_ERROR();
    }
    const sendsPerWindow = Number.parseInt(
      process.env[RuntimeEnv.TOKEN_SENDS_PER_WINDOW] ?? String(DEFAULT_SENDS_PER_WINDOW),
      10,
    );

    // Per-address challenges per UTC day (I10). A malformed value is a deployment
    // error, like a bad lifetime: fail closed rather than run uncapped.
    const rawPerDay = process.env[RuntimeEnv.TOKEN_SENDS_PER_DAY];
    const sendsPerDay =
      rawPerDay === undefined || rawPerDay === ""
        ? DEFAULT_SENDS_PER_DAY
        : /^\d+$/.test(rawPerDay)
          ? Number.parseInt(rawPerDay, 10)
          : 0;
    if (sendsPerDay < 1) {
      throw GENERIC_AUTH_ERROR();
    }

    const dynamodb = getDynamoClient();
    const now = deps.nowMs?.() ?? Date.now();

    // The shape of the work does not depend on the outcome: a token and a code
    // are generated and hashed on every path. Only a real issue stores or sends them.
    const tokenBuf = deps.randomToken?.() ?? randomBytes(32);
    const token = tokenBuf.toString("base64url");
    const code = (deps.randomCode ?? newSigninCode)();
    const tokenHashHex = sha256Hex(token);
    const codeHashHex = sha256Hex(code);

    // -- 1. Same reads and writes for every caller ------------------------------
    // Each read is settled, never thrown: `signin_fails_closed` ends every
    // dependency error in "no mail, unanswerable, no exception to Cognito".
    //
    // The shared email-HMAC key (resolved once per warm container) keys the
    // denylist lookup and the token row's `email_hmac`.
    // An EMPTY key (email-hmac returns "" when the secret id is unset) is not a
    // key: every hash would be unkeyed and guessable. It is a dependency error.
    const hmacKey = await settle(async () => {
      const key = await (deps.resolveHmacKey ?? resolveEmailHmacKeyFromEnv)();
      if (typeof key !== "string" || key === "") throw new Error("empty hmac key");
      return key;
    });
    const denylisted = hmacKey.ok
      ? await settle(() => isDenylisted(dynamodb, denylistTable, subjectKey, hmacKey.value))
      : ({ ok: false } as const);
    const allowedByCap = hmacKey.ok
      ? await settle(() =>
          tryConsumeRateLimit({
            client: dynamodb,
            tableName: rateLimitTable,
            email: subjectKey,
            hmacKey: hmacKey.value,
            limit: sendsPerWindow,
            nowMs: now,
          }),
        )
      : ({ ok: false } as const);
    // The daily cap: the same conditional counter write for every caller, phantom
    // included, keyed on a secret-keyed hash of the address and the UTC date.
    const allowedByDay = hmacKey.ok
      ? await settle(() =>
          tryConsumeDailyCap({
            client: dynamodb,
            tableName: rateLimitTable,
            address: subjectKey,
            hmacKey: hmacKey.value,
            limit: sendsPerDay,
            nowMs: now,
          }),
        )
      : ({ ok: false } as const);
    // Same read for every caller (the phantom's username simply is not found).
    // Self-signup mode has no allow-list: its gate is the PreSignUp trigger.
    const eligibility: Settled<Eligibility | null> | undefined =
      enrollment === "admin-only"
        ? await settle(async () => {
            const answer = await getAllowList(
              process.env[RuntimeEnv.COGNITO_USER_POOL_ID] ?? event.userPoolId,
            ).get(event.userName);
            if (!answer.ok) throw new Error("allow-list unavailable");
            return answer.value;
          })
        : undefined;

    // -- 2. Decide ----------------------------------------------------------------
    const reason = ((): SuppressionReason | undefined => {
      if (isPhantom) return "unknown_user";
      if (eligibility !== undefined) {
        if (!eligibility.ok) return "allow_list_down";
        if (eligibility.value === null) return "unknown_user";
        if (!eligible(eligibility.value)) return "ineligible";
      }
      // `custom:email_quarantined` is written by the bounce-handler on a hard
      // bounce or complaint; reading it here is what makes that write matter.
      if (attrs["custom:email_quarantined"] === "true") return "quarantined";
      if (!hmacKey.ok) return "dependency_error";
      if (!denylisted.ok) return "denylist_down";
      if (denylisted.value) return "denylisted";
      if (!allowedByCap.ok) return "dependency_error";
      if (!allowedByCap.value) return "rate_limited";
      if (!allowedByDay.ok) return "dependency_error";
      if (!allowedByDay.value) return "daily_cap";
      return undefined;
    })();
    if (reason !== undefined || email === undefined || !hmacKey.ok) {
      return unanswerableChallenge(event, reason ?? "dependency_error", email ?? event.userName, code);
    }

    // -- 3. Store the hashes and send ------------------------------------------
    const nowSeconds = Math.floor(now / 1000);
    const expiresAtSeconds = nowSeconds + ttlMinutes * 60;
    const emailHmac = hmacEmail(email, hmacKey.value);

    try {
      await dynamodb.send(
        new PutItemCommand({
          TableName: tokenTable,
          Item: {
            token_hash: { S: tokenHashHex },
            code_hash: { S: codeHashHex },
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

      await sendMagicLinkEmail({
        sesClient: getSesClient(),
        fromAddress,
        toAddress: email,
        domain,
        token,
        code,
        ttlMinutes,
        ...(configurationSetName !== undefined && configurationSetName !== ""
          ? { configurationSetName }
          : {}),
      });
    } catch {
      // A failed store or send (SES down, an IAM recipient fence refusing the
      // address, ...) must neither reach Cognito nor leave an answerable
      // challenge: the private parameters below carry hashes of values that
      // were never mailed.
      return unanswerableChallenge(event, "dependency_error", email, code);
    }

    // -- 4. Build response ------------------------------------------------------
    event.response.publicChallengeParameters = { ...PUBLIC_CHALLENGE_PARAMETERS };
    event.response.privateChallengeParameters = {
      email,
      token_hash: tokenHashHex,
      code_hash: codeHashHex,
      quarantined: "false",
    };
    event.response.challengeMetadata = "MAGIC_LINK";

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ msg: "create.sent" }));

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
