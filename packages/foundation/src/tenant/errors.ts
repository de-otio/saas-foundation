/**
 * Named error types for the tenant module.
 *
 * All errors carry a discriminant `name` field so call sites can use
 * `instanceof` checks or the `name` field for branching.
 */

/**
 * Thrown by a resolver when a fatal lookup error occurs (e.g., DNS
 * outage, custom-domain DB unreachable). Distinct from "no tenant
 * matched" (which returns `null`).
 */
export class TenantResolverError extends Error {
  public override readonly name = "TenantResolverError" as const;
  public readonly hostname: string | undefined;

  public constructor(message: string, options?: { hostname?: string; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.hostname = options?.hostname;
  }
}

/**
 * Thrown when a request was expected to be tenant-scoped but no tenant
 * could be resolved. The consumer's middleware translates this to an
 * HTTP 404 / 400.
 */
export class TenantNotFoundError extends Error {
  public override readonly name = "TenantNotFoundError" as const;
  public readonly hostname: string | undefined;

  public constructor(message = "Tenant could not be resolved", hostname?: string) {
    super(message);
    this.hostname = hostname;
  }
}

/**
 * Thrown when a resolved tenant is rejected by an authorization gate
 * (e.g., a guard discovered the tenant is suspended). Reserved for
 * future use; resolver internals don't throw this directly, but it is
 * exported so consumer guard code can.
 */
export class TenantAuthorizationError extends Error {
  public override readonly name = "TenantAuthorizationError" as const;
  public readonly reason: string;

  public constructor(reason: string) {
    super(`Tenant authorization failed: ${reason}`);
    this.reason = reason;
  }
}
