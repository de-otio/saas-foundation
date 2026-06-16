/**
 * Shared-distribution `CreateAuthChallenge` Cognito trigger — magic-link issuance.
 *
 * Reads per-client `siteBaseUrl` from `ClientConfig` via DDB.
 * Fail-closed: DDB errors propagate; unknown client → throw.
 *
 * Critical: a fallback `siteBaseUrl` is NOT permitted. A wrong siteBaseUrl
 * would issue a magic link pointing at the wrong tenant — a cross-tenant
 * redirect. Always refuse rather than misroute.
 */

import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { createHash, randomBytes } from 'crypto';
import { loadClientConfigByClientId } from '../shared/client-config-loader.js';
import { hmacEmail, resolveEmailHmacKeyFromEnv } from '../../shared/email-hmac.js';
import { isDenylisted } from '../../handlers/create-auth-challenge/quarantine-check.js';
import { tryConsumeRateLimit, DEFAULT_SENDS_PER_WINDOW } from '../../handlers/create-auth-challenge/rate-limit.js';

/** Minimal Cognito CreateAuthChallenge event shape. */
export interface SharedCreateAuthChallengeEvent {
  readonly callerContext: {
    readonly clientId: string;
  };
  readonly request: {
    readonly userAttributes: Record<string, string>;
    readonly session?: ReadonlyArray<unknown>;
  };
  response: {
    publicChallengeParameters?: Record<string, string>;
    privateChallengeParameters?: Record<string, string>;
    challengeMetadata?: string;
  };
}

