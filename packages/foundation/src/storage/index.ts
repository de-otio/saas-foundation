/**
 * `@de-otio/saas-foundation/storage` — S3-backed R2Bucket shim.
 *
 * Primary exports:
 * - `S3Storage` — Cloudflare R2Bucket interface over S3 + presigned URLs.
 * - `R2Bucket` — the Cloudflare-compat interface type.
 * - Error types: `StorageNotFoundError`, `StorageTransientError`, `StorageBodyConsumedError`.
 * - Client factory: `createDefaultS3Client`.
 */

export { S3Storage } from "./s3-storage.js";

export type {
  R2Bucket,
  R2Object,
  R2ObjectBody,
  R2PutOptions,
  R2ListResult,
  R2HttpMetadata,
} from "./cloudflare-types.js";

export { StorageNotFoundError, StorageTransientError, StorageBodyConsumedError } from "./errors.js";

export { createDefaultS3Client } from "./clients.js";
