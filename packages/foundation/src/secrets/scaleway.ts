/**
 * Scaleway Secret Manager backend for the foundation secret-resolution
 * port (WS-5).
 *
 * Sibling of `resolve.ts` (the AWS Secrets Manager / SSM resolvers): same
 * consumer contract — plaintext `Buffer` result, `SecretCache` with the
 * same TTL/zeroize semantics, the same error hierarchy
 * (`SecretsNotFoundError` / `SecretsAccessDeniedError` /
 * `SecretsTransientError` / `SecretsResolveError`), `fresh: true`
 * cache-bypass. AWS callers are untouched; this module is additive.
 *
 * API grounding (2026-07-20 — never write these shapes from memory):
 * - Secret Manager v1beta1, access by secret ID:
 *     GET https://api.scaleway.com/secret-manager/v1beta1/regions/{region}/secrets/{secret_id}/versions/{revision}/access
 * - Access by name+path (no ID needed — the config-friendly shape):
 *     GET .../secret-manager/v1beta1/regions/{region}/secrets-by-path/versions/{revision}/access
 *         ?secret_name=...&secret_path=...&project_id=...
 * - `{revision}`: `latest`, `latest_enabled`, or a version number.
 * - Auth: `X-Auth-Token: <IAM API secret key>`.
 * - Response: JSON with base64-encoded `data` (payload ≤ 64 KiB).
 * Source: https://www.scaleway.com/en/developers/api/secret-manager/
 *
 * Provider selection stays env-driven at the consumer, mirroring the
 * WS-1 `KV_PROVIDER` pattern: `SECRETS_PROVIDER` (unset/"aws" → the
 * existing AWS resolvers, ZERO change for existing deployments;
 * "scaleway" → this module). See {@link resolveSecretsProvider}.
 */

import { transientRetry } from "../_internal/retry.js";

import { SecretCache } from "./cache.js";
import {
  SecretsAccessDeniedError,
  SecretsNotFoundError,
  SecretsResolveError,
  SecretsTransientError,
} from "./errors.js";

/**
 * Reference to a Scaleway Secret Manager secret. Either `secretId` OR
 * `name` identifies the secret (id wins when both are set — it is the
 * unambiguous form). `path`/`projectId` scope the by-name lookup.
 */
export interface ScalewaySecretRef {
  /** Secret UUID — resolved via the by-id route. */
  readonly secretId?: string;
  /** Secret name — resolved via the by-path route. */
  readonly name?: string;
  /** Folder path for the by-name lookup. Defaults to "/". */
  readonly path?: string;
  /**
   * Project scoping for the by-name lookup. Strongly recommended: an IAM
   * key with access to several projects would otherwise resolve against
   * its default project only.
   */
  readonly projectId?: string;
  /** Region the secret lives in (e.g. "fr-par"). Required. */
  readonly region: string;
  /**
   * Version selector: "latest", "latest_enabled", or a version number.
   * Defaults to "latest_enabled" — a deliberately safer default than
   * "latest": a version an operator disabled (e.g. mid-rotation rollback)
   * is never served.
   */
  readonly revision?: string;
}

export class ScalewaySecretRefValidationError extends Error {
  override readonly name = "ScalewaySecretRefValidationError";
}

/** True when a nullable string holds a non-empty value (empty === absent). */
function present(v: string | undefined): v is string {
  return v != null && v !== "";
}

/** Validate + freeze a {@link ScalewaySecretRef}. Throws on nonsense. */
export function scalewaySecretRef(ref: ScalewaySecretRef): ScalewaySecretRef {
  if (!ref.region || typeof ref.region !== "string") {
    throw new ScalewaySecretRefValidationError("region is required");
  }
  if (!present(ref.secretId) && !present(ref.name)) {
    throw new ScalewaySecretRefValidationError("one of secretId or name is required");
  }
  if (ref.revision !== undefined && !/^(latest|latest_enabled|\d+)$/.test(ref.revision)) {
    throw new ScalewaySecretRefValidationError(
      'revision must be "latest", "latest_enabled", or a version number',
    );
  }
  return Object.freeze({ ...ref });
}

/**
 * Context for {@link resolveScalewaySecret}. All fields optional;
 * defaults: global `fetch`, module-scoped default cache, token from
 * `SCW_SECRET_KEY`.
 */
export interface ScalewayResolveContext {
  /** Injectable fetch (tests / fakes). Defaults to global `fetch`. */
  readonly fetchFn?: typeof fetch;
  /** Shared plaintext cache; same TTL semantics as the AWS resolver. */
  readonly cache?: SecretCache;
  /**
   * IAM API secret key used as `X-Auth-Token`. Defaults to
   * `process.env.SCW_SECRET_KEY` (the standard Scaleway SDK/CLI var).
   * Fail-closed: resolution throws `SecretsAccessDeniedError` when no
   * token is available — a request without a token could never succeed.
   */
  readonly secretKey?: string;
  /** API base URL override (fakes). Default `https://api.scaleway.com`. */
  readonly baseUrl?: string;
}

export interface ResolveScalewaySecretOptions {
  /** Bypass the cache and force a fresh fetch. */
  readonly fresh?: boolean;
}

let defaultCache: SecretCache | null = null;
function getDefaultCache(): SecretCache {
  if (defaultCache === null) defaultCache = new SecretCache();
  return defaultCache;
}

/** Test hook — mirrors `_resetDefaultCacheForTests` in resolve.ts. */
export function _resetScalewayDefaultCacheForTests(): void {
  if (defaultCache !== null) {
    defaultCache.clear();
    defaultCache = null;
  }
}