/** Injectable dependencies for testability. */
export interface CreateAuthChallengeDeps {
  readonly dynamodb?: DynamoDBClient;
  readonly ses?: SESClient;
  readonly nowMs?: () => number;
  readonly randomToken?: () => Buffer;
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error('Authentication failed');
  return v;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function buildMagicLinkEmailCommand(opts: {
  fromAddress: string;
  toAddress: string;
  link: string;
  ttlMinutes: number;
}): SendEmailCommand {
  const { link, ttlMinutes: ttl, fromAddress, toAddress } = opts;

  const textBody = [
    'Sign in by opening this link in the same browser you started in.',
    '',
    link,
    '',
    `This link expires in ${ttl} minutes and can be used only once.`,
    'If you did not request this, you can ignore this message.',
  ].join('\n');

  const htmlBody = [
    '<!doctype html>',
    '<html><body style="font-family: system-ui, sans-serif;">',
    '<p>Sign in by opening this link in the same browser you started in.</p>',
    `<p><a href="${link}">${link}</a></p>`,
    `<p>This link expires in ${ttl} minutes and can be used only once.</p>`,
    '<p>If you did not request this, you can ignore this message.</p>',
    '</body></html>',
  ].join('\n');

  return new SendEmailCommand({
    Source: fromAddress,
    Destination: { ToAddresses: [toAddress] },
    Message: {
      Subject: { Data: 'Your sign-in link', Charset: 'UTF-8' },
      Body: {
        Text: { Data: textBody, Charset: 'UTF-8' },
        Html: { Data: htmlBody, Charset: 'UTF-8' },
      },
    },
  });
}

/**
 * Factory — returns a CreateAuthChallenge handler wired with `deps`.
 */
export function createSharedCreateAuthChallengeHandler(deps: CreateAuthChallengeDeps = {}) {
  let defaultDdb: DynamoDBClient | undefined;
  let defaultSes: SESClient | undefined;

  function getDdb(): DynamoDBClient {
    if (deps.dynamodb) return deps.dynamodb;
    defaultDdb ??= new DynamoDBClient({});
    return defaultDdb;
  }

  function getSes(): SESClient {
    if (deps.ses) return deps.ses;
    const region = process.env['VESTIBULUM_SES_REGION'] ?? process.env['AWS_REGION'];
    defaultSes ??= new SESClient(region !== undefined ? { region } : {});
    return defaultSes;
  }

  return async function handler(
    event: SharedCreateAuthChallengeEvent,
  ): Promise<SharedCreateAuthChallengeEvent> {
    // Fail-closed: DDB error propagates. No client row → throw.
    const cfg = await loadClientConfigByClientId(event.callerContext.clientId);
    if (!cfg) throw new Error('Auth challenge failed');

    const email = event.request.userAttributes['email'];
    if (email === undefined || email === '') throw new Error('Authentication failed');

    const tokenTable = requiredEnv('VESTIBULUM_TOKEN_TABLE');
    const rateLimitTable = requiredEnv('VESTIBULUM_RATE_LIMIT_TABLE');
    const denylistTable = process.env['VESTIBULUM_DENYLIST_TABLE'];
    const fromAddress = requiredEnv('VESTIBULUM_SES_FROM');
    const ttlMinutes = Number.parseInt(process.env['VESTIBULUM_TOKEN_TTL_MINUTES'] ?? '15', 10);
    const sendsPerWindow = Number.parseInt(
      process.env['VESTIBULUM_TOKEN_SENDS_PER_WINDOW'] ?? String(DEFAULT_SENDS_PER_WINDOW),
      10,
    );

    const ddb = getDdb();
    const ses = getSes();
    const now = deps.nowMs?.() ?? Date.now();
    // Shared email-HMAC key (resolved value, not the Secrets Manager id) — used
    // for both the denylist key and the token-row `email_hmac`.
    const hmacKey = await resolveEmailHmacKeyFromEnv();

    // Denylist check.
    if (await isDenylisted(ddb, denylistTable, email, hmacKey)) {
      return failClosedChallenge(event, email, 'denylisted');
    }

    // Rate limit.
    const allowed = await tryConsumeRateLimit({
      client: ddb,
      tableName: rateLimitTable,
      email,
      limit: sendsPerWindow,
      nowMs: now,
    });
    if (!allowed) {
      return failClosedChallenge(event, email, 'rate_limited');
    }

    // Generate token.
    const tokenBuf = deps.randomToken?.() ?? randomBytes(32);
    const token = tokenBuf.toString('base64url');
    const hash = tokenHash(token);

    const ttlEpochSeconds = Math.floor(now / 1000) + ttlMinutes * 60;
    const emailHmac = hmacKey ? hmacEmail(email, hmacKey) : '';

    await ddb.send(
      new PutItemCommand({
        TableName: tokenTable,
        Item: {
          token_hash: { S: hash },
          email_hmac: { S: emailHmac },
          created_at: { N: String(Math.floor(now / 1000)) },
          ttl: { N: String(ttlEpochSeconds) },
        },
        ConditionExpression: 'attribute_not_exists(token_hash)',
      }),
    );

    // Build magic-link URL using per-client siteBaseUrl — NOT a pool-wide default.
    // Fail-closed: if cfg is null we already threw above, so siteBaseUrl is always set.
    const link = `${cfg.siteBaseUrl}/login/callback#token=${token}`;

    await ses.send(buildMagicLinkEmailCommand({ fromAddress, toAddress: email, link, ttlMinutes }));

    event.response.publicChallengeParameters = { email };
    event.response.privateChallengeParameters = {
      email,
      token_hash: hash,
      quarantined: 'false',
    };
    event.response.challengeMetadata = 'MAGIC_LINK';

    return event;
  };
}

/** Default exported handler using module-level singletons. */
export const handler = createSharedCreateAuthChallengeHandler();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function failClosedChallenge(
  event: SharedCreateAuthChallengeEvent,
  email: string,
  _reason: string,
): SharedCreateAuthChallengeEvent {
  event.response.publicChallengeParameters = { email };
  event.response.privateChallengeParameters = {
    email,
    token_hash: 'denied',
    quarantined: 'true',
  };
  event.response.challengeMetadata = 'MAGIC_LINK';
  return event;
}
