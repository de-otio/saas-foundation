/**
 * DynamoKv — Cloudflare KVNamespace interface backed by DynamoDB.
 *
 * Single-table pattern: one DynamoDB table, partition key `pk`, sort key `sk`
 * (constant `"v"`). Each DynamoKv instance is a _namespace_ — a prefix applied
 * to `pk`.
 *
 * Cursor signing is opt-in. When `cursorSecret` is provided, `list()` returns
 * HMAC-SHA256-signed cursors so clients cannot forge ExclusiveStartKey values.
 *
 * TTL semantics: items that have passed their TTL but DynamoDB has not yet
 * deleted return `null` from `get()`. Correct for rate-limit use cases.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import * as crypto from "node:crypto";
import type { KVNamespace, KvPutOptions, KvListOptions, KvListResult } from "./cloudflare-types.js";
import { CursorKeySchema } from "./schemas.js";
import { transientRetry } from "../_internal/retry.js";

export interface KvNamespaceOptions {
  readonly tableName: string;
  readonly namespace: string;
  /**
   * Optional shared-secret for HMAC-SHA256 cursor signing. When set, `list()`
   * returns signed cursors so clients cannot forge ExclusiveStartKey values.
   * Omit for purely internal pagination where cursor forgery is not a concern.
   */
  readonly cursorSecret?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers — no side effects, no I/O
// ---------------------------------------------------------------------------

/** Build the DynamoDB partition key from namespace and key. */
function buildPk(namespace: string, key: string): string {
  return `${namespace}:${key}`;
}

/** Strip the namespace prefix from a pk to recover the bare key name. */
function stripPrefix(namespace: string, pk: string): string {
  const prefix = `${namespace}:`;
  return pk.startsWith(prefix) ? pk.slice(prefix.length) : pk;
}

