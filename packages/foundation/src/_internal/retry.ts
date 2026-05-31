/**
 * Internal retry policy shared by the cloud-primitive shims (kv, queue, storage).
 *
 * Retries transient (non-terminal) errors only. AWS "not found" responses
 * (NoSuchKey, NotFound) are terminal — they will not succeed on retry — so
 * they are excluded from the retry predicate. Retrying them also causes test
 * hangs when fake timers are active (the exponential backoff never resolves).
 *
 * Consumers who want to customise retry policy depend on cockatiel directly
 * and wrap the shim. This module is intentionally not re-exported from any
 * module barrel.
 */

import { retry, handleWhen, ExponentialBackoff, type RetryPolicy } from "cockatiel";

/** Names of terminal AWS error responses that should never be retried. */
const TERMINAL_ERROR_NAMES = new Set([
  "NoSuchKey",
  "NotFound",
  "ResourceNotFoundException",
  "ConditionalCheckFailedException",
  "AccessDeniedException",
  "InvalidSignatureException",
]);

function isTransientError(err: Error): boolean {
  const name = (err as { name?: string }).name;
  if (name !== undefined && name.length > 0 && TERMINAL_ERROR_NAMES.has(name)) return false;
  return true;
}

export const transientRetry: RetryPolicy = retry(handleWhen(isTransientError), {
  maxAttempts: 3,
  backoff: new ExponentialBackoff({ initialDelay: 100, maxDelay: 2000 }),
});