function cacheKey(ref: ScalewaySecretRef): string {
  const revision = ref.revision ?? "latest_enabled";
  const ident = present(ref.secretId)
    ? `id:${ref.secretId}`
    : `name:${ref.projectId ?? ""}:${ref.path ?? "/"}:${ref.name}`;
  return `scw-secret:${ref.region}:${ident}:${revision}`;
}

function accessUrl(baseUrl: string, ref: ScalewaySecretRef): string {
  const revision = encodeURIComponent(ref.revision ?? "latest_enabled");
  const region = encodeURIComponent(ref.region);
  if (present(ref.secretId)) {
    return `${baseUrl}/secret-manager/v1beta1/regions/${region}/secrets/${encodeURIComponent(ref.secretId)}/versions/${revision}/access`;
  }
  const params = new URLSearchParams({ secret_name: ref.name ?? "" });
  params.set("secret_path", ref.path ?? "/");
  if (present(ref.projectId)) params.set("project_id", ref.projectId);
  return `${baseUrl}/secret-manager/v1beta1/regions/${region}/secrets-by-path/versions/${revision}/access?${params.toString()}`;
}

/** Internal marker error so the retry policy engages on transient statuses. */
class TransientHttpError extends Error {
  override readonly name = "TransientHttpError";
  constructor(readonly status: number, body: string) {
    super(`Scaleway Secret Manager transient HTTP ${status}: ${body}`);
  }
}

function describeRef(ref: ScalewaySecretRef): string {
  return present(ref.secretId)
    ? `id=${ref.secretId} (${ref.region})`
    : `name=${ref.path ?? "/"}${ref.path?.endsWith("/") === true ? "" : "/"}${ref.name} (${ref.region})`;
}

/**
 * Resolve a Scaleway secret version to plaintext bytes.
 *
 * Same ownership rules as `resolveSecret`: the returned Buffer is the
 * cached instance — callers MUST treat it read-only; the cache zeroizes
 * it on eviction.
 *
 * Error mapping (fail-closed — a denied or missing secret NEVER
 * degrades to an empty value):
 *   404              → SecretsNotFoundError
 *   401 / 403        → SecretsAccessDeniedError
 *   408 / 429 / 5xx  → SecretsTransientError (after internal retry)
 *   anything else    → SecretsResolveError
 */
export async function resolveScalewaySecret(
  refInput: ScalewaySecretRef,
  context?: ScalewayResolveContext,
  options?: ResolveScalewaySecretOptions,
): Promise<Buffer> {
  const ref = scalewaySecretRef(refInput);
  const cache = context?.cache ?? getDefaultCache();
  const key = cacheKey(ref);

  if (options?.fresh === true) {
    cache.invalidate(key);
  } else {
    const hit = cache.get(key);
    if (hit !== null) return hit;
  }

  const token = context?.secretKey ?? process.env.SCW_SECRET_KEY;
  if (!present(token)) {
    throw new SecretsAccessDeniedError(
      `No Scaleway API token available for secret ${describeRef(ref)} — set SCW_SECRET_KEY or pass context.secretKey`,
    );
  }

  const fetchFn = context?.fetchFn ?? fetch;
  const url = accessUrl(context?.baseUrl ?? "https://api.scaleway.com", ref);

  let response: Response;
  try {
    response = await transientRetry.execute(async () => {
      const res = await fetchFn(url, {
        method: "GET",
        headers: { "X-Auth-Token": token },
      });
      if (res.status === 408 || res.status === 429 || res.status >= 500) {
        throw new TransientHttpError(res.status, (await res.text()).slice(0, 300));
      }
      return res;
    });
  } catch (err) {
    if (err instanceof TransientHttpError) {
      throw new SecretsTransientError(
        `Transient failure resolving Scaleway secret ${describeRef(ref)}`,
        err,
      );
    }
    // Network-level failure (DNS, connect, abort) post-retry.
    throw new SecretsTransientError(
      `Network failure resolving Scaleway secret ${describeRef(ref)}`,
      err,
    );
  }

  if (response.status === 404) {
    throw new SecretsNotFoundError(`Scaleway secret not found: ${describeRef(ref)}`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new SecretsAccessDeniedError(
      `Access denied for Scaleway secret: ${describeRef(ref)}`,
    );
  }
  if (!response.ok) {
    throw new SecretsResolveError(
      `Failed to resolve Scaleway secret ${describeRef(ref)}: HTTP ${response.status}`,
    );
  }

  let payload: { data?: unknown };
  try {
    payload = (await response.json()) as { data?: unknown };
  } catch (err) {
    throw new SecretsResolveError(
      `Scaleway Secret Manager returned non-JSON for ${describeRef(ref)}`,
      err,
    );
  }
  if (typeof payload.data !== "string") {
    throw new SecretsResolveError(
      `Scaleway Secret Manager returned no data field for ${describeRef(ref)}`,
    );
  }

  // `data` is base64 per the v1beta1 access response.
  const bytes = Buffer.from(payload.data, "base64");
  cache.set(key, bytes);
  return bytes;
}

/**
 * Env-driven backend selection, mirroring the trellis `KV_PROVIDER`
 * pattern: unset/"aws" keeps the AWS resolvers (zero change for
 * existing deployments); "scaleway" selects this module. Greenfield
 * Scaleway env configs set it explicitly (2026-07-20 scope decision:
 * defaults may be Scaleway-native in those configs, but the code
 * default stays AWS — the AWS profile remains a tested product
 * property).
 */
export type SecretsProvider = "aws" | "scaleway";

export function resolveSecretsProvider(
  env: { SECRETS_PROVIDER?: string } = process.env,
): SecretsProvider {
  return env.SECRETS_PROVIDER === "scaleway" ? "scaleway" : "aws";
}
