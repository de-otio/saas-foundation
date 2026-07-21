/**
 * Unit test for `sweepExpiredKvEntries` (ws1-kv-port-plan §4.2, F10 / X5).
 *
 * Uses a tiny in-memory fake `SqlExecutor` that models just the sweep DELETE:
 * it deletes rows with a non-null `expires_at` strictly before the injected
 * clock, and NEVER touches `expires_at IS NULL` (durable) rows. Self-contained
 * (no Postgres container needed); the real SQL is exercised by the Postgres
 * contract lane.
 */

import { describe, it, expect } from "vitest";
import { sweepExpiredKvEntries, type SqlExecutor } from "../../src/kv/postgres-kv-store.js";

interface FakeRow {
  key: string;
  expiresAtSeconds: number | null;
}

/** A fake executor that recognises only the sweep DELETE statement. */
function makeFakeExecutor(rows: FakeRow[]): SqlExecutor {
  return {
    query: <R>(text: string, params: readonly unknown[]) => {
      if (!/DELETE FROM kv_entries/.test(text) || !/expires_at IS NOT NULL/.test(text)) {
        throw new Error("unexpected statement in sweep test");
      }
      const cutoff = params[0] as { getTime(): number };
      const cutoffSeconds = Math.floor(cutoff.getTime() / 1000);
      const deleted: FakeRow[] = [];
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i]!;
        // Mirror `expires_at IS NOT NULL AND expires_at < $1` — NULL rows spared.
        if (row.expiresAtSeconds !== null && row.expiresAtSeconds < cutoffSeconds) {
          deleted.push(row);
          rows.splice(i, 1);
        }
      }
      return Promise.resolve({ rows: deleted.map((r) => ({ key: r.key })) as R[] });
    },
  };
}

const NOW_SECONDS = 1_700_000_000;
const now = (): number => NOW_SECONDS * 1000;

describe("sweepExpiredKvEntries", () => {
  it("deletes only rows whose expiry has passed", async () => {
    const rows: FakeRow[] = [
      { key: "expired-1", expiresAtSeconds: NOW_SECONDS - 100 },
      { key: "expired-2", expiresAtSeconds: NOW_SECONDS - 1 },
      { key: "live", expiresAtSeconds: NOW_SECONDS + 100 },
    ];
    const executor = makeFakeExecutor(rows);
    const deleted = await sweepExpiredKvEntries(executor, now);
    expect(deleted).toBe(2);
    expect(rows.map((r) => r.key)).toEqual(["live"]);
  });

  it("NEVER sweeps durable (expires_at IS NULL) rows — F10", async () => {
    const rows: FakeRow[] = [
      { key: "durable-discexposure", expiresAtSeconds: null },
      { key: "durable-agent-session", expiresAtSeconds: null },
      { key: "expired", expiresAtSeconds: NOW_SECONDS - 50 },
    ];
    const executor = makeFakeExecutor(rows);
    const deleted = await sweepExpiredKvEntries(executor, now);
    expect(deleted).toBe(1);
    expect(rows.map((r) => r.key).sort()).toEqual(["durable-agent-session", "durable-discexposure"]);
  });

  it("returns 0 when nothing has expired", async () => {
    const rows: FakeRow[] = [{ key: "live", expiresAtSeconds: NOW_SECONDS + 1 }];
    const executor = makeFakeExecutor(rows);
    expect(await sweepExpiredKvEntries(executor, now)).toBe(0);
  });
});
