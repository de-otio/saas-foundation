/**
 * Named error types for the queue module.
 */

export class QueueSendError extends Error {
  override readonly name = "QueueSendError" as const;

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}

export class QueueBatchError extends Error {
  override readonly name = "QueueBatchError" as const;

  /**
   * IDs of messages that failed in a batch send. May be partial — some
   * messages in the batch may have succeeded.
   */
  constructor(
    message: string,
    public readonly failedIds: ReadonlyArray<string>,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}
