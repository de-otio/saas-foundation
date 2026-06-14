/**
 * `@de-otio/saas-foundation/queue` — SQS-backed Queue shim.
 *
 * Primary exports:
 * - `SqsQueue` — Cloudflare Queue interface over SQS (producer-only).
 * - `Queue` — the Cloudflare-compat interface type.
 * - Error types: `QueueSendError`, `QueueBatchError`.
 * - Client factory: `createDefaultSqsClient`.
 */

export { SqsQueue } from "./sqs-queue.js";

export type { Queue, QueueSendOptions, QueueBatchEntry } from "./cloudflare-types.js";

export { QueueSendError, QueueBatchError } from "./errors.js";

export { createDefaultSqsClient } from "./clients.js";

export { SQS_MAX_BATCH_SIZE } from "./schemas.js";
