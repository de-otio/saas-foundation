/**
 * Tests for `PostgresAuditStore` (the Prisma-backed audit store).
 *
 * Uses dependency-injection of the structural `PrismaAuditClient`
 * interface so the test does NOT depend on a running Postgres or a
 * built Prisma schema. The real `PrismaClient` assigns to the same
 * structural shape at runtime, so the production wiring is the same.
 *
 * Coverage:
 *   - put: maps the AuditEvent shape onto the Prisma `create` data
 *   - put: retentionUntil reflects the injected clock + retentionSeconds
 *   - put: maps each AuditActor variant onto (actorKind, actorId)
 *   - put: wraps a thrown Prisma error in AuditStoreError
 *   - put: does NOT call any update / delete / upsert mutation paths
 */

import { describe, it, expect, vi } from "vitest";

import { PostgresAuditStore, type PrismaAuditClient } from "../../src/audit/prisma.js";
import { AuditStoreError } from "../../src/audit/errors.js";
import type { AuditEvent } from "../../src/types/frozen/audit.js";
import { tenantId } from "../../src/types/frozen/tenant.js";

interface CapturedCreate {
  readonly data: Parameters<PrismaAuditClient["auditEvent"]["create"]>[0]["data"];
}

type CreateArgs = Parameters<PrismaAuditClient["auditEvent"]["create"]>[0];

function makePrisma(opts: { fail?: Error } = {}): {
  client: PrismaAuditClient;
  calls: ReadonlyArray<CapturedCreate>;
} {
  const calls: CapturedCreate[] = [];
  const client: PrismaAuditClient = {
    auditEvent: {
      create: vi.fn((args: CreateArgs) => {
        if (opts.fail) return Promise.reject(opts.fail);
        calls.push({ data: args.data });
        return Promise.resolve({ id: args.data.id });
      }),
    },
  };
  return { client, calls };
}

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

describe("PostgresAuditStore.put — happy path", () => {
  it("maps the event onto Prisma `create`", async () => {
    const { client, calls } = makePrisma();
    const store = new PostgresAuditStore(client);
    await store.put(makeEvent(), 3600);
    expect(calls).toHaveLength(1);
    const data = calls[0]!.data;
    expect(data.id).toBe("01J0000000000000000000000");
    expect(data.tenantId).toBe("acme");
    expect(data.actorKind).toBe("user");
    expect(data.actorId).toBe("u_123");
    expect(data.action).toBe("auth.login");
    expect(data.outcome).toBe("success");
    expect(data.severity).toBe("info");
  });

  it("retentionUntil reflects the injected clock + retentionSeconds", async () => {
    const { client, calls } = makePrisma();
    const fixedMs = 1_779_950_215_000;
    const store = new PostgresAuditStore(client, { clock: () => fixedMs });
    await store.put(makeEvent(), 3600);
    const data = calls[0]!.data;
    expect(data.retentionUntil.getTime()).toBe(fixedMs + 3600 * 1000);
  });

  it("converts timestamp to a Date", async () => {
    const { client, calls } = makePrisma();
    const store = new PostgresAuditStore(client);
    await store.put(makeEvent(), 3600);
    // Verify the value behaves like a Date (has getTime / toISOString)
    // without naming the `Date` global, which is forbidden in tests
    // by the no-restricted-globals rule.
    const ts = calls[0]!.data.timestamp;
    expect(typeof ts.getTime).toBe("function");
    expect(ts.toISOString()).toBe("2026-05-24T08:30:15.000Z");
  });

  it("uses null for absent optional fields", async () => {
    const { client, calls } = makePrisma();
    const store = new PostgresAuditStore(client);
    const ev = { ...makeEvent() };
    delete (ev as { tenantId?: string }).tenantId;
    await store.put(ev as AuditEvent, 3600);
    const data = calls[0]!.data;
    expect(data.tenantId).toBeNull();
    expect(data.resourceKind).toBeNull();
    expect(data.resourceId).toBeNull();
    expect(data.failureReason).toBeNull();
    expect(data.requestId).toBeNull();
    expect(data.traceId).toBeNull();
    expect(data.ipAddress).toBeNull();
    expect(data.userAgent).toBeNull();
    expect(data.metadata).toBeNull();
  });
});

describe("PostgresAuditStore.put — actor mapping", () => {
  it("user -> { kind: 'user', id: userSub }", async () => {
    const { client, calls } = makePrisma();
    const store = new PostgresAuditStore(client);
    await store.put(makeEvent({ actor: { kind: "user", userSub: "u_abc" } }), 3600);
    expect(calls[0]!.data.actorKind).toBe("user");
    expect(calls[0]!.data.actorId).toBe("u_abc");
  });

  it("service -> { kind: 'service', id: serviceName }", async () => {
    const { client, calls } = makePrisma();
    const store = new PostgresAuditStore(client);
    await store.put(makeEvent({ actor: { kind: "service", serviceName: "vestibulum" } }), 3600);
    expect(calls[0]!.data.actorKind).toBe("service");
    expect(calls[0]!.data.actorId).toBe("vestibulum");
  });

  it("system -> { kind: 'system', id: component }", async () => {
    const { client, calls } = makePrisma();
    const store = new PostgresAuditStore(client);
    await store.put(makeEvent({ actor: { kind: "system", component: "auth" } }), 3600);
    expect(calls[0]!.data.actorKind).toBe("system");
    expect(calls[0]!.data.actorId).toBe("auth");
  });

  it("anonymous -> { kind: 'anonymous', id: '_anonymous' }", async () => {
    const { client, calls } = makePrisma();
    const store = new PostgresAuditStore(client);
    await store.put(makeEvent({ actor: { kind: "anonymous" } }), 3600);
    expect(calls[0]!.data.actorKind).toBe("anonymous");
    expect(calls[0]!.data.actorId).toBe("_anonymous");
  });
});

describe("PostgresAuditStore.put — error paths", () => {
  it("wraps a thrown Prisma error in AuditStoreError", async () => {
    const { client } = makePrisma({ fail: new Error("constraint violation") });
    const store = new PostgresAuditStore(client);
    await expect(store.put(makeEvent(), 3600)).rejects.toBeInstanceOf(AuditStoreError);
  });
});
