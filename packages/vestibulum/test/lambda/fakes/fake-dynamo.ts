/**
 * In-memory DynamoDB fake with real conditional-write semantics.
 *
 * Why not `aws-sdk-client-mock` call stubs: a stub returns whatever the test
 * told it to, so a handler that reorders its reads and deletes still "passes".
 * This fake holds state, so tests can assert what is *left in the table* after
 * a flow (e.g. a token is not burned by a failed comparison).
 *
 * Supported commands: GetItem, PutItem, DeleteItem (ALL_OLD), UpdateItem is
 * NOT supported on purpose — the counters are covered by their own tests.
 * Supported conditions: `attribute_exists(<key>)` and
 * `attribute_not_exists(<key>)` only. Anything else throws, so an unsupported
 * expression can never silently pass.
 *
 * Each operation yields to the event loop first, so `Promise.all` callers
 * genuinely interleave.
 */

import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";

type Row = Record<string, AttributeValue>;
type Command = GetItemCommand | PutItemCommand | DeleteItemCommand;

export interface FakeDynamoOptions {
  /** Table name → name of its partition-key attribute. */
  readonly keys: Readonly<Record<string, string>>;
  /** Inject a failure for a command; return an Error to throw it. */
  readonly fault?: (commandName: string, tableName: string) => Error | undefined;
}

export class FakeDynamo {
  private readonly tables = new Map<string, Map<string, Row>>();
  /** Command names in call order, e.g. `GetItem:tokens`. */
  readonly calls: string[] = [];

  constructor(private readonly options: FakeDynamoOptions) {
    for (const table of Object.keys(options.keys)) this.tables.set(table, new Map());
  }

  /** Seed or overwrite a row directly (test setup). */
  seed(table: string, row: Row): void {
    this.table(table).set(this.pk(table, row), row);
  }

  /** Current row for a partition-key value, or undefined. */
  peek(table: string, keyValue: string): Row | undefined {
    return this.table(table).get(keyValue);
  }

  count(table: string): number {
    return this.table(table).size;
  }

  async send(command: Command): Promise<Record<string, unknown>> {
    await Promise.resolve();
    const name = command.constructor.name.replace(/Command$/, "");
    const input = command.input as {
      TableName?: string;
      Key?: Row;
      Item?: Row;
      ConditionExpression?: string;
      ReturnValues?: string;
    };
    const tableName = input.TableName ?? "";
    this.calls.push(`${name}:${tableName}`);
    const fault = this.options.fault?.(name, tableName);
    if (fault !== undefined) throw fault;

    const table = this.table(tableName);
    const keyAttr = this.keyAttr(tableName);

    if (command instanceof GetItemCommand) {
      const key = this.keyValue(input.Key, keyAttr);
      const item = table.get(key);
      return item === undefined ? {} : { Item: item };
    }

    if (command instanceof PutItemCommand) {
      const item = input.Item ?? {};
      const key = this.keyValue(item, keyAttr);
      this.checkCondition(input.ConditionExpression, keyAttr, table.has(key));
      table.set(key, item);
      return {};
    }

    const key = this.keyValue(input.Key, keyAttr);
    const existing = table.get(key);
    this.checkCondition(input.ConditionExpression, keyAttr, existing !== undefined);
    table.delete(key);
    return input.ReturnValues === "ALL_OLD" && existing !== undefined
      ? { Attributes: existing }
      : {};
  }

  private table(name: string): Map<string, Row> {
    const table = this.tables.get(name);
    if (table === undefined) throw new Error(`FakeDynamo: unknown table ${name}`);
    return table;
  }

  private keyAttr(tableName: string): string {
    const attr = this.options.keys[tableName];
    if (attr === undefined) throw new Error(`FakeDynamo: no key configured for ${tableName}`);
    return attr;
  }

  private pk(table: string, row: Row): string {
    return this.keyValue(row, this.keyAttr(table));
  }

  private keyValue(row: Row | undefined, keyAttr: string): string {
    const value = row?.[keyAttr]?.S;
    if (value === undefined) throw new Error(`FakeDynamo: missing key attribute ${keyAttr}`);
    return value;
  }

  private checkCondition(expr: string | undefined, keyAttr: string, exists: boolean): void {
    if (expr === undefined) return;
    const trimmed = expr.trim();
    if (trimmed === `attribute_exists(${keyAttr})`) {
      if (!exists) throw conditionFailed();
      return;
    }
    if (trimmed === `attribute_not_exists(${keyAttr})`) {
      if (exists) throw conditionFailed();
      return;
    }
    throw new Error(`FakeDynamo: unsupported ConditionExpression: ${expr}`);
  }
}

function conditionFailed(): ConditionalCheckFailedException {
  return new ConditionalCheckFailedException({
    message: "The conditional request failed",
    $metadata: {},
  });
}
