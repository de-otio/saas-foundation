/**
 * `MemorySecretStore` tests.
 *
 * These drive the REAL `resolveSecret` / `resolveParameter` through the
 * in-memory client doubles — no `aws-sdk-client-mock`, no `vi.mock`.
 * The point of Path A is that the production resolve/cache/error path
 * is exercised end-to-end; only the network boundary is swapped.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SecretCache } from "../../src/secrets/cache.js";
import {
  ParameterNotFoundError,
  SecretsNotFoundError,
} from "../../src/secrets/errors.js";
import { MemorySecretStore } from "../../src/secrets/memory-secret-store.js";
import {
  _resetDefaultCacheForTests,
  resolveParameter,
  resolveSecret,
} from "../../src/secrets/resolve.js";
import type { ResolveContext } from "../../src/secrets/resolve.js";
import { secretRef } from "../../src/types/frozen/secrets.js";

const TEST_ARN = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:my-secret-abcdef";
const TEST_PARAM = "/myapp/dev/some-param";

let store: MemorySecretStore;

/** Fresh, frozen-clock cache per call so cases don't share cache state. */
function makeContext(cache?: SecretCache): ResolveContext {
  return {
    secretsClient: store.secretsClient,
    ssmClient: store.ssmClient,
    cache: cache ?? new SecretCache({ clock: () => 0 }),
  };
}

beforeEach(() => {
  store = new MemorySecretStore();
  _resetDefaultCacheForTests();
});

afterEach(() => {
  _resetDefaultCacheForTests();
});

describe("resolveSecret via MemorySecretStore", () => {
  it("returns a seeded secret value through the real resolver", async () => {
    store.setSecret(TEST_ARN, { value: "hunter2" });
    const out = await resolveSecret(secretRef(TEST_ARN), makeContext());
    expect(out.toString("utf-8")).toBe("hunter2");
  });

  it("throws SecretsNotFoundError for an unseeded ARN", async () => {
    await expect(resolveSecret(secretRef(TEST_ARN), makeContext())).rejects.toBeInstanceOf(
      SecretsNotFoundError,
    );
  });

  it("resolves the pinned version when version-pinned", async () => {
    const v1 = "00000000-0000-0000-0000-000000000001";
    const v2 = "00000000-0000-0000-0000-000000000002";
    store.setSecret(TEST_ARN, { value: "old", versionId: v1 });
    // Seeding v2 also makes it the current value.
    store.setSecret(TEST_ARN, { value: "new", versionId: v2 });

    const pinnedOld = await resolveSecret(secretRef(TEST_ARN, v1), makeContext());
    const pinnedNew = await resolveSecret(secretRef(TEST_ARN, v2), makeContext());
    const current = await resolveSecret(secretRef(TEST_ARN), makeContext());

    expect(pinnedOld.toString("utf-8")).toBe("old");
    expect(pinnedNew.toString("utf-8")).toBe("new");
    expect(current.toString("utf-8")).toBe("new");
  });

  it("throws SecretsNotFoundError when a different version is requested than seeded", async () => {
    store.setSecret(TEST_ARN, { value: "v", versionId: "aaaa-1111" });
    await expect(
      resolveSecret(secretRef(TEST_ARN, "bbbb-2222"), makeContext()),
    ).rejects.toBeInstanceOf(SecretsNotFoundError);
  });

  it("is cached by the resolver on the second call (one observed call)", async () => {
    store.setSecret(TEST_ARN, { value: "cached" });
    const ctx = makeContext();
    const ref = secretRef(TEST_ARN);
    const a = await resolveSecret(ref, ctx);
    const b = await resolveSecret(ref, ctx);
    expect(a.toString("utf-8")).toBe("cached");
    expect(b.toString("utf-8")).toBe("cached");
    // The resolver short-circuits on the cache, so the double saw one call.
    expect(store.calls("secret", TEST_ARN)).toBe(1);
  });
});