/** HMAC-sign a base64-encoded cursor payload. */
function signCursor(payload: string, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${hmac}`;
}

/**
 * Verify a signed cursor and return the raw payload.
 * Returns the unmodified string if no secret is set (pass-through).
 */
function verifyCursorSignature(cursor: string, secret: string): string | null {
  const dotIdx = cursor.lastIndexOf(".");
  if (dotIdx === -1) return null; // no signature — reject

  const payload = cursor.substring(0, dotIdx);
  const sig = cursor.substring(dotIdx + 1);

  // A valid hex HMAC-SHA256 is exactly 64 hex chars
  if (sig.length !== 64) return null;

  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const sigBuf = Buffer.from(sig, "hex");
  const expectedBuf = Buffer.from(expected, "hex");

  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  return payload;
}

/**
 * Parse and validate a pagination cursor into a DynamoDB ExclusiveStartKey.
 * Returns `undefined` on any structural violation (safe-fail: restart from
 * the beginning rather than throw).
 */
function parseCursor(
  raw: string,
  cursorSecret: string | undefined,
): Record<string, unknown> | undefined {
  try {
    let payload: string;

    if (cursorSecret !== undefined) {
      const verified = verifyCursorSignature(raw, cursorSecret);
      if (verified === null) return undefined; // tampered — restart
      payload = verified;
    } else {
      payload = raw;
    }

    const decoded = Buffer.from(payload, "base64").toString("utf-8");
    const parsed: unknown = JSON.parse(decoded);
    const result = CursorKeySchema.safeParse(parsed);
    if (!result.success) return undefined;

    return result.data;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// DynamoKv class
// ---------------------------------------------------------------------------

export class DynamoKv implements KVNamespace {
  constructor(
    private readonly client: DynamoDBClient,
    private readonly options: KvNamespaceOptions,
  ) {}

  // -------------------------------------------------------------------------
  // get
  // -------------------------------------------------------------------------

  get(key: string, type?: "text"): Promise<string | null>;
  get<T = unknown>(key: string, type: "json"): Promise<T | null>;
  async get<T = unknown>(
    key: string,
    type?: "text" | "json",
  ): Promise<string | T | null> {
    const resolvedType = type ?? "text";

    const result = await transientRetry.execute(() =>
      this.client.send(
        new GetItemCommand({
          TableName: this.options.tableName,
          Key: marshall({ pk: buildPk(this.options.namespace, key), sk: "v" }),
        }),
      ),
    );

    if (!result.Item) return null;

    const item = unmarshall(result.Item);

    // Filter items that DynamoDB has not yet expired (best-effort TTL)
    const ttl = item["ttl"] as number | undefined;
    if (ttl !== undefined && ttl < Math.floor(Date.now() / 1000)) return null;

    const raw = item["value"] as string;

    if (resolvedType === "json") {
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    }

    return raw;
  }

  // -------------------------------------------------------------------------
  // getWithMetadata
  // -------------------------------------------------------------------------

  async getWithMetadata<T>(
    key: string,
  ): Promise<{ readonly value: string | null; readonly metadata: T | null }> {
    const result = await transientRetry.execute(() =>
      this.client.send(
        new GetItemCommand({
          TableName: this.options.tableName,
          Key: marshall({ pk: buildPk(this.options.namespace, key), sk: "v" }),
        }),
      ),
    );

    if (!result.Item) return { value: null, metadata: null };

    const item = unmarshall(result.Item);

    const ttl = item["ttl"] as number | undefined;
    if (ttl !== undefined && ttl < Math.floor(Date.now() / 1000)) {
      return { value: null, metadata: null };
    }

    const value = (item["value"] as string | undefined) ?? null;
    const rawMeta = item["metadata"] as string | undefined;
    const metadata: T | null = rawMeta !== undefined ? (JSON.parse(rawMeta) as T) : null;

    return { value, metadata };
  }

  // -------------------------------------------------------------------------
  // put
  // -------------------------------------------------------------------------

  async put(key: string, value: string | ArrayBuffer, options?: KvPutOptions): Promise<void> {
    const strValue = typeof value === "string" ? value : Buffer.from(value).toString("utf-8");

    let ttl: number | undefined;
    if (options?.expiration !== undefined) {
      ttl = options.expiration;
    } else if (options?.expirationTtl !== undefined) {
      ttl = Math.floor(Date.now() / 1000) + options.expirationTtl;
    }

    const record: Record<string, unknown> = {
      pk: buildPk(this.options.namespace, key),
      sk: "v",
      value: strValue,
    };
    if (ttl !== undefined) record["ttl"] = ttl;
    if (options?.metadata !== undefined) record["metadata"] = JSON.stringify(options.metadata);

    await transientRetry.execute(() =>
      this.client.send(
        new PutItemCommand({
          TableName: this.options.tableName,
          Item: marshall(record),
        }),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  async delete(key: string): Promise<void> {
    await transientRetry.execute(() =>
      this.client.send(
        new DeleteItemCommand({
          TableName: this.options.tableName,
          Key: marshall({ pk: buildPk(this.options.namespace, key), sk: "v" }),
        }),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  async list(options?: KvListOptions): Promise<KvListResult> {
    const ns = this.options.namespace;
    const prefix = options?.prefix !== undefined ? `${ns}:${options.prefix}` : `${ns}:`;

    let exclusiveStartKey: Record<string, unknown> | undefined;
    if (options?.cursor !== undefined) {
      exclusiveStartKey = parseCursor(options.cursor, this.options.cursorSecret);
    }

    const result = await transientRetry.execute(() =>
      this.client.send(
        new QueryCommand({
          TableName: this.options.tableName,
          KeyConditionExpression: "begins_with(pk, :prefix)",
          ExpressionAttributeValues: marshall({ ":prefix": prefix }),
          Limit: options?.limit ?? 1000,
          // parseCursor returns the decoded ExclusiveStartKey from a previous
          // LastEvaluatedKey. The SDK shape is Record<string, AttributeValue>.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ExclusiveStartKey: exclusiveStartKey as Record<string, any> | undefined,
        }),
      ),
    );

    const now = Math.floor(Date.now() / 1000);
    const keys = (result.Items ?? [])
      .map((item) => unmarshall(item))
      .filter((item) => {
        const ttl = item["ttl"] as number | undefined;
        return ttl === undefined || ttl > now;
      })
      .map((item) => {
        const expiration = item["ttl"] as number | undefined;
        return expiration !== undefined
          ? { name: stripPrefix(ns, item["pk"] as string), expiration }
          : { name: stripPrefix(ns, item["pk"] as string) };
      });

    let cursor: string | undefined;
    if (result.LastEvaluatedKey !== undefined) {
      const encoded = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString("base64");
      cursor =
        this.options.cursorSecret !== undefined
          ? signCursor(encoded, this.options.cursorSecret)
          : encoded;
    }

    return {
      keys,
      list_complete: result.LastEvaluatedKey === undefined,
      ...(cursor !== undefined && { cursor }),
    };
  }
}
