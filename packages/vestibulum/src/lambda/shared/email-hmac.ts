/**
 * Canonical email-HMAC helper, shared across the magic-link Lambdas.
 *
 * Every place that hashes an email address — the `email_hmac` token-row
 * attribute (CreateAuthChallenge / VerifyAuthChallengeResponse), the
 * bounce/complaint denylist key (bounce-handler write, quarantine-check read),
 * and log redaction — MUST agree on (a) the key and (b) the canonical form of
 * the address, or the hashes silently fail to match. Two real bugs came from
 * not having this single source of truth:
 *
 *   1. The key was the Secrets Manager **ARN** (the env var holds the ARN, not
 *      the secret value), so the "secret" was effectively public — anyone who
 *      knows account/region/secret-name could reconstruct any `email_hmac` and
 *      brute-force the low-entropy email space from a table snapshot. This
 *      module resolves the real secret value at runtime (cached per warm
 *      container) so the HMAC is actually keyed on a high-entropy secret.
 *   2. The denylist read used a plain unkeyed `sha256` while the write used a
 *      keyed HMAC, and the write did not lowercase while the reads did — so a
 *      bounced address was never actually blocked. {@link hmacEmail} is the one
 *      function both sides call, and it always lowercases.
 *
 * SECRET — the resolved key is a peppering secret. Never log it.
 */

import { createHmac } from "crypto";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

import { RuntimeEnv } from "./runtime-env.js";

/**
 * Compute the canonical HMAC-SHA-256 of an email address, hex-encoded.
 *
 * The address is lowercased first so callers cannot disagree on case. The same
 * `key` MUST be used on both sides of any compare (issue vs verify, write vs
 * read) — use {@link resolveEmailHmacKeyFromEnv} to obtain it.
 */
export function hmacEmail(email: string, key: string): string {
  return createHmac("sha256", key).update(email.toLowerCase()).digest("hex");
}

/** Module-level cache: one Secrets Manager round-trip per warm container. */
let cachedKey: string | undefined;
let cachedFor: string | undefined;

/** Options for {@link resolveEmailHmacKeyFromEnv} (test seams). */
export interface ResolveEmailHmacKeyOptions {
  /** Inject a SecretsManagerClient (tests / custom region). */
  readonly client?: SecretsManagerClient;
  /** Override the env-var name holding the secret id (defaults to BOUNCE_HMAC_SECRET). */
  readonly envName?: string;
}

/**
 * Resolve the email-HMAC key from Secrets Manager.
 *
 * The env var (`VESTIBULUM_BOUNCE_HMAC_SECRET`) holds the secret's **id**
 * (ARN or name), NOT the value — Lambda env vars are stored in plaintext in the
 * CloudFormation template and visible in the console, so the value must never
 * live there. We resolve the value via `GetSecretValue` and cache it for the
 * life of the warm container (peppering secrets rotate on the order of months,
 * far slower than container lifetime; a stale-after-rotation window is
 * acceptable and self-heals on the next cold start).
 *
 * Returns `""` when the env var is unset (HMAC disabled — used only by tests
 * that intentionally omit the secret); production always sets it. Throws if the
 * secret id is set but resolves to an empty value (misconfiguration we want to
 * surface, not silently disable peppering).
 *
 * IAM: the calling function needs `secretsmanager:GetSecretValue` on the
 * secret. CreateAuthChallenge, VerifyAuthChallengeResponse, and the
 * bounce-handler are all granted it by the construct.
 */
export async function resolveEmailHmacKeyFromEnv(
  options: ResolveEmailHmacKeyOptions = {},
): Promise<string> {
  const envName = options.envName ?? RuntimeEnv.BOUNCE_HMAC_SECRET;
  const secretId = process.env[envName];
  if (secretId === undefined || secretId === "") {
    return "";
  }
  if (cachedKey !== undefined && cachedFor === secretId) {
    return cachedKey;
  }
  const client = options.client ?? new SecretsManagerClient({});
  const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  const value = out.SecretString;
  // SECRET — do not log `value`.
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      "email-hmac: BOUNCE_HMAC_SECRET resolved to an empty value " +
        "(binary secrets are not supported)",
    );
  }
  cachedKey = value;
  cachedFor = secretId;
  return value;
}

/** Test-only: clear the module cache between cases. */
export function __resetEmailHmacKeyCache(): void {
  cachedKey = undefined;
  cachedFor = undefined;
}
