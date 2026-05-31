/**
 * Tests for `DynamoAuditStore`.
 *
 * Coverage:
 *   - PutItem happy path: item shape matches the documented schema
 *   - PK encodes tenant or _global
 *   - GSI partition keys are filled (PK1, PK2)
 *   - ttl reflects the injected retentionSeconds + clock
 *   - throws AuditStoreError on SDK failure
 *   - throws on empty tableName at construction
 *
 * H-1 invariant: the source-level grep test in `iam-shape.test.ts`
 * pairs with these to enforce that PutItemCommand is the only mutation
 * command this class issues.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  BatchWriteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { mockClient, type AwsClientStub } from "aws-sdk-client-mock";
import { unmarshall } from "@aws-sdk/util-dynamodb";

import { DynamoAuditStore } from "../../src/audit/dynamo-store.js";
import { AuditStoreError } from "../../src/audit/errors.js";
import type { AuditEvent } from "../../src/types/frozen/audit.js";
import { tenantId } from "../../src/types/frozen/tenant.js";

const TABLE = "test-audit";
const FROZEN_EPOCH_MS = 1_779_611_415_000; // 2026-05-24T08:30:15.000Z
// Pre-computed (FROZEN_EPOCH_MS / 1000) to avoid the in-test
// no-restricted-globals lint on Math.floor.
const FROZEN_EPOCH_S = 1_779_611_415;

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return Object.freeze({
    id: "01J0000000000000000000000",
    timestamp: "2026-05-24T08:30:15.000Z",
    tenantId: tenantId("acme"),
    actor: { kind: "user", userSub: "u_123" },
    action: "auth.login",
    outcome: "success",
    severity: "info",
    ...overrides,
  } as AuditEvent);
}

describe("DynamoAuditStore.put — happy path", () => {
  let mock: AwsClientStub<DynamoDBClient>;
  let client: DynamoDBClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
    mock = mockClient(DynamoDBClient);
    client = new DynamoDBClient({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("issues a PutItemCommand", async () => {
    mock.on(PutItemCommand).resolves({});
    const store = new DynamoAuditStore(client, TABLE);
    await store.put(makeEvent(), 3600);
    expect(mock.commandCalls(PutItemCommand)).toHaveLength(1);
  });

  it("stores the item under PK = AUDIT#<tenant> SK = <ts>#<id>", async () => {
    mock.on(PutItemCommand).resolves({});
    const store = new DynamoAuditStore(client, TABLE);
    await store.put(makeEvent(), 3600);
    const call = mock.commandCalls(PutItemCommand)[0]!;
    const item = unmarshall(call.args[0].input.Item!);
    expect(item["PK"]).toBe("AUDIT#acme");
    expect(item["SK"]).toBe("2026-05-24T08:30:15.000Z#01J0000000000000000000000");
  });

  it("uses _global partition for events without a tenant", async () => {
    mock.on(PutItemCommand).resolves({});
    const store = new DynamoAuditStore(client, TABLE);
    const ev = { ...makeEvent() };
    delete (ev as { tenantId?: string }).tenantId;
    await store.put(ev as AuditEvent, 3600);
    const call = mock.commandCalls(PutItemCommand)[0]!;
    const item = unmarshall(call.args[0].input.Item!);
    expect(item["PK"]).toBe("AUDIT#_global");
    expect(item["PK2"]).toBe("ACTION#_global#auth.login");
  });

  it("fills the GSI1-actor partition key (user)", async () => {
    mock.on(PutItemCommand).resolves({});
    const store = new DynamoAuditStore(client, TABLE);
    await store.put(makeEvent(), 3600);
    const call = mock.commandCalls(PutItemCommand)[0]!;
    const item = unmarshall(call.args[0].input.Item!);
    expect(item["PK1"]).toBe("ACTOR#user#u_123");
    expect(item["SK1"]).toBe("2026-05-24T08:30:15.000Z");
  });

  it("fills the GSI1-actor partition key (system)", async () => {
    mock.on(PutItemCommand).resolves({});
    const store = new DynamoAuditStore(client, TABLE);
    await store.put(makeEvent({ actor: { kind: "system", component: "auth" } }), 3600);
    const call = mock.commandCalls(PutItemCommand)[0]!;
    const item = unmarshall(call.args[0].input.Item!);
    expect(item["PK1"]).toBe("ACTOR#system#auth");
  });

  it("fills the GSI1-actor partition key (anonymous)", async () => {
    mock.on(PutItemCommand).resolves({});
    const store = new DynamoAuditStore(client, TABLE);
    await store.put(makeEvent({ actor: { kind: "anonymous" } }), 3600);
    const call = mock.commandCalls(PutItemCommand)[0]!;
    const item = unmarshall(call.args[0].input.Item!);
    expect(item["PK1"]).toBe("ACTOR#anonymous#_anonymous");
  });

  it("fills the GSI1-actor partition key (service)", async () => {
    mock.on(PutItemCommand).resolves({});
    const store = new DynamoAuditStore(client, TABLE);
    await store.put(makeEvent({ actor: { kind: "service", serviceName: "vestibulum" } }), 3600);
    const call = mock.commandCalls(PutItemCommand)[0]!;
    const item = unmarshall(call.args[0].input.Item!);
    expect(item["PK1"]).toBe("ACTOR#service#vestibulum");
  });

  it("stores ttl as epoch seconds based on the injected clock + retentionSeconds", async () => {
    mock.on(PutItemCommand).resolves({});
    const store = new DynamoAuditStore(client, TABLE);
    await store.put(makeEvent(), 1800);
    const call = mock.commandCalls(PutItemCommand)[0]!;
    const item = unmarshall(call.args[0].input.Item!);
    expect(item["ttl"]).toBe(FROZEN_EPOCH_S + 1800);
  });

  it("stores the full event JSON-encoded", async () => {
    mock.on(PutItemCommand).resolves({});
    const store = new DynamoAuditStore(client, TABLE);
    const ev = makeEvent();
    await store.put(ev, 3600);
    const call = mock.commandCalls(PutItemCommand)[0]!;
    const item = unmarshall(call.args[0].input.Item!);
    const decoded = JSON.parse(item["event"] as string) as unknown;
    expect(decoded).toEqual(ev);
  });
});

describe("DynamoAuditStore.put — H-1 IAM shape (runtime check)", () => {
  let mock: AwsClientStub<DynamoDBClient>;
  let client: DynamoDBClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
    mock = mockClient(DynamoDBClient);
    client = new DynamoDBClient({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("issues NO UpdateItemCommand calls", async () => {
    mock.on(PutItemCommand).resolves({});
    const store = new DynamoAuditStore(client, TABLE);
    await store.put(makeEvent(), 3600);
    await store.put(makeEvent(), 3600);
    expect(mock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it("issues NO DeleteItemCommand calls", async () => {
    mock.on(PutItemCommand).resolves({});
    const store = new DynamoAuditStore(client, TABLE);
    await store.put(makeEvent(), 3600);
    expect(mock.commandCalls(DeleteItemCommand)).toHaveLength(0);
  });

  it("issues NO BatchWriteItemCommand calls", async () => {
    mock.on(PutItemCommand).resolves({});
    const store = new DynamoAuditStore(client, TABLE);
    await store.put(makeEvent(), 3600);
    expect(mock.commandCalls(BatchWriteItemCommand)).toHaveLength(0);
  });
});

describe("DynamoAuditStore.put — error paths", () => {
  let mock: AwsClientStub<DynamoDBClient>;
  let client: DynamoDBClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_EPOCH_MS);
    mock = mockClient(DynamoDBClient);
    client = new DynamoDBClient({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("wraps a thrown SDK error in AuditStoreError", async () => {
    // Use a TERMINAL error name so the transient-retry policy doesn't
    // schedule retries on the fake timer (which would hang the test).
    const err = new Error("denied");
    err.name = "AccessDeniedException";
    mock.on(PutItemCommand).rejects(err);
    const store = new DynamoAuditStore(client, TABLE);
    await expect(store.put(makeEvent(), 3600)).rejects.toBeInstanceOf(AuditStoreError);
  });
});

describe("DynamoAuditStore — construction", () => {
  it("throws on empty tableName", () => {
    expect(() => new DynamoAuditStore(new DynamoDBClient({}), "")).toThrow();
  });
});
