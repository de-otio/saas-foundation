/**
 * Local declarations of the Cloudflare Queue interface shape.
 *
 * Foundation does not depend on `@cloudflare/workers-types`. These
 * declarations reproduce only the producer-side methods. The consumer side
 * (Workers `queue` handler, Lambda SQS trigger) is outside this shim's scope.
 */

export interface QueueSendOptions {
  readonly delaySeconds?: number;
}

export interface QueueBatchEntry<T> {
  readonly body: T;
  readonly delaySeconds?: number;
}

/**
 * Cloudflare-compat producer-only Queue interface.
 */
export interface Queue<T = unknown> {
  send(message: T, options?: QueueSendOptions): Promise<void>;
  sendBatch(messages: ReadonlyArray<QueueBatchEntry<T>>): Promise<void>;
}
