/**
 * Named error types for the storage module.
 */

export class StorageNotFoundError extends Error {
  override readonly name = "StorageNotFoundError" as const;

  constructor(key: string) {
    super(`Storage key not found: ${key}`);
  }
}

export class StorageTransientError extends Error {
  override readonly name = "StorageTransientError" as const;

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}

export class StorageBodyConsumedError extends Error {
  override readonly name = "StorageBodyConsumedError" as const;

  constructor() {
    super("R2ObjectBody.body already consumed — cannot read again");
  }
}
