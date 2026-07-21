/**
 * DynamoKvStore — the AWS-reference `KvStore` adapter (ws1-kv-port-plan §4.1).
 *
 * A SIBLING of `DynamoKv` (which stays the Cloudflare-compat `KVNamespace`).
 * Single-table, injected `DynamoDBClient`, injected `now` clock. Parameterized
 * by a per-namespace {@link DynamoKvLayout} so it emits the SAME keys/attributes
 * each trellis module writes today (data-at-rest byte-compat) — the only
 * additive delta is the version attribute (`_v`), which self-initialises: a
 * missing `_v` is read as version 0, so no backfill migration is needed.
 *
 * ## Value storage (byte-compat)
 * The record's `value` object is stored as TOP-LEVEL item attributes (matching
 * cost-accumulator's native-N `units`, claims-cache's flat attrs, etc.), NOT a
 * nested blob. `increment` therefore maps to a native DynamoDB `ADD` on a
 * top-level field. `pk`/`sk`/the TTL attr/`_v`/the index attrs are reserved and
 * stripped back off on read.
 *
 * ## Command mapping (§4.1)
 * - `get`               -> GetItem (+ ConsistentRead on `{consistent:true}`, F6)
 * - `put`               -> GetItem (read version) + PutItem (full overwrite)
 * - `putIfAbsent`       -> PutItem `attribute_not_exists(pk)`; on conflict, read
 *                          and (if expired) a version-guarded takeover PutItem
 * - `putIfFresher`      -> single PutItem `attribute_not_exists(#ttl) OR #ttl < :inc`
 * - `compareAndSet`     -> conditional PutItem on `#_v = :expected`
 * - `increment`         -> UpdateItem `ADD #field :d, #_v :one SET #ttl=if_not_exists(...)`
 * - `delete`            -> DeleteItem (+ `#_v = :expected` when guarded)
 * - `queryByIndex`      -> Query on the layout's secondary index
 *
 * `put` is the one non-atomic primitive (read-then-write): it is unconditional
 * (last-writer-wins) so an exact version bump under concurrent puts is not a
 * guarantee any caller relies on. Every other primitive is a single atomic
 * DynamoDB operation, or (putIfAbsent's expired-takeover) an optimistic
 * version-guarded write that fails safe on a race.
 */

