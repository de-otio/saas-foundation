/**
 * Named error types for the kv module.
 *
 * All errors carry a discriminant `name` field so call sites can use
 * `instanceof` checks or the `name` field for branching.
 */

export class KvNotFoundError extends Error {
  override readonly name = "KvNotFoundError" as const;

  constructor(key: string) {
    super(`KV key not found: ${key}`);
  }
}

export class KvTransientError extends Error {
  override readonly name = "KvTransientError" as const;

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}

export class KvCursorError extends Error {
  override readonly name = "KvCursorError" as const;
}
