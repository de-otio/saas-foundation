/**
 * Tenant-scoped client for IdP-related secrets in AWS Secrets Manager.
 *
 * The class deliberately omits a public `get(...)` method.
 *
 * Why: Cognito stores the literal OIDC client secret internally and
 * does not dereference Secrets Manager ARNs at token-exchange time
 * (see CreateIdentityProvider API ref). The IdP manager must
 * therefore read plaintext during `upsert(...)` and pass it to the
 * Cognito SDK. To keep that read narrowly scoped, the package
 * exposes the plaintext-read code path only to
 * `idp/oidc-manager.ts` via the `secrets/read-internal` helper —
 * which is intentionally **not** re-exported from the package
 * index. A consumer that holds an `IdpSecretsClient` instance in,
 * say, an HTTP route handler cannot accidentally read a tenant's
 * OIDC client secret; only the explicit IdP-CRUD code path can.
 *
 * Naming convention (recommended): the consumer passes
 * `secretPrefix: '/vestibulum/idp/<app-name>/'` at construction.
 * The full name becomes `<prefix><kind>/<tenantId>`.
 *
 * IAM (documented per-method):
 *   - `store(...)`  → `secretsmanager:CreateSecret`,
 *                     `secretsmanager:PutSecretValue`,
 *                     `secretsmanager:DescribeSecret` (used by
 *                     `update`-vs-`create` fallback), scoped to
 *                     `<accountSecretPrefix><tenantId>*`.
 *   - `delete(...)` → `secretsmanager:DeleteSecret`, scoped to
 *                     the same prefix.
 *   - `arnFor(...)` → no IAM; pure ARN construction.
 *
 * See doc/federation/02-runtime-api.md § Secrets handling.
 */

