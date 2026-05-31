/**
 * SqsQueue — Cloudflare Queue interface backed by SQS.
 *
 * Producer-only. The consumer side runs as a Lambda trigger or a Bun SQS
 * poller — foundation does not own the consumer.
 *
 * Serialisation is JSON. Binary messages or alternative encodings are the
 * consumer's responsibility.
 *
 * Batch sends chunk to the SQS maximum of 10 entries per API call. If SQS
 * returns a partial-failure result, a `QueueBatchError` is thrown with the
 * failed message IDs.
 */

import { SQSClient, SendMessageCommand, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import type { Queue, QueueBatchEntry, QueueSendOptions } from "./cloudflare-types.js";
import { QueueBatchError, QueueSendError } from "./errors.js";
import { SQS_MAX_BATCH_SIZE } from "./schemas.js";
import { transientRetry } from "../_internal/retry.js";

export class SqsQueue<T = unknown> implements Queue<T> {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async send(message: T, options?: QueueSendOptions): Promise<void> {
    try {
      await transientRetry.execute(() => {
        const input: { QueueUrl: string; MessageBody: string; DelaySeconds?: number } = {
          QueueUrl: this.queueUrl,
          MessageBody: JSON.stringify(message),
        };
        if (options?.delaySeconds !== undefined) {
          input.DelaySeconds = options.delaySeconds;
        }
        return this.client.send(new SendMessageCommand(input));
      });
    } catch (err) {
      throw new QueueSendError(`SQS send failed: ${String(err)}`, err);
    }
  }

  async sendBatch(messages: ReadonlyArray<QueueBatchEntry<T>>): Promise<void> {
    if (messages.length === 0) return;

    // Chunk into SQS_MAX_BATCH_SIZE slices
    for (let offset = 0; offset < messages.length; offset += SQS_MAX_BATCH_SIZE) {
      const chunk = messages.slice(offset, offset + SQS_MAX_BATCH_SIZE);

      const entries = chunk.map((msg, localIdx) => {
        const entry: {
          Id: string;
          MessageBody: string;
          DelaySeconds?: number;
        } = {
          Id: String(offset + localIdx),
          MessageBody: JSON.stringify(msg.body),
        };
        if (msg.delaySeconds !== undefined) {
          entry.DelaySeconds = msg.delaySeconds;
        }
        return entry;
      });

      const result = await transientRetry.execute(() =>
        this.client.send(
          new SendMessageBatchCommand({
            QueueUrl: this.queueUrl,
            Entries: entries,
          }),
        ),
      );

      const failed = result.Failed ?? [];
      if (failed.length > 0) {
        const failedIds = failed.map((f) => f.Id ?? "<unknown>");
        throw new QueueBatchError(`SQS batch send had ${failed.length} failure(s)`, failedIds);
      }
    }
  }
}
