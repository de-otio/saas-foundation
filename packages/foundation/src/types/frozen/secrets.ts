/**
 * SecretRef — frozen-set secret reference shape.
 *
 * See doc/04-shared-vocabulary.md § SecretRef for the canonical spec.
 *
 * A `SecretRef` carries the ARN of a Secrets Manager secret plus an
 * optional version pin. It NEVER carries the plaintext value;
 * resolution to plaintext is done by foundation's secrets module
 * (P3) via `resolveSecret(ref: SecretRef): Promise<string>`.
 *
 * ARN shape (validated by `secretRef(...)`):
 *   arn:aws:secretsmanager:<region>:<account>:secret:<name>-<6char>
 *
 * `<6char>` is the random suffix AWS appends; six lowercase
 * alphanumerics. Malformed ARNs throw at construction.
 */

/**
 * AWS Secrets Manager ARN pattern.
 *
 * Components:
 *   - arn:aws:secretsmanager:        — service prefix
 *   - <region>                       — AWS region (e.g. eu-central-1)
 *   - <account>                      — 12-digit account ID
 *   - secret:                        — resource type
 *   - <name>                         — secret name (any allowed chars)
 *   - -<6char>                       — random suffix
 *
 * We deliberately keep the name segment permissive — AWS allows
 * `/`, `_`, `+`, `=`, `.`, `@`, `-` and alphanumerics. The 6-char
 * suffix is what distinguishes an ARN from a partial reference.
 */
const ARN_PATTERN =
  /^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$/;

export interface SecretRef {
  /** Secrets Manager ARN. Validated at construction. */
  readonly arn: string;
  /** Pinned version ID. Absent means AWSCURRENT. */
  readonly versionId?: string;
}

/**
 * Validation error thrown by `secretRef(...)` on invalid input.
 */
export class SecretRefValidationError extends Error {
  public override readonly name = "SecretRefValidationError";
  public readonly input: unknown;

  public constructor(input: unknown, reason: string) {
    super(`Invalid SecretRef: ${reason}`);
    this.input = input;
  }
}

/**
 * Validate an ARN against the Secrets Manager ARN shape.
 * Returns null on success, a reason string on failure.
 */
function validateArn(arn: string): string | null {
  if (arn.length === 0) {
    return "ARN must be non-empty";
  }
  if (!ARN_PATTERN.test(arn)) {
    return "ARN must match arn:aws:secretsmanager:<region>:<account>:secret:<name>-<6char>";
  }
  return null;
}

/**
 * Validate a version ID. Secrets Manager version IDs are UUID-shaped
 * (32 hex digits with optional dashes) but we keep the check loose —
 * any non-empty string that does not contain whitespace is acceptable.
 */
function validateVersionId(versionId: string): string | null {
  if (versionId.length === 0) {
    return "versionId, if provided, must be non-empty";
  }
  if (/\s/.test(versionId)) {
    return "versionId must not contain whitespace";
  }
  return null;
}

/**
 * Construct a `SecretRef`. Throws `SecretRefValidationError` if the
 * ARN is malformed or the version ID is empty / whitespace-bearing.
 *
 * The returned object is frozen — mutation would silently desync
 * the SecretRef from any consumer holding a reference.
 */
export function secretRef(arn: string, versionId?: string): SecretRef {
  if (typeof arn !== "string") {
    throw new SecretRefValidationError({ arn, versionId }, "ARN must be a string");
  }
  const arnFailure = validateArn(arn);
  if (arnFailure !== null) {
    throw new SecretRefValidationError({ arn, versionId }, arnFailure);
  }
  if (versionId !== undefined) {
    if (typeof versionId !== "string") {
      throw new SecretRefValidationError({ arn, versionId }, "versionId must be a string");
    }
    const versionFailure = validateVersionId(versionId);
    if (versionFailure !== null) {
      throw new SecretRefValidationError({ arn, versionId }, versionFailure);
    }
  }
  const result: SecretRef = versionId === undefined ? { arn } : { arn, versionId };
  return Object.freeze(result);
}

/**
 * Type predicate. Returns true iff `value` looks like a valid
 * `SecretRef` (well-formed ARN, valid optional versionId). Never throws.
 */
export function isSecretRef(value: unknown): value is SecretRef {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { readonly arn?: unknown; readonly versionId?: unknown };
  if (typeof candidate.arn !== "string") {
    return false;
  }
  if (validateArn(candidate.arn) !== null) {
    return false;
  }
  if (candidate.versionId !== undefined) {
    if (typeof candidate.versionId !== "string") {
      return false;
    }
    if (validateVersionId(candidate.versionId) !== null) {
      return false;
    }
  }
  return true;
}
