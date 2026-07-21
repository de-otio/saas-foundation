/**
 * PostgresKvStore lane of the shared KvStore adapter-contract suite, run against
 * a real Postgres (ws1-kv-port-plan §6.1.2, F11).
 *
 * This lane exercises REAL row-lock atomicity (the memory lane simulates it):
 * the N=10 increment-sum and N=5 read->CAS single-winner cases actually run
 * concurrently against Postgres here.
 *
 * Connection: `KV_TEST_DATABASE_URL` or `DATABASE_URL`
 * (default `postgres://test:test@localhost:5433/kvtest`). When Postgres is
 * unreachable the whole lane is SKIPPED (not failed) so the pure memory-lane run
 * stays green without Docker — CI provides the container (WS-1 T12). Start it
 * locally with:
 *   docker run -d --name kv-pg -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test \
 *     -e POSTGRES_DB=kvtest -p 5433:5432 postgis/postgis:16-3.4
 */

import { beforeAll, afterAll } from "vitest";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresKvStore, type SqlExecutor } from "../../src/kv/postgres-kv-store.js";
import type { KvStore } from "../../src/kv/store-types.js";
import { runKvStoreContract, type AdapterUnderTest } from "./store-contract.js";

const CONNECTION_STRING =
  process.env["KV_TEST_DATABASE_URL"] ??
  process.env["DATABASE_URL"] ??
  "postgres://test:test@localhost:5433/kvtest";

function probe(url: string, timeoutMs = 750): Promise<boolean> {
  let hostname: string;
  let port: number;
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname;
    port = Number(parsed.port === "" ? "5432" : parsed.port);
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const sock = net.connect({ host: hostname, port });
    const done = (ok: boolean): void => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

const DDL = `
  CREATE TABLE IF NOT EXISTS kv_entries (
    namespace   text        NOT NULL,
    key         text        NOT NULL,
    value       jsonb       NOT NULL,
    version     bigint      NOT NULL DEFAULT 1,
    expires_at  timestamptz,
    indexed_key text,
    PRIMARY KEY (namespace, key)
  );
  CREATE INDEX IF NOT EXISTS kv_entries_namespace_indexed_key_idx
    ON kv_entries (namespace, indexed_key);
  CREATE INDEX IF NOT EXISTS kv_entries_expires_at_idx
    ON kv_entries (expires_at);
`;

const reachable = await probe(CONNECTION_STRING);

if (!reachable) {
  const { describe, it } = await import("vitest");
  describe.skip("PostgresKvStore contract (Postgres unavailable)", () => {
    it("skipped — start a Postgres container to run this lane", () => {
      /* skipped */
    });
  });
} else {
  const pool = new Pool({ connectionString: CONNECTION_STRING, max: 12 });
  const executor: SqlExecutor = {
    query: <R = Record<string, unknown>>(text: string, params: readonly unknown[]) =>
      pool.query(text, params as unknown[]) as Promise<{ rows: R[] }>,
  };

  beforeAll(async () => {
    await pool.query(DDL, []);
  });

  afterAll(async () => {
    await pool.end();
  });

  const postgresAdapter: AdapterUnderTest = {
    name: "PostgresKvStore",
    // fast-check runs are lighter here — each run makes real DB round-trips.
    propertyRuns: 15,
    make: (now: () => number): Promise<KvStore> => {
      // Fresh namespace per store for isolation on the shared table.
      const namespace = `ct-${randomUUID().slice(0, 8)}`;
      return Promise.resolve(new PostgresKvStore(executor, { namespace, now }));
    },
  };

  runKvStoreContract(postgresAdapter);
}
