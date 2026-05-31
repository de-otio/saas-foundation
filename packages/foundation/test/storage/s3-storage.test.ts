/**
 * Unit tests for S3Storage.
 *
 * Uses `aws-sdk-client-mock` to mock the S3 SDK client at the SDK boundary.
 * No real network calls.
 *
 * Streaming contract (S-F13):
 * - `body` is the once-consumable ReadableStream.
 * - `arrayBuffer()` and `text()` are buffer-once helpers; calling both throws.
 *
 * Time: all tests use vi.useFakeTimers() to avoid accessing the real Date global
 * (per doc/02-monorepo-layout.md § Determinism rules).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { mockClient, type AwsClientStub } from "aws-sdk-client-mock";
import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { sdkStreamMixin } from "@smithy/util-stream";
import { Readable } from "node:stream";
import { S3Storage } from "../../src/storage/s3-storage.js";
import { StorageBodyConsumedError } from "../../src/storage/errors.js";

/** Deterministic frozen epoch: 2023-11-14T22:13:20Z */
const FROZEN_EPOCH_MS = 1_700_000_000_000;

const BUCKET = "test-bucket";

function makeStorage(): S3Storage {
  const client = new S3Client({});
  return new S3Storage(client, BUCKET);
}

/** Build a Node.js Readable stream with the SDK stream mixin applied. */
function makeBodyStream(content: string): ReturnType<typeof sdkStreamMixin> {
  const readable = new Readable({
    read() {
      this.push(content);
      this.push(null);
    },
  });
  return sdkStreamMixin(readable);
}

/** Frozen Date instance passed to SDK mock responses (avoids `new Date(...)` in tests). */
// eslint-disable-next-line no-restricted-globals
function frozenDate(): Date {
  // vi.useFakeTimers() is active; this constructor call produces the frozen time.
  return new globalThis.Date(FROZEN_EPOCH_MS);
}

// ---------------------------------------------------------------------------
// put
// ---------------------------------------------------------------------------

