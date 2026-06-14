/**
 * TenantId — frozen-set branded string type.
 *
 * See doc/04-shared-vocabulary.md § TenantId for the canonical spec.
 *
 * Constraints, enforced by `tenantId(...)`:
 *   - 1–256 characters
 *   - No whitespace or C0 control characters (and no DEL, 0x7f)
 *
 * Brand is a zero-runtime-cost nominal type; erases at compile time.
 * `TenantId` is a string for all wire / storage purposes.
 */

declare const TenantIdBrand: unique symbol;

/** Branded string. Erases to a plain string at runtime. */
export type TenantId = string & { readonly [TenantIdBrand]: true };

/** Documented constraints; exported so consumers can introspect (e.g., for UI hints). */
export interface TenantIdConstraints {
  readonly minLength: 1;
  readonly maxLength: 256;
  /** /^[^\s\x00-\x1f\x7f]+$/ — no whitespace, no C0 controls, no DEL. */
  readonly pattern: RegExp;
}

/** The canonical constraint values. Frozen so consumers cannot mutate. */
export const TENANT_ID_CONSTRAINTS: TenantIdConstraints = Object.freeze({
  minLength: 1,
  maxLength: 256,
  // eslint-disable-next-line no-control-regex -- intentional: ban C0 controls and DEL
  pattern: /^[^\s\x00-\x1f\x7f]+$/,
} as const);

/**
 * Validation error thrown by `tenantId(...)` on invalid input.
 *
 * `name` is the discriminant — call sites can do
 * `err instanceof TenantIdValidationError` or `err.name === 'TenantIdValidationError'`.
 */
export class TenantIdValidationError extends Error {
  public override readonly name = "TenantIdValidationError";
  public readonly input: unknown;

  public constructor(input: unknown, reason: string) {
    super(`Invalid TenantId: ${reason}`);
    this.input = input;
  }
}

/**
 * Validate the structural constraints of a string against the TenantId rules.
 * Pure, side-effect free.
 *
 * Returns `null` on success; a reason string on failure.
 */
function validateTenantIdShape(value: string): string | null {
  if (value.length < TENANT_ID_CONSTRAINTS.minLength) {
    return "must be at least 1 character";
  }
  if (value.length > TENANT_ID_CONSTRAINTS.maxLength) {
    return "must be at most 256 characters";
  }
  if (!TENANT_ID_CONSTRAINTS.pattern.test(value)) {
    return "must not contain whitespace or control characters";
  }
  return null;
}

/**
 * Construct a `TenantId` from a string. Throws `TenantIdValidationError`
 * if the input violates the documented constraints.
 */
export function tenantId(value: string): TenantId {
  if (typeof value !== "string") {
    throw new TenantIdValidationError(value, "must be a string");
  }
  const failure = validateTenantIdShape(value);
  if (failure !== null) {
    throw new TenantIdValidationError(value, failure);
  }
  return value as TenantId;
}

/**
 * Type predicate. Returns true iff `value` is a string that satisfies
 * the TenantId constraints. Never throws.
 */
export function isTenantId(value: unknown): value is TenantId {
  if (typeof value !== "string") {
    return false;
  }
  return validateTenantIdShape(value) === null;
}
