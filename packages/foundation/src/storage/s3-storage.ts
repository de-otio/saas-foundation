/**
 * S3Storage — Cloudflare R2Bucket interface backed by S3.
 *
 * Streaming contract (resolves S-F13):
 *   `body` is the once-consumable ReadableStream (canonical path).
 *   `arrayBuffer()` and `text()` are buffer-once helpers that internally read
 *   `body` to completion via `new Response(body)`. Calling either helper
 *   invalidates `body`; calling both throws `StorageBodyConsumedError`.
 *
 * Presigned upload URLs use `@aws-sdk/s3-request-presigner` and enforce
 * Content-Type at signing time.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  R2Bucket,
  R2Object,
  R2ObjectBody,
  R2PutOptions,
  R2ListResult,
} from "./cloudflare-types.js";
import { StorageBodyConsumedError } from "./errors.js";
import { transientRetry } from "../_internal/retry.js";

export class S3Storage implements R2Bucket {
  constructor(
    private readonly client: S3Client,
    private readonly bucketName: string,
  ) {}

  // -------------------------------------------------------------------------
  // put
  // -------------------------------------------------------------------------

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: R2PutOptions,
  ): Promise<R2Object> {
    let body: Buffer | string | ReadableStream | undefined;
    let size = 0;

    if (typeof value === "string") {
      body = value;
      size = Buffer.byteLength(value, "utf-8");
    } else if (value instanceof ArrayBuffer) {
      body = Buffer.from(value);
      size = value.byteLength;
    } else if (ArrayBuffer.isView(value)) {
      body = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      size = value.byteLength;
    } else if (value !== null) {
      // ReadableStream — pass through; size not known at put time
      body = value;
    }

    const result = await transientRetry.execute(() =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          ...(body !== undefined && { Body: body }),
          ...(options?.httpMetadata?.contentType !== undefined && {
            ContentType: options.httpMetadata.contentType,
          }),
          ...(options?.httpMetadata?.contentLanguage !== undefined && {
            ContentLanguage: options.httpMetadata.contentLanguage,
          }),
          ...(options?.httpMetadata?.contentDisposition !== undefined && {
            ContentDisposition: options.httpMetadata.contentDisposition,
          }),
          ...(options?.httpMetadata?.contentEncoding !== undefined && {
            ContentEncoding: options.httpMetadata.contentEncoding,
          }),
          ...(options?.httpMetadata?.cacheControl !== undefined && {
            CacheControl: options.httpMetadata.cacheControl,
          }),
          ...(options?.httpMetadata?.cacheExpiry !== undefined && {
            Expires: options.httpMetadata.cacheExpiry,
          }),
          ...(options?.customMetadata !== undefined && {
            Metadata: options.customMetadata,
          }),
        }),
      ),
    );

    return {
      key,
      size,
      etag: result.ETag ?? "",
      uploaded: new Date(),
      ...(options?.httpMetadata !== undefined && { httpMetadata: options.httpMetadata }),
      ...(options?.customMetadata !== undefined && { customMetadata: options.customMetadata }),
    };
  }

  // -------------------------------------------------------------------------
  // get
  // -------------------------------------------------------------------------

  async get(key: string): Promise<R2ObjectBody | null> {
    let result;
    try {
      result = await transientRetry.execute(() =>
        this.client.send(new GetObjectCommand({ Bucket: this.bucketName, Key: key })),
      );
    } catch (err) {
      if (isNoSuchKeyError(err)) return null;
      throw err;
    }

    if (result.Body === undefined) return null;

    // The web-stream is the single source. arrayBuffer() / text() are
    // implemented by reading this stream once. The `consumed` flag enforces
    // the buffer-once contract.
    const body = result.Body.transformToWebStream() as ReadableStream<Uint8Array>;
    let consumed = false;

    const r2body: R2ObjectBody = {
      key,
      size: result.ContentLength ?? 0,
      etag: result.ETag ?? "",
      uploaded: result.LastModified ?? new Date(),
      httpMetadata: s3ResultToHttpMetadata(result),
      ...(result.Metadata !== undefined && { customMetadata: result.Metadata }),
      body,
      arrayBuffer: async (): Promise<ArrayBuffer> => {
        if (consumed) throw new StorageBodyConsumedError();
        consumed = true;
        return new Response(body).arrayBuffer();
      },
      text: async (): Promise<string> => {
        if (consumed) throw new StorageBodyConsumedError();
        consumed = true;
        return new Response(body).text();
      },
    };

    return r2body;
  }

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  async delete(key: string | ReadonlyArray<string>): Promise<void> {
    const keys = Array.isArray(key) ? key : [key];
    await Promise.all(
      (keys as string[]).map((k) =>
        transientRetry.execute(() =>
          this.client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: k })),
        ),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  async list(options?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<R2ListResult> {
    const result = await transientRetry.execute(() =>
      this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: options?.prefix,
          MaxKeys: options?.limit ?? 1000,
          ContinuationToken: options?.cursor,
        }),
      ),
    );

    return {
      objects: (result.Contents ?? []).map((obj) => ({
        key: obj.Key ?? "",
        size: obj.Size ?? 0,
        etag: obj.ETag ?? "",
        uploaded: obj.LastModified ?? new Date(),
      })),
      truncated: result.IsTruncated ?? false,
      ...(result.NextContinuationToken !== undefined && {
        cursor: result.NextContinuationToken,
      }),
    };
  }

  // -------------------------------------------------------------------------
  // head
  // -------------------------------------------------------------------------

  async head(key: string): Promise<R2Object | null> {
    let result;
    try {
      result = await transientRetry.execute(() =>
        this.client.send(new HeadObjectCommand({ Bucket: this.bucketName, Key: key })),
      );
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }

    return {
      key,
      size: result.ContentLength ?? 0,
      etag: result.ETag ?? "",
      uploaded: result.LastModified ?? new Date(),
      httpMetadata: s3ResultToHttpMetadata(result),
      ...(result.Metadata !== undefined && { customMetadata: result.Metadata }),
    };
  }

  // -------------------------------------------------------------------------
  // getPresignedUploadUrl (extension beyond R2Bucket)
  // -------------------------------------------------------------------------

  /**
   * Generate a presigned PUT URL for direct client uploads.
   *
   * `contentType` is enforced at signing time — the client must upload with a
   * matching `Content-Type` header or S3 rejects the request.
   */
  async getPresignedUploadUrl(
    key: string,
    contentType: string,
    expiresInSeconds = 60,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: expiresInSeconds },
    );
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Map S3 GetObject/HeadObject response fields into the R2HttpMetadata shape
 * (Cloudflare's R2 binding API). Single source of truth so `get()` and
 * `head()` cannot drift.
 */
function s3ResultToHttpMetadata(result: {
  ContentType?: string | undefined;
  ContentLanguage?: string | undefined;
  ContentDisposition?: string | undefined;
  ContentEncoding?: string | undefined;
  CacheControl?: string | undefined;
  Expires?: Date | undefined;
}) {
  return {
    ...(result.ContentType !== undefined && { contentType: result.ContentType }),
    ...(result.ContentLanguage !== undefined && { contentLanguage: result.ContentLanguage }),
    ...(result.ContentDisposition !== undefined && {
      contentDisposition: result.ContentDisposition,
    }),
    ...(result.ContentEncoding !== undefined && { contentEncoding: result.ContentEncoding }),
    ...(result.CacheControl !== undefined && { cacheControl: result.CacheControl }),
    ...(result.Expires !== undefined && { cacheExpiry: result.Expires }),
  };
}

function isNoSuchKeyError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  const code = (err as { Code?: unknown }).Code;
  return name === "NoSuchKey" || code === "NoSuchKey";
}

function isNotFoundError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === "NotFound" || name === "NoSuchKey";
}