import {
  type DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type { KvStore, KvRecord, KvWriteOptions, KvCasResult } from "./store-types.js";
import { KV_FIELD_PATTERN } from "./store-types.js";
import { transientRetry } from "../_internal/retry.js";

export interface DynamoKvLayout {
  readonly tableName: string;
  /** pk value = `${pkPrefix}${pkSeparator}${key}`. `key` MUST NOT contain the separator (F4). */
  readonly pkPrefix: string;
  readonly pkSeparator: ":" | "#";
  /**
   * Opt out of the F4 separator guard for namespaces whose keys are
   * SERVER-CONSTRUCTED composite segments that legitimately contain the
   * separator (`costtrack`/`costbudget`/`discexposure`, whose byte-compat pk is
   * `prefix:{date}:{service}` etc — ws1-kv-port-plan §3.1/§3.3). Leave `false`
   * (the default) for any namespace whose key is user/attacker-influenced
   * (idempotency keys, device codes, JTIs) so a crafted separator cannot shift
   * the composed pk. Never enable for a user-controlled-key namespace.
   */
  readonly allowSeparatorInKey?: boolean;
  /** Sort-key attribute name (usually `"sk"`); omit for pk-only tables (idempotency). */
  readonly skName?: string;
  /** Sort-key constant value (`"v"` | `"meta"` | `"rec"` | `"lock"` | `"idx"`). */
  readonly skValue?: string;
  /** TTL attribute name (`"ttl"` everywhere except idempotency's `"expiresAt"`). */
  readonly ttlAttr: string;
  /** Version attribute name — the one additive at-rest delta (e.g. `"_v"`). */
  readonly versionAttr: string;
  /** Secondary index, when this namespace is indexed (agent-refresh's GSI). */
  readonly index?: { readonly name: string; readonly pkAttr: string; readonly skAttr?: string };
  /**
   * Counter fields stored as top-level native `N` (units/count/failedLookups).
   * Informational for byte-compat review; `marshall` already emits `N` for JS
   * numbers, so this does not change encoding.
   */
  readonly nativeNumberFields?: readonly string[];
}

export interface DynamoKvStoreOptions {
  /** Injected clock, epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

const PARTITION_ATTR = "pk";

function isConditionalCheckFailed(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "ConditionalCheckFailedException"
  );
}

export class DynamoKvStore implements KvStore {
  private readonly now: () => number;
  private readonly reserved: ReadonlySet<string>;

  constructor(
    private readonly client: DynamoDBClient,
    private readonly layout: DynamoKvLayout,
    options: DynamoKvStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    const reserved = new Set<string>([PARTITION_ATTR, layout.ttlAttr, layout.versionAttr]);
    if (layout.skName !== undefined) reserved.add(layout.skName);
    if (layout.index !== undefined) {
      reserved.add(layout.index.pkAttr);
      if (layout.index.skAttr !== undefined) reserved.add(layout.index.skAttr);
    }
    this.reserved = reserved;
  }

  // -------------------------------------------------------------------------
  // Pure helpers
  // -------------------------------------------------------------------------

  private nowSeconds(): number {
    return Math.floor(this.now() / 1000);
  }

  private buildPk(key: string): string {
    if (this.layout.allowSeparatorInKey !== true && key.includes(this.layout.pkSeparator)) {
      // F4: an embedded separator could collide across namespaces. Opt-out only
      // for server-constructed composite-key namespaces (see DynamoKvLayout).
      throw new TypeError(`key contains the reserved pk separator (op=buildPk)`);
    }
    return `${this.layout.pkPrefix}${this.layout.pkSeparator}${key}`;
  }

  private stripPk(pk: string): string {
    const prefix = `${this.layout.pkPrefix}${this.layout.pkSeparator}`;
    return pk.startsWith(prefix) ? pk.slice(prefix.length) : pk;
  }

  private resolveExpiry(opts?: KvWriteOptions): number | undefined {
    if (opts?.expiresAt !== undefined) return opts.expiresAt;
    if (opts?.ttlSeconds !== undefined) return this.nowSeconds() + opts.ttlSeconds;
    return undefined;
  }

  private keyAttr(key: string): Record<string, unknown> {
    const attrs: Record<string, unknown> = { [PARTITION_ATTR]: this.buildPk(key) };
    if (this.layout.skName !== undefined) attrs[this.layout.skName] = this.layout.skValue;
    return attrs;
  }

  /** Assemble the full DynamoDB item (value flattened to top-level attrs). */
  private buildItem(
    key: string,
    value: unknown,
    version: number,
    expiresAt: number | undefined,
    indexedKey: string | undefined,
  ): Record<string, unknown> {
    const valueObj =
      typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    for (const field of Object.keys(valueObj)) {
      if (this.reserved.has(field)) {
        throw new TypeError(`value field collides with a reserved attribute (op=buildItem)`);
      }
    }
    const item: Record<string, unknown> = {
      ...valueObj,
      ...this.keyAttr(key),
      [this.layout.versionAttr]: version,
    };
    if (expiresAt !== undefined) item[this.layout.ttlAttr] = expiresAt;
    if (indexedKey !== undefined && this.layout.index !== undefined) {
      item[this.layout.index.pkAttr] = indexedKey;
      if (this.layout.index.skAttr !== undefined) item[this.layout.index.skAttr] = key;
    }
    return item;
  }

  /** Rebuild the caller-facing value by stripping reserved attributes. */
  private extractValue<T>(item: Record<string, unknown>): T {
    const value: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(item)) {
      if (!this.reserved.has(k)) value[k] = v;
    }
    return value as T;
  }

  private toRecord<T>(item: Record<string, unknown>): KvRecord<T> {
    const version = Number(item[this.layout.versionAttr] ?? 0);
    const ttl = item[this.layout.ttlAttr];
    const expiresAt = typeof ttl === "number" ? ttl : undefined;
    const value = this.extractValue<T>(item);
    return expiresAt !== undefined ? { value, version, expiresAt } : { value, version };
  }

  private isExpiredItem(item: Record<string, unknown>): boolean {
    const ttl = item[this.layout.ttlAttr];
    return typeof ttl === "number" && ttl < this.nowSeconds();
  }

  private put_(item: Record<string, unknown>, condition?: {
    readonly expression: string;
    readonly names: Record<string, string>;
    readonly values?: Record<string, unknown>;
  }): Promise<unknown> {
    return transientRetry.execute(() =>
      this.client.send(
        new PutItemCommand({
          TableName: this.layout.tableName,
          Item: marshall(item, { removeUndefinedValues: true }),
          ...(condition !== undefined && {
            ConditionExpression: condition.expression,
            ExpressionAttributeNames: condition.names,
            ...(condition.values !== undefined && {
              ExpressionAttributeValues: marshall(condition.values, { removeUndefinedValues: true }),
            }),
          }),
        }),
      ),
    );
  }

  /** Raw unmarshalled item (no TTL filter) — used for version accounting. */
  private async getRawItem(
    key: string,
    consistent: boolean,
  ): Promise<Record<string, unknown> | null> {
    const result = await transientRetry.execute(() =>
      this.client.send(
        new GetItemCommand({
          TableName: this.layout.tableName,
          Key: marshall(this.keyAttr(key), { removeUndefinedValues: true }),
          ConsistentRead: consistent,
        }),
      ),
    );
    return result.Item === undefined ? null : unmarshall(result.Item);
  }

  // -------------------------------------------------------------------------
  // get
  // -------------------------------------------------------------------------

  async get<T>(
    key: string,
    opts?: { readonly consistent?: boolean; readonly includeExpired?: boolean },
  ): Promise<KvRecord<T> | null> {
    const item = await this.getRawItem(key, opts?.consistent === true);
    if (item === null) return null;
    // `includeExpired` skips the client-side TTL filter, so an expired-but-unswept
    // item is returned until DynamoDB's own TTL sweep deletes it — byte-identical
    // to the pre-port getActiveTenantPreference read (~48h survival window).
    if (opts?.includeExpired !== true && this.isExpiredItem(item)) return null;
    return this.toRecord<T>(item);
  }

  // -------------------------------------------------------------------------
  // put — unconditional overwrite (read-then-write; version bump not atomic)
  // -------------------------------------------------------------------------

  async put<T>(key: string, value: T, opts?: KvWriteOptions): Promise<KvRecord<T>> {
    const current = await this.getRawItem(key, false);
    const prevVersion = current === null ? 0 : Number(current[this.layout.versionAttr] ?? 0);
    const version = prevVersion + 1;
    const item = this.buildItem(key, value, version, this.resolveExpiry(opts), opts?.indexedKey);
    await this.put_(item);
    return this.toRecord<T>(item);
  }

  // -------------------------------------------------------------------------
  // putIfAbsent — create-once, expired-as-absent (F1)
  // -------------------------------------------------------------------------

  async putIfAbsent<T>(
    key: string,
    value: T,
    opts?: KvWriteOptions & { readonly overwriteExpired?: boolean },
  ): Promise<KvCasResult<T>> {
    const expiresAt = this.resolveExpiry(opts);
    const createItem = this.buildItem(key, value, 1, expiresAt, opts?.indexedKey);
    try {
      await this.put_(createItem, {
        expression: "attribute_not_exists(#pk)",
        names: { "#pk": PARTITION_ATTR },
      });
      return { applied: true, record: this.toRecord<T>(createItem) };
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
    }

    // Row physically exists. Consistent read to classify live vs expired.
    const current = await this.getRawItem(key, true);
    if (current === null) {
      // Vanished between the create and the read — retry the create once.
      return this.putIfAbsent(key, value, opts);
    }
    if (!this.isExpiredItem(current)) {
      return { applied: false, record: this.toRecord<T>(current) };
    }

    // Expired-but-unswept -> takeover, bumping the prior version (lock-token
    // uniqueness) under a version guard so a concurrent takeover can't double-win.
    const prevVersion = Number(current[this.layout.versionAttr] ?? 0);
    const takeoverItem = this.buildItem(key, value, prevVersion + 1, expiresAt, opts?.indexedKey);
    try {
      await this.put_(takeoverItem, {
        expression: "#v = :pv",
        names: { "#v": this.layout.versionAttr },
        values: { ":pv": prevVersion },
      });
      return { applied: true, record: this.toRecord<T>(takeoverItem) };
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
      const winner = await this.getRawItem(key, true);
      return {
        applied: false,
        record: winner !== null && !this.isExpiredItem(winner) ? this.toRecord<T>(winner) : null,
      };
    }
  }

  // -------------------------------------------------------------------------
  // compareAndSet — conditional PutItem on the version attribute
  // -------------------------------------------------------------------------

  async compareAndSet<T>(
    key: string,
    expectedVersion: number,
    value: T,
    opts?: KvWriteOptions,
  ): Promise<KvCasResult<T>> {
    const item = this.buildItem(
      key,
      value,
      expectedVersion + 1,
      this.resolveExpiry(opts),
      opts?.indexedKey,
    );
    const condition =
      expectedVersion === 0
        ? { expression: "attribute_not_exists(#pk)", names: { "#pk": PARTITION_ATTR } }
        : {
            expression: "#v = :ev",
            names: { "#v": this.layout.versionAttr },
            values: { ":ev": expectedVersion },
          };
    try {
      await this.put_(item, condition);
      return { applied: true, record: this.toRecord<T>(item) };
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
      const current = await this.getRawItem(key, true);
      return {
        applied: false,
        record: current !== null && !this.isExpiredItem(current) ? this.toRecord<T>(current) : null,
      };
    }
  }

  // -------------------------------------------------------------------------
  // putIfFresher — single conditional PutItem, TTL-monotonic (F2)
  // -------------------------------------------------------------------------

  async putIfFresher<T>(
    key: string,
    value: T,
    opts: KvWriteOptions & { readonly expiresAt: number },
  ): Promise<KvCasResult<T>> {
    const incoming = opts.expiresAt;
    // version 1: this namespace (claims) is not mixed with version-CAS; the
    // freshness guard is on the expiry attribute, in one atomic write.
    const item = this.buildItem(key, value, 1, incoming, opts.indexedKey);
    try {
      await this.put_(item, {
        expression: "attribute_not_exists(#ttl) OR #ttl < :inc",
        names: { "#ttl": this.layout.ttlAttr },
        values: { ":inc": incoming },
      });
      return { applied: true, record: this.toRecord<T>(item) };
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
      const current = await this.getRawItem(key, true);
      return {
        applied: false,
        record: current !== null && !this.isExpiredItem(current) ? this.toRecord<T>(current) : null,
      };
    }
  }

  // -------------------------------------------------------------------------
  // increment — atomic ADD on a top-level field (+ version), set-once TTL (F3)
  // -------------------------------------------------------------------------

  async increment(
    key: string,
    field: string,
    delta: number,
    opts?: KvWriteOptions,
  ): Promise<number> {
    if (!KV_FIELD_PATTERN.test(field)) {
      throw new TypeError(`increment: invalid field identifier (op=increment)`);
    }
    const expiresAt = this.resolveExpiry(opts);
    const names: Record<string, string> = {
      "#f": field,
      "#v": this.layout.versionAttr,
    };
    const values: Record<string, unknown> = { ":d": delta, ":one": 1 };
    let expression = "ADD #f :d, #v :one";
    if (expiresAt !== undefined) {
      names["#ttl"] = this.layout.ttlAttr;
      values[":ttl"] = expiresAt;
      expression += " SET #ttl = if_not_exists(#ttl, :ttl)";
    }

    const result = await transientRetry.execute(() =>
      this.client.send(
        new UpdateItemCommand({
          TableName: this.layout.tableName,
          Key: marshall(this.keyAttr(key), { removeUndefinedValues: true }),
          UpdateExpression: expression,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: marshall(values, { removeUndefinedValues: true }),
          ReturnValues: "ALL_NEW",
        }),
      ),
    );
    const attrs: Record<string, unknown> =
      result.Attributes === undefined ? {} : unmarshall(result.Attributes);
    return Number(attrs[field] ?? delta);
  }

  // -------------------------------------------------------------------------
  // delete — unconditional or version-guarded
  // -------------------------------------------------------------------------

  async delete(key: string, expectedVersion?: number): Promise<boolean> {
    try {
      const result = await transientRetry.execute(() =>
        this.client.send(
          new DeleteItemCommand({
            TableName: this.layout.tableName,
            Key: marshall(this.keyAttr(key), { removeUndefinedValues: true }),
            ReturnValues: "ALL_OLD",
            ...(expectedVersion !== undefined && {
              ConditionExpression: "#v = :ev",
              ExpressionAttributeNames: { "#v": this.layout.versionAttr },
              ExpressionAttributeValues: marshall(
                { ":ev": expectedVersion },
                { removeUndefinedValues: true },
              ),
            }),
          }),
        ),
      );
      return result.Attributes !== undefined;
    } catch (err) {
      if (isConditionalCheckFailed(err)) return false;
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // queryByIndex — single named secondary-index lookup
  // -------------------------------------------------------------------------

  async queryByIndex<T>(
    indexValue: string,
  ): Promise<ReadonlyArray<KvRecord<T> & { readonly key: string }>> {
    const index = this.layout.index;
    if (index === undefined) {
      throw new TypeError(`queryByIndex called on a namespace with no index (op=queryByIndex)`);
    }
    const result = await transientRetry.execute(() =>
      this.client.send(
        new QueryCommand({
          TableName: this.layout.tableName,
          IndexName: index.name,
          KeyConditionExpression: "#ipk = :v",
          ExpressionAttributeNames: { "#ipk": index.pkAttr },
          ExpressionAttributeValues: marshall({ ":v": indexValue }, { removeUndefinedValues: true }),
        }),
      ),
    );
    const nsPrefix = `${this.layout.pkPrefix}${this.layout.pkSeparator}`;
    const rows: Array<KvRecord<T> & { readonly key: string }> = [];
    for (const raw of result.Items ?? []) {
      const item: Record<string, unknown> = unmarshall(raw);
      if (this.isExpiredItem(item)) continue;
      const pk = item[PARTITION_ATTR];
      // Scope to THIS namespace: a shared GSI can span pk prefixes, but the
      // port contract returns only records "in this namespace" (in production
      // each indexed namespace has its own table, so this is a no-op there).
      if (typeof pk !== "string" || !pk.startsWith(nsPrefix)) continue;
      rows.push({ ...this.toRecord<T>(item), key: this.stripPk(pk) });
    }
    return rows;
  }
}
