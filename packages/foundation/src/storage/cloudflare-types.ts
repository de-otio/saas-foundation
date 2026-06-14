/**
 * Local declarations of the Cloudflare R2Bucket interface shape.
 *
 * Foundation does not depend on `@cloudflare/workers-types`. These
 * declarations reproduce only the methods implemented by S3Storage.
 *
 * Streaming contract (resolves S-F13): `body` is the canonical ReadableStream.
 * `arrayBuffer()` and `text()` are buffer-once helpers — they internally
 * consume `body` and cannot be called after `body` has been read, nor can
 * `body` be read after calling either helper.
 */

/**
 * R2 HTTP metadata. Mirrors the [Cloudflare R2 binding API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2httpmetadata)
 * so consumers porting from Workers code can pass the same options unchanged.
 * Each field maps to the equivalent S3 PutObject parameter (`ContentType`,
 * `ContentLanguage`, `ContentDisposition`, `ContentEncoding`, `CacheControl`,
 * `Expires`) in the S3-backed implementation.
 */
export interface R2HttpMetadata {
  readonly contentType?: string;
  readonly contentLanguage?: string;
  readonly contentDisposition?: string;
  readonly contentEncoding?: string;
  readonly cacheControl?: string;
  readonly cacheExpiry?: Date;
}

/**
 * R2Object is returned by `head()` and `put()`. It has no body.
 */
export interface R2Object {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly uploaded: Date;
  readonly httpMetadata?: R2HttpMetadata;
  readonly customMetadata?: Readonly<Record<string, string>>;
}

/**
 * R2ObjectBody is returned by `get()`. It carries the streaming body.
 *
 * Streaming contract:
 * - `body` is the once-consumable ReadableStream.
 * - `arrayBuffer()` reads `body` to completion (invalidates `body`).
 * - `text()` reads `body` to completion (invalidates `body`).
 * - Calling `arrayBuffer()` or `text()` after `body` has been read throws.
 * - Calling `arrayBuffer()` after `text()` (or vice versa) throws.
 */
export interface R2ObjectBody extends R2Object {
  readonly body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface R2ListResult {
  readonly objects: ReadonlyArray<R2Object>;
  readonly truncated: boolean;
  readonly cursor?: string;
}

export interface R2PutOptions {
  readonly httpMetadata?: R2HttpMetadata;
  readonly customMetadata?: Readonly<Record<string, string>>;
}

/**
 * Cloudflare-compat R2Bucket interface.
 */
export interface R2Bucket {
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: R2PutOptions,
  ): Promise<R2Object>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(key: string | ReadonlyArray<string>): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<R2ListResult>;
  head(key: string): Promise<R2Object | null>;
}