import {
  CreateSecretCommand,
  DeleteSecretCommand,
  PutSecretValueCommand,
  ResourceExistsException,
  ResourceNotFoundException,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

import { VestibulumRuntimeError } from "../errors.js";
import type { SecretKind } from "../types/secret-kind.js";

const DEFAULT_KIND: SecretKind = "oidc-client-secret";

/**
 * 7-day recovery window when deleting. Matches the AWS minimum,
 * which is the recommendation in the spec.
 */
const RECOVERY_DAYS = 7;

/**
 * Construction props.
 *
 * - `region` defaults to the SDK's resolved region (env vars
 *   AWS_REGION / AWS_DEFAULT_REGION, then EC2/ECS metadata).
 *   Tests must pass an explicit region to make ARN expectations
 *   stable.
 * - `secretPrefix` is **mandatory** and validated: must start with
 *   `/`, end with `/`, and contain only the characters Secrets
 *   Manager itself allows (`/_+=.@-`, alphanumerics).
 * - `secretsClient` is the AWS SDK client; injectable for tests.
 */
export interface IdpSecretsClientProps {
  region?: string;
  secretPrefix: string;
  secretsClient?: SecretsManagerClient;
  /**
   * Override the AWS account ID embedded in ARNs returned by
   * `arnFor()`. Typically not needed in production (the SDK call
   * to `CreateSecret` / `PutSecretValue` returns the canonical
   * ARN), but `arnFor()` is a pure-compute method by design.
   * Required when `region` is set without environment-resolved
   * credentials available (i.e. tests).
   */
  accountId?: string;
}

/**
 * Result of {@link IdpSecretsClient.store}.
 */
export interface StoredSecret {
  arn: string;
  versionId: string;
}

/**
 * Secrets Manager secret-name characters that are unsafe to embed
 * in a path segment. Most ASCII punctuation is allowed by the
 * service; we exclude `/` (path-segment separator) and whitespace
 * (defensive — admin tenants supplying free-form IDs).
 */
const UNSAFE_CHARS = /[^A-Za-z0-9/_+=.@-]/g;

/**
 * Validate `secretPrefix` at construction. Throws a plain
 * `VestibulumRuntimeError` (not `IdpManagerError` — this is a
 * configuration error, not an IdP-CRUD failure).
 */
function validatePrefix(prefix: string): void {
  if (typeof prefix !== "string" || prefix.length === 0) {
    throw new VestibulumRuntimeError(
      "secrets_client.invalid_prefix",
      "secretPrefix is required and must be a non-empty string",
    );
  }
  if (!prefix.startsWith("/")) {
    throw new VestibulumRuntimeError(
      "secrets_client.invalid_prefix",
      `secretPrefix must start with "/" (got "${prefix}")`,
    );
  }
  if (!prefix.endsWith("/")) {
    throw new VestibulumRuntimeError(
      "secrets_client.invalid_prefix",
      `secretPrefix must end with "/" (got "${prefix}")`,
    );
  }
  if (UNSAFE_CHARS.test(prefix)) {
    throw new VestibulumRuntimeError(
      "secrets_client.invalid_prefix",
      `secretPrefix contains characters Secrets Manager does not allow (${prefix})`,
    );
  }
}

/**
 * Sanitise a free-form tenant ID for embedding in a Secrets
 * Manager name. We replace disallowed characters with `_` rather
 * than `-` so the result remains visually distinct from the
 * Cognito IdP name (which uses `-`).
 */
function sanitiseTenantId(tenantId: string): string {
  if (!tenantId) {
    throw new VestibulumRuntimeError(
      "secrets_client.invalid_tenant_id",
      "tenantId must be a non-empty string",
    );
  }
  return tenantId.replace(UNSAFE_CHARS, "_");
}

/**
 * Validate `kind` — must be a non-empty string with no
 * characters disallowed by Secrets Manager.
 */
function validateKind(kind: SecretKind): string {
  if (typeof kind !== "string" || kind.length === 0) {
    throw new VestibulumRuntimeError(
      "secrets_client.invalid_kind",
      "kind must be a non-empty string",
    );
  }
  if (UNSAFE_CHARS.test(kind)) {
    throw new VestibulumRuntimeError(
      "secrets_client.invalid_kind",
      `kind contains characters Secrets Manager does not allow ("${kind}")`,
    );
  }
  return kind;
}

/**
 * Symbol used by the package-internal `read-internal.ts` to access
 * the underlying SDK client without making it part of the public
 * surface. Consumers cannot reach it because the symbol is not
 * exported.
 *
 * @internal
 */
export const INTERNAL_CLIENT: unique symbol = Symbol("vestibulum-runtime.IdpSecretsClient.client");

/**
 * Tenant-scoped secrets client.
 */
export class IdpSecretsClient {
  private readonly client: SecretsManagerClient;
  /**
   * @internal
   *   The same client as {@link IdpSecretsClient.client}, exposed
   *   through a non-enumerable symbol so the package-internal
   *   `read-internal.ts` can issue `GetSecretValue` without
   *   reflection. Consumers cannot reach it because
   *   `INTERNAL_CLIENT` is not re-exported from the package index.
   */
  public readonly [INTERNAL_CLIENT]: SecretsManagerClient;
  /**
   * Validated, normalised prefix (always starts and ends with `/`).
   * @internal exposed only to package-internal helpers in
   *   `secrets/read-internal.ts`.
   */
  public readonly secretPrefix: string;
  /** Resolved region, used to build ARNs. */
  public readonly region: string;
  /** Optional account ID supplied at construction. */
  public readonly accountId?: string;

  constructor(props: IdpSecretsClientProps) {
    validatePrefix(props.secretPrefix);
    this.secretPrefix = props.secretPrefix;
    this.region = props.region ?? process.env.AWS_REGION ?? "us-east-1";
    if (props.accountId !== undefined) {
      this.accountId = props.accountId;
    }
    this.client =
      props.secretsClient ??
      new SecretsManagerClient({
        ...(props.region !== undefined && props.region !== "" ? { region: props.region } : {}),
      });
    this[INTERNAL_CLIENT] = this.client;
  }

  /**
   * Construct the full Secrets Manager name for a `(tenantId, kind)`
   * pair. Internal so the manager and `read-internal.ts` can share
   * the format; not re-exported.
   *
   * @internal
   */
  public secretName(tenantId: string, kind: SecretKind = DEFAULT_KIND): string {
    const k = validateKind(kind);
    const safe = sanitiseTenantId(tenantId);
    return `${this.secretPrefix}${k}/${safe}`;
  }

  /**
   * Return the canonical ARN for a tenant's secret without making
   * a network call. The ARN's name segment is the canonical
   * Secrets Manager name (`<prefix><kind>/<sanitisedTenantId>`);
   * the random 6-character suffix that the service appends to
   * real ARNs is omitted — Secrets Manager accepts the
   * suffix-less form on `GetSecretValue`/`PutSecretValue`/etc.
   */
  public arnFor(tenantId: string, kind: SecretKind = DEFAULT_KIND): string {
    const account = this.accountId;
    if (account === undefined || account === "") {
      throw new VestibulumRuntimeError(
        "secrets_client.missing_account_id",
        "arnFor() requires accountId; pass it at construction or call after store() which returns the ARN.",
      );
    }
    return `arn:aws:secretsmanager:${this.region}:${account}:secret:${this.secretName(tenantId, kind)}`;
  }

  /**
   * Create or rotate a tenant's secret.
   *
   * Behaviour:
   *   - If the secret does not exist, `CreateSecret` is called.
   *   - If the secret exists (i.e. `CreateSecret` throws
   *     `ResourceExistsException`), the value is written as a new
   *     version via `PutSecretValue`. Prior versions are retained
   *     per the account's default retention policy.
   *
   * Returns the canonical ARN and the new version ID.
   *
   * IAM:
   *   secretsmanager:CreateSecret, secretsmanager:PutSecretValue,
   *   scoped to `<secretPrefix>*`.
   */
  public async store(
    tenantId: string,
    secretValue: string,
    kind: SecretKind = DEFAULT_KIND,
  ): Promise<StoredSecret> {
    if (typeof secretValue !== "string" || secretValue.length === 0) {
      throw new VestibulumRuntimeError(
        "secrets_client.invalid_value",
        "secretValue must be a non-empty string",
      );
    }
    const name = this.secretName(tenantId, kind);

    try {
      const created = await this.client.send(
        new CreateSecretCommand({
          Name: name,
          // SECRET — do not log; SecretString lives only on the
          // SDK request envelope for the duration of this call.
          SecretString: secretValue,
          Description: `Vestibulum-managed ${kind} for tenant ${tenantId}`,
        }),
      );
      if (
        created.ARN === undefined ||
        created.ARN === "" ||
        created.VersionId === undefined ||
        created.VersionId === ""
      ) {
        throw new VestibulumRuntimeError(
          "secrets_client.unexpected_response",
          "CreateSecret did not return ARN + VersionId",
        );
      }
      return { arn: created.ARN, versionId: created.VersionId };
    } catch (err) {
      if (!(err instanceof ResourceExistsException)) {
        throw err;
      }
      // Fall through to rotation path.
    }

    const put = await this.client.send(
      new PutSecretValueCommand({
        SecretId: name,
        // SECRET — do not log.
        SecretString: secretValue,
      }),
    );
    if (
      put.ARN === undefined ||
      put.ARN === "" ||
      put.VersionId === undefined ||
      put.VersionId === ""
    ) {
      throw new VestibulumRuntimeError(
        "secrets_client.unexpected_response",
        "PutSecretValue did not return ARN + VersionId",
      );
    }
    return { arn: put.ARN, versionId: put.VersionId };
  }

  /**
   * Schedule deletion of a tenant's secret with a 7-day recovery
   * window (the AWS minimum).
   *
   * If the secret does not exist (`ResourceNotFoundException`),
   * the call is a no-op — consistent with idempotent
   * disconnect-tenant workflows.
   *
   * IAM: secretsmanager:DeleteSecret, scoped to `<secretPrefix>*`.
   */
  public async delete(tenantId: string, kind: SecretKind = DEFAULT_KIND): Promise<void> {
    const name = this.secretName(tenantId, kind);
    try {
      await this.client.send(
        new DeleteSecretCommand({
          SecretId: name,
          RecoveryWindowInDays: RECOVERY_DAYS,
        }),
      );
    } catch (err) {
      if (err instanceof ResourceNotFoundException) {
        return;
      }
      throw err;
    }
  }
}
