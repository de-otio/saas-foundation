/**
 * TenantSubdomain — frozen-set branded string type.
 *
 * See doc/vestibulum/shared-distribution/README.md § Decisions log for the
 * canonical spec. This type encodes the DNS-label shape of a tenant subdomain
 * in shared-distribution mode.
 *
 * Constraints, enforced by `tenantSubdomain(...)`:
 *   - 3–63 characters (DNS label limits)
 *   - Pattern: /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/ — alpha-start, lowercase
 *     only, no trailing dash, no consecutive dashes not required but
 *     structural dash-at-end prevention is baked in.
 *
 * Brand is a zero-runtime-cost nominal type; erases at compile time.
 * `TenantSubdomain` is a string for all wire / storage purposes.
 */

declare const TenantSubdomainBrand: unique symbol;

/** Branded string. Erases to a plain string at runtime. */
export type TenantSubdomain = string & { readonly [TenantSubdomainBrand]: true };

/** Documented constraints; exported so consumers can introspect (e.g., for UI hints). */
export interface TenantSubdomainConstraints {
  readonly minLength: 3;
  readonly maxLength: 63;
  /** /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/ — alpha-start, lowercase, no trailing dash. */
  readonly pattern: RegExp;
}

/** The canonical constraint values. Frozen so consumers cannot mutate. */
export const TENANT_SUBDOMAIN_CONSTRAINTS: TenantSubdomainConstraints = Object.freeze({
  minLength: 3,
  maxLength: 63,
  pattern: /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/,
} as const);

/**
 * Validation error thrown by `tenantSubdomain(...)` on invalid input.
 *
 * `name` is the discriminant — call sites can do
 * `err instanceof TenantSubdomainValidationError` or
 * `err.name === 'TenantSubdomainValidationError'`.
 */
export class TenantSubdomainValidationError extends Error {
  public override readonly name = "TenantSubdomainValidationError";
  public readonly input: unknown;

  public constructor(input: unknown, reason: string) {
    super(`Invalid TenantSubdomain: ${reason}`);
    this.input = input;
  }
}

/**
 * Validate the structural constraints of a string against the TenantSubdomain
 * rules. Pure, side-effect free.
 *
 * Returns `null` on success; a reason string on failure.
 */
function validateTenantSubdomainShape(value: string): string | null {
  if (value.length < TENANT_SUBDOMAIN_CONSTRAINTS.minLength) {
    return `must be at least ${TENANT_SUBDOMAIN_CONSTRAINTS.minLength} characters`;
  }
  if (value.length > TENANT_SUBDOMAIN_CONSTRAINTS.maxLength) {
    return `must be at most ${TENANT_SUBDOMAIN_CONSTRAINTS.maxLength} characters`;
  }
  if (!TENANT_SUBDOMAIN_CONSTRAINTS.pattern.test(value)) {
    return "must match pattern /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/ (lowercase alpha-start, no trailing dash)";
  }
  return null;
}

/**
 * Construct a `TenantSubdomain` from a string. Throws
 * `TenantSubdomainValidationError` if the input violates the documented
 * constraints.
 */
export function tenantSubdomain(value: string): TenantSubdomain {
  if (typeof value !== "string") {
    throw new TenantSubdomainValidationError(value, "must be a string");
  }
  const failure = validateTenantSubdomainShape(value);
  if (failure !== null) {
    throw new TenantSubdomainValidationError(value, failure);
  }
  return value as TenantSubdomain;
}

/**
 * Type predicate. Returns true iff `value` is a string that satisfies
 * the TenantSubdomain constraints. Never throws.
 */
export function isTenantSubdomain(value: unknown): value is TenantSubdomain {
  if (typeof value !== "string") {
    return false;
  }
  return validateTenantSubdomainShape(value) === null;
}
