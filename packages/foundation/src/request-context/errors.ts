/**
 * Named error types for the request-context module.
 */

/**
 * Thrown by `setRequestContext` when called after handler dispatch has begun
 * (outside the permitted early-request phase).
 *
 * Per B-L / the spec: replacement is permitted only during the auth and tenant
 * resolution phase, never inside a route handler.
 */
export class RequestContextPhaseError extends Error {
  override readonly name = "RequestContextPhaseError" as const;

  constructor(message = "setRequestContext called outside the early-request phase") {
    super(message);
  }
}

/**
 * Thrown when `createRequestContext` receives an invalid input
 * (e.g., empty requestId).
 */
export class RequestContextValidationError extends Error {
  override readonly name = "RequestContextValidationError" as const;
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Invalid RequestContext.${field}: ${reason}`);
    this.field = field;
  }
}