describe("resolveParameter via MemorySecretStore", () => {
  it("returns a seeded String parameter", async () => {
    store.setParameter(TEST_PARAM, { value: "plain", type: "String" });
    const out = await resolveParameter(TEST_PARAM, makeContext());
    expect(out.toString("utf-8")).toBe("plain");
  });

  it("returns a seeded SecureString parameter (decryption honored)", async () => {
    store.setParameter(TEST_PARAM, { value: "s3cret", type: "SecureString" });
    // resolveParameter requests decryption by default.
    const out = await resolveParameter(TEST_PARAM, makeContext());
    expect(out.toString("utf-8")).toBe("s3cret");
  });

  it("throws ParameterNotFoundError for an unseeded name", async () => {
    await expect(resolveParameter(TEST_PARAM, makeContext())).rejects.toBeInstanceOf(
      ParameterNotFoundError,
    );
  });

  it("is cached by the resolver on the second call", async () => {
    store.setParameter(TEST_PARAM, { value: "p" });
    const ctx = makeContext();
    await resolveParameter(TEST_PARAM, ctx);
    await resolveParameter(TEST_PARAM, ctx);
    expect(store.calls("parameter", TEST_PARAM)).toBe(1);
  });
});

describe("calls() and clear()", () => {
  it("counts each uncached resolve call", async () => {
    store.setSecret(TEST_ARN, { value: "v" });
    // Fresh cache each time -> each resolve hits the double.
    await resolveSecret(secretRef(TEST_ARN), makeContext());
    await resolveSecret(secretRef(TEST_ARN), makeContext());
    expect(store.calls("secret", TEST_ARN)).toBe(2);
  });

  it("counts a missing-secret lookup as a call", async () => {
    await expect(resolveSecret(secretRef(TEST_ARN), makeContext())).rejects.toBeInstanceOf(
      SecretsNotFoundError,
    );
    expect(store.calls("secret", TEST_ARN)).toBe(1);
  });

  it("returns 0 for a key never looked up", () => {
    expect(store.calls("secret", TEST_ARN)).toBe(0);
    expect(store.calls("parameter", TEST_PARAM)).toBe(0);
  });

  it("clear() resets seeds and counts", async () => {
    store.setSecret(TEST_ARN, { value: "v" });
    store.setParameter(TEST_PARAM, { value: "p" });
    await resolveSecret(secretRef(TEST_ARN), makeContext());
    await resolveParameter(TEST_PARAM, makeContext());
    expect(store.calls("secret", TEST_ARN)).toBe(1);
    expect(store.calls("parameter", TEST_PARAM)).toBe(1);

    store.clear();

    expect(store.calls("secret", TEST_ARN)).toBe(0);
    expect(store.calls("parameter", TEST_PARAM)).toBe(0);
    // Seeds gone -> lookups now miss.
    await expect(resolveSecret(secretRef(TEST_ARN), makeContext())).rejects.toBeInstanceOf(
      SecretsNotFoundError,
    );
    await expect(resolveParameter(TEST_PARAM, makeContext())).rejects.toBeInstanceOf(
      ParameterNotFoundError,
    );
  });
});

describe("instance isolation", () => {
  it("two stores do not share seeds or counters", async () => {
    const other = new MemorySecretStore();
    store.setSecret(TEST_ARN, { value: "from-store" });

    const out = await resolveSecret(secretRef(TEST_ARN), makeContext());
    expect(out.toString("utf-8")).toBe("from-store");

    // `other` was never seeded with this ARN.
    const otherCtx: ResolveContext = {
      secretsClient: other.secretsClient,
      ssmClient: other.ssmClient,
      cache: new SecretCache({ clock: () => 0 }),
    };
    await expect(resolveSecret(secretRef(TEST_ARN), otherCtx)).rejects.toBeInstanceOf(
      SecretsNotFoundError,
    );
    expect(other.calls("secret", TEST_ARN)).toBe(1);
    expect(store.calls("secret", TEST_ARN)).toBe(1);
  });
});
