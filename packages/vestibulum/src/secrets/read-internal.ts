/**
 * Package-internal helper that reads the plaintext value of a
 * tenant's secret from AWS Secrets Manager.
 *
 * **NOT EXPORTED FROM THE PACKAGE INDEX.** Consumers cannot
 * accidentally import this from `vestibulum-runtime`; it is only
 * used by:
 *   - `idp/oidc-manager.ts` — during `upsert(...)` to read the
 *     OIDC client secret before passing it to
 *     `CreateIdentityProvider` / `UpdateIdentityProvider`.
 *
 * Why this exists separately from {@link IdpSecretsClient}:
 * Cognito does not dereference Secrets Manager ARNs at
 * token-exchange time (see CreateIdentityProvider API ref); the
 * manager must therefore pass the literal client secret. Keeping
 * the read path in a non-exported module localises the
 * "plaintext lives on this call stack" surface — a route handler
 * that holds an `IdpSecretsClient` cannot call this function.
 *
 * SECRET — do not log the return value. The plaintext should not
 * outlive the calling stack frame.
 *
 * IAM: `secretsmanager:GetSecretValue`, scoped to the secret's
 * canonical name (or the configured `secretPrefix` wildcard).
 *
 * See doc/federation/02-runtime-api.md § Secrets handling.
 */

import { GetSecretValueCommand, ResourceNotFoundException } from "@aws-sdk/client-secrets-manager";

import { VestibulumRuntimeError } from "../errors.js";
import type { SecretKind } from "../types/secret-kind.js";
import { INTERNAL_CLIENT, type IdpSecretsClient } from "./secrets-client.js";

/**
 * Result of {@link getSecretValue} — plaintext plus the version
 * actually served by Secrets Manager.
 *
 * The pinned `versionId` is what callers (notably
 * `idp/oidc-manager.ts` per S-V2) need to populate
 * `OidcIdpRecord.clientSecret` with the version actually pushed to
 * Cognito. Drift between the persisted pin and `AWSCURRENT` is
 * how rotation tooling detects "Cognito is holding a stale secret".
 *
 * SECRET — `plaintext` lives only on the caller's stack frame; do
 * not store, log, or return it across a public boundary.
 */
export interface SecretReadResult {
  /** SECRET — plaintext value from Secrets Manager. */
  readonly plaintext: string;
  /** The version actually served by Secrets Manager. */
  readonly versionId: string;
  /** Canonical Secrets Manager ARN of the secret. */
  readonly arn: string;
}

/**
 * Read the plaintext value of a tenant's secret along with the
 * version ID Secrets Manager actually served.
 *
 * @param secretsClient - the `IdpSecretsClient` instance whose
 *   prefix and SDK client we reuse. The `secretName(...)` method
 *   is invoked to derive the canonical name.
 * @param tenantId      - tenant identifier (free-form; sanitised
 *   internally).
 * @param kind          - secret kind; defaults to
 *   `'oidc-client-secret'`.
 *
 * @throws {VestibulumRuntimeError} `secrets_client.not_found`
 *   when no version exists for the given tenant.
 * @throws {VestibulumRuntimeError} `secrets_client.empty_value`
 *   when Secrets Manager returns a record with no `SecretString`.
 *
 * @internal package-internal; not re-exported from index.ts.
 */
export async function getSecretValue(
  secretsClient: IdpSecretsClient,
  tenantId: string,
  kind?: SecretKind,
): Promise<SecretReadResult> {
  const name = secretsClient.secretName(tenantId, kind);
  // Pull the underlying SDK client via the package-internal symbol
  // attached at construction. The symbol is not re-exported from
  // the package index, so consumers cannot reach this path.
  const underlying = secretsClient[INTERNAL_CLIENT];
  try {
    const out = await underlying.send(new GetSecretValueCommand({ SecretId: name }));
    // SECRET — do not log the value.
    const plaintext = out.SecretString;
    if (typeof plaintext !== "string" || plaintext.length === 0) {
      throw new VestibulumRuntimeError(
        "secrets_client.empty_value",
        `Secret "${name}" has no SecretString (binary secrets are not supported)`,
      );
    }
    if (typeof out.VersionId !== "string" || out.VersionId.length === 0) {
      throw new VestibulumRuntimeError(
        "secrets_client.empty_value",
        `Secret "${name}" returned no VersionId; cannot pin SecretRef`,
      );
    }
    if (typeof out.ARN !== "string" || out.ARN.length === 0) {
      throw new VestibulumRuntimeError(
        "secrets_client.empty_value",
        `Secret "${name}" returned no ARN; cannot pin SecretRef`,
      );
    }
    return {
      plaintext,
      versionId: out.VersionId,
      arn: out.ARN,
    };
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      throw new VestibulumRuntimeError(
        "secrets_client.not_found",
        `No secret found for tenant "${tenantId}" (name "${name}")`,
      );
    }
    throw err;
  }
}
