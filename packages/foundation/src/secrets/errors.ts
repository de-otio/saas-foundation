/**
 * Named error types for the secrets module.
 *
 * Each subclass carries a discriminant `name` field so call sites can
 * use either `instanceof` checks or `name` switching for branching.
 *
 * Per doc/foundation/03-secrets.md, the error hierarchy distinguishes:
 *   - "the consumer typo'd the ARN / asked for a parameter that doesn't
 *     exist" (NotFound) — recoverable by fixing config
 *   - "the IAM principal lacks permission" (AccessDenied) — recoverable
 *     by fixing IAM
 *   - "the SDK is throttling us / transient infrastructure failure"
 *     (Transient) — recoverable by retry
 *   - "anything else" (the base class)
 */

/**
 * Base class for all secrets-resolution errors. Subclasses preserve the
 * underlying SDK error in `cause` so call sites can re-throw or log
 * with full diagnostic information without losing the chain.
 */
export class SecretsResolveError extends Error {
  override readonly name: string = "SecretsResolveError";
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * The requested secret does not exist (Secrets Manager
 * `ResourceNotFoundException`).
 */
export class SecretsNotFoundError extends SecretsResolveError {
  override readonly name = "SecretsNotFoundError" as const;
}

/**
 * The IAM principal lacks permission to read the secret (Secrets
 * Manager `AccessDeniedException` / `DecryptionFailure` /
 * `UnrecognizedClientException`).
 */
export class SecretsAccessDeniedError extends SecretsResolveError {
  override readonly name = "SecretsAccessDeniedError" as const;
}

/**
 * Transient / retryable failure (throttling, network blip,
 * `InternalServiceError`). Already retried internally; surfaces only
 * after the retry budget is exhausted.
 */
export class SecretsTransientError extends SecretsResolveError {
  override readonly name = "SecretsTransientError" as const;
}

/**
 * SSM-side parallel: the requested parameter does not exist.
 */
export class ParameterNotFoundError extends SecretsResolveError {
  override readonly name = "ParameterNotFoundError" as const;
}

/**
 * SSM-side parallel: the IAM principal lacks permission to read the
 * parameter.
 */
export class ParameterAccessDeniedError extends SecretsResolveError {
  override readonly name = "ParameterAccessDeniedError" as const;
}