describe("S3Storage.put", () => {
  let mock: AwsClientStub<S3Client>;
  let storage: S3Storage;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
    mock = mockClient(S3Client);
    storage = makeStorage();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("puts a string value and returns R2Object", async () => {
    mock.on(PutObjectCommand).resolves({ ETag: '"abc123"' });
    const obj = await storage.put("file.txt", "hello world");

    expect(obj.key).toBe("file.txt");
    expect(obj.etag).toBe('"abc123"');
    expect(obj.uploaded).toBeInstanceOf(globalThis.Date);

    const calls = mock.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.Bucket).toBe(BUCKET);
    expect(calls[0]!.args[0].input.Key).toBe("file.txt");
  });

  it("puts an ArrayBuffer", async () => {
    mock.on(PutObjectCommand).resolves({ ETag: '"def"' });
    // Use TextEncoder to produce a clean 5-byte ArrayBuffer.
    // Buffer.from("bytes").buffer returns the Node.js pool (8192 bytes).
    const buf = new TextEncoder().encode("bytes").buffer;
    const obj = await storage.put("file.bin", buf);
    expect(obj.size).toBe(5);
  });

  it("puts an ArrayBufferView (Uint8Array)", async () => {
    mock.on(PutObjectCommand).resolves({});
    const view = new Uint8Array([1, 2, 3]);
    await storage.put("view.bin", view);
    const calls = mock.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(1);
  });

  it("passes ContentType from httpMetadata", async () => {
    mock.on(PutObjectCommand).resolves({});
    await storage.put("img.png", "data", { httpMetadata: { contentType: "image/png" } });
    const input = mock.commandCalls(PutObjectCommand)[0]!.args[0].input;
    expect(input.ContentType).toBe("image/png");
  });

  it("passes the full Cloudflare R2HttpMetadata surface to S3", async () => {
    mock.on(PutObjectCommand).resolves({});
    const expires = frozenDate();
    await storage.put("doc.txt", "data", {
      httpMetadata: {
        contentType: "text/plain",
        contentLanguage: "en-US",
        contentDisposition: 'attachment; filename="doc.txt"',
        contentEncoding: "gzip",
        cacheControl: "public, max-age=3600",
        cacheExpiry: expires,
      },
    });
    const input = mock.commandCalls(PutObjectCommand)[0]!.args[0].input;
    expect(input.ContentType).toBe("text/plain");
    expect(input.ContentLanguage).toBe("en-US");
    expect(input.ContentDisposition).toBe('attachment; filename="doc.txt"');
    expect(input.ContentEncoding).toBe("gzip");
    expect(input.CacheControl).toBe("public, max-age=3600");
    expect(input.Expires).toEqual(expires);
  });

  it("passes custom metadata", async () => {
    mock.on(PutObjectCommand).resolves({});
    await storage.put("f", "v", { customMetadata: { tag: "release" } });
    const input = mock.commandCalls(PutObjectCommand)[0]!.args[0].input;
    expect(input.Metadata).toEqual({ tag: "release" });
  });

  it("handles null value (empty body)", async () => {
    mock.on(PutObjectCommand).resolves({});
    await expect(storage.put("empty.txt", null)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe("S3Storage.get", () => {
  let mock: AwsClientStub<S3Client>;
  let storage: S3Storage;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
    mock = mockClient(S3Client);
    storage = makeStorage();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null on NoSuchKey", async () => {
    const err = Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
    mock.on(GetObjectCommand).rejects(err);
    expect(await storage.get("missing.txt")).toBeNull();
  });

  it("returns R2ObjectBody for existing object", async () => {
    mock.on(GetObjectCommand).resolves({
      Body: makeBodyStream("content"),
      ContentLength: 7,
      ETag: '"etag1"',
      LastModified: frozenDate(),
      ContentType: "text/plain",
      Metadata: { env: "prod" },
    });
    const obj = await storage.get("file.txt");
    expect(obj).not.toBeNull();
    expect(obj!.key).toBe("file.txt");
    expect(obj!.size).toBe(7);
    expect(obj!.etag).toBe('"etag1"');
    expect(obj!.httpMetadata?.contentType).toBe("text/plain");
    expect(obj!.customMetadata).toEqual({ env: "prod" });
  });

  it("maps the full Cloudflare R2HttpMetadata surface back from S3 response", async () => {
    const expires = frozenDate();
    mock.on(GetObjectCommand).resolves({
      Body: makeBodyStream("x"),
      ContentLength: 1,
      ETag: '"x"',
      ContentType: "application/pdf",
      ContentLanguage: "fr-CA",
      ContentDisposition: 'attachment; filename="rapport.pdf"',
      ContentEncoding: "br",
      CacheControl: "private, no-store",
      Expires: expires,
    });
    const obj = await storage.get("rapport.pdf");
    expect(obj!.httpMetadata).toEqual({
      contentType: "application/pdf",
      contentLanguage: "fr-CA",
      contentDisposition: 'attachment; filename="rapport.pdf"',
      contentEncoding: "br",
      cacheControl: "private, no-store",
      cacheExpiry: expires,
    });
  });

  it("text() helper reads body as text (streaming contract)", async () => {
    mock.on(GetObjectCommand).resolves({
      Body: makeBodyStream("hello"),
      ContentLength: 5,
      ETag: '"x"',
    });
    const obj = await storage.get("file.txt");
    expect(obj).not.toBeNull();
    const text = await obj!.text();
    expect(text).toBe("hello");
  });

  it("arrayBuffer() helper reads body as ArrayBuffer", async () => {
    mock.on(GetObjectCommand).resolves({
      Body: makeBodyStream("abc"),
      ContentLength: 3,
      ETag: '"y"',
    });
    const obj = await storage.get("file.txt");
    expect(obj).not.toBeNull();
    const ab = await obj!.arrayBuffer();
    expect(ab.byteLength).toBe(3);
    expect(Buffer.from(ab).toString()).toBe("abc");
  });

  it("calling text() then arrayBuffer() throws StorageBodyConsumedError", async () => {
    mock.on(GetObjectCommand).resolves({
      Body: makeBodyStream("data"),
      ContentLength: 4,
      ETag: '"z"',
    });
    const obj = await storage.get("file.txt");
    expect(obj).not.toBeNull();
    await obj!.text(); // consumes the stream
    await expect(obj!.arrayBuffer()).rejects.toThrow(StorageBodyConsumedError);
  });

  it("calling arrayBuffer() twice throws StorageBodyConsumedError", async () => {
    mock.on(GetObjectCommand).resolves({
      Body: makeBodyStream("data"),
      ContentLength: 4,
      ETag: '"z"',
    });
    const obj = await storage.get("file.txt");
    await obj!.arrayBuffer();
    await expect(obj!.arrayBuffer()).rejects.toThrow(StorageBodyConsumedError);
  });

  it("body is a ReadableStream", async () => {
    mock.on(GetObjectCommand).resolves({
      Body: makeBodyStream("stream-test"),
      ContentLength: 11,
      ETag: '"s"',
    });
    const obj = await storage.get("file.txt");
    expect(obj).not.toBeNull();
    expect(obj!.body).toBeInstanceOf(ReadableStream);
  });

  it("returns null when Body is undefined", async () => {
    mock.on(GetObjectCommand).resolves({ Body: undefined });
    expect(await storage.get("file.txt")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("S3Storage.delete", () => {
  let mock: AwsClientStub<S3Client>;
  let storage: S3Storage;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
    mock = mockClient(S3Client);
    storage = makeStorage();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("deletes a single key", async () => {
    mock.on(DeleteObjectCommand).resolves({});
    await storage.delete("file.txt");
    expect(mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
    expect(mock.commandCalls(DeleteObjectCommand)[0]!.args[0].input.Key).toBe("file.txt");
  });

  it("deletes an array of keys", async () => {
    mock.on(DeleteObjectCommand).resolves({});
    await storage.delete(["a.txt", "b.txt", "c.txt"]);
    expect(mock.commandCalls(DeleteObjectCommand)).toHaveLength(3);
    const keys = mock.commandCalls(DeleteObjectCommand).map((c) => c.args[0].input.Key);
    expect(keys).toContain("a.txt");
    expect(keys).toContain("b.txt");
    expect(keys).toContain("c.txt");
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("S3Storage.list", () => {
  let mock: AwsClientStub<S3Client>;
  let storage: S3Storage;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
    mock = mockClient(S3Client);
    storage = makeStorage();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty list when bucket is empty", async () => {
    mock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false });
    const result = await storage.list();
    expect(result.objects).toHaveLength(0);
    expect(result.truncated).toBe(false);
    expect(result.cursor).toBeUndefined();
  });

  it("returns object metadata for each item", async () => {
    mock.on(ListObjectsV2Command).resolves({
      Contents: [
        { Key: "a.txt", Size: 100, ETag: '"etag-a"', LastModified: frozenDate() },
        { Key: "b.txt", Size: 200, ETag: '"etag-b"', LastModified: frozenDate() },
      ],
      IsTruncated: false,
    });
    const result = await storage.list();
    expect(result.objects).toHaveLength(2);
    expect(result.objects[0]!.key).toBe("a.txt");
    expect(result.objects[1]!.size).toBe(200);
  });

  it("returns cursor when truncated", async () => {
    mock.on(ListObjectsV2Command).resolves({
      Contents: [],
      IsTruncated: true,
      NextContinuationToken: "token-abc",
    });
    const result = await storage.list();
    expect(result.truncated).toBe(true);
    expect(result.cursor).toBe("token-abc");
  });

  it("passes prefix and limit to S3", async () => {
    mock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false });
    await storage.list({ prefix: "uploads/", limit: 50 });
    const input = mock.commandCalls(ListObjectsV2Command)[0]!.args[0].input;
    expect(input.Prefix).toBe("uploads/");
    expect(input.MaxKeys).toBe(50);
  });

  it("passes continuation token when cursor is provided", async () => {
    mock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false });
    await storage.list({ cursor: "token-xyz" });
    const input = mock.commandCalls(ListObjectsV2Command)[0]!.args[0].input;
    expect(input.ContinuationToken).toBe("token-xyz");
  });
});

// ---------------------------------------------------------------------------
// head
// ---------------------------------------------------------------------------

describe("S3Storage.head", () => {
  let mock: AwsClientStub<S3Client>;
  let storage: S3Storage;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
    mock = mockClient(S3Client);
    storage = makeStorage();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null on NotFound", async () => {
    const err = Object.assign(new Error("NotFound"), { name: "NotFound" });
    mock.on(HeadObjectCommand).rejects(err);
    expect(await storage.head("missing.txt")).toBeNull();
  });

  it("returns R2Object metadata for existing object", async () => {
    mock.on(HeadObjectCommand).resolves({
      ContentLength: 42,
      ETag: '"etag-head"',
      LastModified: frozenDate(),
      ContentType: "application/octet-stream",
      Metadata: { owner: "alice" },
    });
    const obj = await storage.head("file.bin");
    expect(obj).not.toBeNull();
    expect(obj!.key).toBe("file.bin");
    expect(obj!.size).toBe(42);
    expect(obj!.etag).toBe('"etag-head"');
    expect(obj!.httpMetadata?.contentType).toBe("application/octet-stream");
    expect(obj!.customMetadata).toEqual({ owner: "alice" });
  });
});

// ---------------------------------------------------------------------------
// getPresignedUploadUrl
// ---------------------------------------------------------------------------

describe("S3Storage.getPresignedUploadUrl", () => {
  it("is a method on the class", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
    const storage = makeStorage();
    // aws-sdk-client-mock does not intercept presigner calls; verify the
    // method exists and has the expected signature.
    expect(typeof storage.getPresignedUploadUrl).toBe("function");
    vi.useRealTimers();
  });
});
