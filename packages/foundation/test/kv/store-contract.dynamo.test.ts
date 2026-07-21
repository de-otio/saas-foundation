/**
 * DynamoKvStore lane of the shared KvStore adapter-contract suite, run against
 * `amazon/dynamodb-local` (ws1-kv-port-plan §6.1.2, F11).
 *
 * This lane exercises REAL row-lock atomicity (the memory lane simulates it):
 * the N=10 increment-sum and N=5 read->CAS single-winner cases actually run
 * concurrently against DynamoDB here.
 *
 * Endpoint: `DYNAMODB_ENDPOINT` (default `http://localhost:8000`). When the
 * container is unreachable the whole lane is SKIPPED (not failed) so the pure
 * memory-lane run stays green without Docker — CI provides the container
 * (WS-1 T12). Start it locally with:
 *   docker run -d --name kv-dynamodb-local -p 8000:8000 \
 *     amazon/dynamodb-local:latest -jar DynamoDBLocal.jar -sharedDb -inMemory
 */

import { beforeAll } from "vitest";
import net from "node:net";
import { randomUUID } from "node:crypto";
import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
} from "@aws-sdk/client-dynamodb";
import { DynamoKvStore, type DynamoKvLayout } from "../../src/kv/dynamo-kv-store.js";
import type { KvStore } from "../../src/kv/store-types.js";
import { runKvStoreContract, type AdapterUnderTest } from "./store-contract.js";

const ENDPOINT = process.env["DYNAMODB_ENDPOINT"] ?? "http://localhost:8000";
const TABLE = "kv-contract-test";
const GSI = "gsi1";
const GSI_PK = "gsi1pk";

function probe(url: string, timeoutMs = 750): Promise<boolean> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const sock = net.connect({ host: hostname, port: Number(port) });
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

function makeClient(): DynamoDBClient {
  return new DynamoDBClient({
    endpoint: ENDPOINT,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}

async function ensureTable(client: DynamoDBClient): Promise<void> {
  try {
    await client.send(new DescribeTableCommand({ TableName: TABLE }));
    return; // already exists
  } catch {
    // fall through to create
  }
  await client.send(
    new CreateTableCommand({
      TableName: TABLE,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
        { AttributeName: GSI_PK, AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: GSI,
          KeySchema: [{ AttributeName: GSI_PK, KeyType: "HASH" }],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    }),
  );
}

const reachable = await probe(ENDPOINT);

if (!reachable) {
  const { describe, it } = await import("vitest");
  describe.skip("DynamoKvStore contract (dynamodb-local unavailable)", () => {
    it("skipped — start amazon/dynamodb-local to run this lane", () => {
      /* skipped */
    });
  });
} else {
  const client = makeClient();

  beforeAll(async () => {
    await ensureTable(client);
  });

  const dynamoAdapter: AdapterUnderTest = {
    name: "DynamoKvStore",
    // fast-check runs are lighter here — each run makes real network calls.
    propertyRuns: 15,
    make: (now: () => number, opts?: { readonly indexed?: boolean }): Promise<KvStore> => {
      // Fresh namespace per store for isolation on the shared table.
      const layout: DynamoKvLayout = {
        tableName: TABLE,
        pkPrefix: `ct-${randomUUID().slice(0, 8)}`,
        pkSeparator: ":",
        skName: "sk",
        skValue: "v",
        ttlAttr: "ttl",
        versionAttr: "_v",
        ...(opts?.indexed === true && {
          index: { name: GSI, pkAttr: GSI_PK },
        }),
      };
      return Promise.resolve(new DynamoKvStore(client, layout, { now }));
    },
  };

  runKvStoreContract(dynamoAdapter);
}
