/**
 * MemoryKvStore lane of the shared KvStore adapter-contract suite.
 *
 * Fast, deterministic, single-threaded — the default unit-test mock. The
 * real-concurrency cases here are simulated; the DynamoDB/Postgres lanes run
 * them against a real backend (security F11).
 */

import { MemoryKvStore } from "../../src/kv/memory-kv-store.js";
import type { KvStore } from "../../src/kv/store-types.js";
import { runKvStoreContract, type AdapterUnderTest } from "./store-contract.js";

const memoryAdapter: AdapterUnderTest = {
  name: "MemoryKvStore",
  make: (now: () => number): Promise<KvStore> => Promise.resolve(new MemoryKvStore({ now })),
};

runKvStoreContract(memoryAdapter);
