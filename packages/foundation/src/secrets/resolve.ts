/**
 * `resolveSecret` / `resolveParameter` — the consumer-facing resolvers.
 *
 * Per doc/foundation/03-secrets.md:
 *   - Two stores, two access shapes: Secrets Manager (`resolveSecret`)
 *     and SSM Parameter Store (`resolveParameter`).
 *   - Result is plaintext bytes — `Buffer` per review S-Sec1 so the
 *     cache layer can zeroize on eviction.
 *   - Cache hit → return cached bytes; cache miss → SDK round-trip,
 *     cache result, return.
 *   - `fresh: true` invalidates the cache entry and re-fetches.
 *
 * Retry policy: cockatiel's `transientRetry` (already declared in
 * `_internal/retry.ts`) is applied around the SDK call so a single
 * transient blip does not bubble out as a `SecretsTransientError`.
 *
 * Error classification:
 *   - `ResourceNotFoundException` / `ParameterNotFound` → NotFound
 *   - `AccessDeniedException` / `UnrecognizedClientException` /
 *     `DecryptionFailure` → AccessDenied
 *   - `ThrottlingException` / `InternalServiceError` / network errors
 *     (post-retry) → Transient
 *   - anything else → the base `SecretsResolveError`
 */

import { GetSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";

import { transientRetry } from "../_internal/retry.js";
import type { SecretRef } from "../types/frozen/secrets.js";

import { SecretCache } from "./cache.js";
import { createDefaultSecretsManagerClient, createDefaultSsmClient } from "./clients.js";
import {
  ParameterAccessDeniedError,
  ParameterNotFoundError,
  SecretsAccessDeniedError,
  SecretsNotFoundError,
  SecretsResolveError,
  SecretsTransientError,
} from "./errors.js";

/**
 * Context for a `resolveSecret` / `resolveParameter` call. Each field
 * is optional; absent fields fall back to module-scoped defaults
 * (default cache, lazily-constructed default clients).
 *
 * Tests inject all three to get full determinism: a mocked SDK client,
 * a fresh cache, and a frozen clock (the cache's own clock).
 */
export interface ResolveContext {
  readonly secretsClient?: SecretsManagerClient;
  readonly ssmClient?: SSMClient;
  readonly cache?: SecretCache;
}

export interface ResolveSecretOptions {
  /** Bypass the cache and force a fresh fetch. */
  readonly fresh?: boolean;
}

export interface ResolveParameterOptions extends ResolveSecretOptions {
  /**
   * For `SecureString` parameters, request decryption. Defaults to
   * `true` — there is no point reading a SecureString as the ciphertext.
   */
  readonly withDecryption?: boolean;
}

/**
 * Module-scoped default cache. Per the design doc, "the default cache
 * lives in a module-scoped `let defaultCache` and the consumer can
 * override at instantiation." The default is lazily created so a
 * consumer that always passes its own cache pays nothing.
 */
let defaultCache: SecretCache | null = null;

function getDefaultCache(): SecretCache {
  if (defaultCache === null) {
    defaultCache = new SecretCache();
  }
  return defaultCache;
}

/**
 * Test hook: reset the module-scoped default cache. NOT part of the
 * public API. Used by tests to ensure isolation between cases.
 */
export function _resetDefaultCacheForTests(): void {
  if (defaultCache !== null) {
    defaultCache.clear();
    defaultCache = null;
  }
}

let lazySecretsClient: SecretsManagerClient | null = null;
let lazySsmClient: SSMClient | null = null;

function getDefaultSecretsClient(): SecretsManagerClient {
  if (lazySecretsClient === null) {
    // Lazy-construct the client so a consumer that always injects
    // one (or never calls into the resolver) pays no instantiation cost.
    lazySecretsClient = createDefaultSecretsManagerClient();
  }
  return lazySecretsClient;
}

function getDefaultSsmClient(): SSMClient {
  if (lazySsmClient === null) {
    lazySsmClient = createDefaultSsmClient();
  }
  return lazySsmClient;
}

/**
 * Cache-key derivation for a SecretRef. The `versionId` falls back to
 * the literal `'AWSCURRENT'` so a `fresh: true` call after a version
 * pin does not collide with the unpinned entry.
 */
function secretCacheKey(ref: SecretRef): string {
  return `secret:${ref.arn}:${ref.versionId ?? "AWSCURRENT"}`;
}

function parameterCacheKey(name: string, withDecryption: boolean): string {
  return `param:${name}:${withDecryption ? "decrypted" : "raw"}`;
}

/**
 * Inspect an arbitrary thrown value and return an SDK error name if
 * one is discoverable. The AWS SDK v3 surfaces these via a `name`
 * field and (sometimes) a `__type` field.
 */
function awsErrorName(err: unknown): string | null {
  if (typeof err !== "object" || err === null) {
    return null;
  }
  const obj = err as { readonly name?: unknown; readonly __type?: unknown };
  if (typeof obj.name === "string" && obj.name.length > 0) {
    return obj.name;
  }
  if (typeof obj.__type === "string" && obj.__type.length > 0) {
    return obj.__type;
  }
  return null;
}

function classifySecretsError(err: unknown, ref: SecretRef): SecretsResolveError {
  const name = awsErrorName(err);
  const arn = ref.arn;
  if (name === "ResourceNotFoundException") {
    return new SecretsNotFoundError(`Secret not found: ${arn}`, err);
  }
  if (
    name === "AccessDeniedException" ||
    name === "UnrecognizedClientException" ||
    name === "DecryptionFailure"
  ) {
    return new SecretsAccessDeniedError(`Access denied for secret: ${arn}`, err);
  }
  if (
    name === "ThrottlingException" ||
    name === "InternalServiceError" ||
    name === "InternalServiceErrorException" ||
    name === "TimeoutError"
  ) {
    return new SecretsTransientError(`Transient failure resolving secret: ${arn}`, err);
  }
  return new SecretsResolveError(`Failed to resolve secret: ${arn}`, err);
}

function classifyParameterError(err: unknown, name: string): SecretsResolveError {
  const errName = awsErrorName(err);
  if (errName === "ParameterNotFound") {
    return new ParameterNotFoundError(`Parameter not found: ${name}`, err);
  }
  if (errName === "AccessDeniedException" || errName === "UnrecognizedClientException") {
    return new ParameterAccessDeniedError(`Access denied for parameter: ${name}`, err);
  }
  if (
    errName === "ThrottlingException" ||
    errName === "InternalServerError" ||
    errName === "TimeoutError"
  ) {
    return new SecretsTransientError(`Transient failure resolving parameter: ${name}`, err);
  }
  return new SecretsResolveError(`Failed to resolve parameter: ${name}`, err);
}

/**
 * Resolve a `SecretRef` to plaintext bytes. The Buffer lives in the
 * cache (per S-Sec1) and is also returned to the caller. The caller
 * MUST treat the buffer as read-only — modifying it would mutate the
 * cached entry. The cache is zeroized on eviction.
 */
export async function resolveSecret(
  ref: SecretRef,
  context?: ResolveContext,
  options?: ResolveSecretOptions,
): Promise<Buffer> {
  const cache = context?.cache ?? getDefaultCache();
  const key = secretCacheKey(ref);

  if (options?.fresh === true) {
    cache.invalidate(key);
  } else {
    const hit = cache.get(key);
    if (hit !== null) {
      return hit;
    }
  }

  const client = context?.secretsClient ?? getDefaultSecretsClient();
  const commandInput =
    ref.versionId !== undefined
      ? { SecretId: ref.arn, VersionId: ref.versionId }
      : { SecretId: ref.arn };
  const command = new GetSecretValueCommand(commandInput);

  let response;
  try {
    response = await transientRetry.execute(() => client.send(command));
  } catch (err) {
    throw classifySecretsError(err, ref);
  }

  // SecretString takes precedence; SecretBinary is the fallback for
  // binary secrets. Per the design doc's open question, v0.1 reads
  // both as `Buffer` so the cache layer can zeroize uniformly.
  let bytes: Buffer;
  if (typeof response.SecretString === "string") {
    bytes = Buffer.from(response.SecretString, "utf-8");
  } else if (response.SecretBinary !== undefined) {
    bytes = Buffer.from(response.SecretBinary);
  } else {
    throw new SecretsResolveError(
      `Secrets Manager returned no SecretString or SecretBinary for ${ref.arn}`,
    );
  }

  cache.set(key, bytes);
  return bytes;
}

/**
 * Resolve an SSM parameter to plaintext bytes. Mirrors `resolveSecret`
 * for SSM Parameter Store. `withDecryption` defaults to true — for
 * SecureString parameters this is required; for plain String
 * parameters it is a no-op.
 */
export async function resolveParameter(
  name: string,
  context?: ResolveContext,
  options?: ResolveParameterOptions,
): Promise<Buffer> {
  const withDecryption = options?.withDecryption ?? true;
  const cache = context?.cache ?? getDefaultCache();
  const key = parameterCacheKey(name, withDecryption);

  if (options?.fresh === true) {
    cache.invalidate(key);
  } else {
    const hit = cache.get(key);
    if (hit !== null) {
      return hit;
    }
  }

  const client = context?.ssmClient ?? getDefaultSsmClient();
  const command = new GetParameterCommand({ Name: name, WithDecryption: withDecryption });

  let response;
  try {
    response = await transientRetry.execute(() => client.send(command));
  } catch (err) {
    throw classifyParameterError(err, name);
  }

  const value = response.Parameter?.Value;
  if (typeof value !== "string") {
    throw new ParameterNotFoundError(`Parameter has no value: ${name}`);
  }

  const bytes = Buffer.from(value, "utf-8");
  cache.set(key, bytes);
  return bytes;
}
