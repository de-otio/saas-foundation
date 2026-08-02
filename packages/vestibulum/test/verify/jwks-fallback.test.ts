/**
 * [JWKS-FALLBACK] Tests for the bounded stale-JWKS fallback.
 *
 * These are auth-path tests, so the negatives are the point. Everything runs
 * against the REAL `aws-jwt-verify` verification path with REAL RSA keys and a
 * REAL `SimpleJwksCache`; only the HTTPS fetch is stubbed (`fetchJwks`), so no
 * network call is ever made and no live IdP is contacted.
 *
 * Covered:
 *   - fetch succeeds → cache written, verifier uses the FRESH keys
 *   - fetch fails, fresh cache → verification succeeds from cache + warning
 *   - fetch fails, cache older than 7 days → rejected, verification fails
 *   - fetch fails, poisoned cache (garbage / non-JWKS JSON / mangled key /
 *     wrong issuer / wrong jwksUri / future timestamp) → cache miss, no crash
 *   - no store injected → `JwtVerifier.create` is called with ONE argument
 *     (byte-identical to the pre-[JWKS-FALLBACK] path) and the store is never touched
 *   - a successful fetch always beats a present cache
 *   - the kid-rotation refetch path still works with the fallback installed
 *
 * The clock is injected (`now: () => FIXED_EPOCH_MS`) rather than read from the
 * `Date` global, per the monorepo determinism rule.
 */

import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync, KeyObject, sign as cryptoSign } from "node:crypto";
import { JwtVerifier } from "aws-jwt-verify";
import { FetchError } from "aws-jwt-verify/error";

import { createIssuerVerifier } from "../../src/verify/issuer-verifier.js";
import {
  JWKS_FALLBACK_DEFAULT_MAX_STALENESS_SECONDS,
  buildJwksEnvelope,
  readCachedJwks,
  type JwksCacheStore,
  type JwksFallbackLogger,
} from "../../src/verify/jwks-fallback.js";

/* --------------------------------------------------------------- *
 * Pinned clock — 2030-01-01T00:00:00Z                              *
 * --------------------------------------------------------------- */
const FIXED_EPOCH_S = 1893456000;
const FIXED_EPOCH_MS = FIXED_EPOCH_S * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const ISSUER = "https://id.example.com/realms/trellis";
const AUDIENCE = "client-abc";
const JWKS_URI = "https://id.example.com/realms/trellis/protocol/openid-connect/certs";

/* --------------------------------------------------------------- *
 * base64url + key material + signing                               *
 * --------------------------------------------------------------- */
function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface KeyMat {
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function makeRsaKey(kid: string): KeyMat {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const j = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  return { privateKey, jwk: { kty: "RSA", use: "sig", alg: "RS256", kid, n: j.n, e: j.e } };
}

function sign(key: KeyMat, extra: Record<string, unknown> = {}): string {
  const header = { alg: "RS256", typ: "JWT", kid: key.jwk.kid as string };
  const payload: Record<string, unknown> = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "opaque-subject-123",
    iat: FIXED_EPOCH_S,
    exp: FIXED_EPOCH_S + 3600,
    preferred_username: "test-user",
    ...extra,
  };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = cryptoSign("RSA-SHA256", Buffer.from(input), key.privateKey);
  return `${input}.${b64url(sig)}`;
}

function jwksOf(...keys: KeyMat[]): { keys: Record<string, unknown>[] } {
  return { keys: keys.map((k) => k.jwk) };
}

function toBytes(value: unknown): ArrayBuffer {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  const u8 = new TextEncoder().encode(s);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

/* --------------------------------------------------------------- *
 * Test doubles                                                     *
 * --------------------------------------------------------------- */
class MemoryStore implements JwksCacheStore {
  public readonly entries = new Map<string, { value: string; ttlSeconds: number }>();
  public readonly getCalls: string[] = [];
  public readonly setCalls: { issuer: string; ttlSeconds: number }[] = [];
  public failGet = false;
  public failSet = false;

  async get(issuer: string): Promise<string | null> {
    this.getCalls.push(issuer);
    if (this.failGet) throw new Error("store unavailable");
    return this.entries.get(issuer)?.value ?? null;
  }

  async set(issuer: string, jwks: string, ttlSeconds: number): Promise<void> {
    this.setCalls.push({ issuer, ttlSeconds });
    if (this.failSet) throw new Error("store unavailable");
    this.entries.set(issuer, { value: jwks, ttlSeconds });
  }

  /** Seed a raw (possibly poisoned) value, bypassing `set`. */
  seedRaw(issuer: string, value: string): void {
    this.entries.set(issuer, { value, ttlSeconds: 0 });
  }
}

function makeLogger(): JwksFallbackLogger & {
  calls: { message: string; context: Record<string, unknown> }[];
} {
  const calls: { message: string; context: Record<string, unknown> }[] = [];
  return {
    calls,
    warn(message, context) {
      calls.push({ message, context: { ...context } });
    },
  };
}

/** A `fetchJwks` stub whose behaviour is scripted per call. */
function scriptedFetch(steps: (() => Promise<ArrayBuffer>)[]): {
  fn: (uri: string) => Promise<ArrayBuffer>;
  count: () => number;
} {
  let i = 0;
  return {
    count: () => i,
    fn: async () => {
      const step = steps[Math.min(i, steps.length - 1)];
      i += 1;
      if (step === undefined) throw new Error("no scripted fetch step");
      return step();
    },
  };
}

const ok = (jwks: unknown) => async (): Promise<ArrayBuffer> => toBytes(jwks);
/**
 * The failure the real `SimpleFetcher` raises when the IdP is unreachable —
 * `aws-jwt-verify` wraps every transport error (and any non-200) in a
 * `FetchError`, which `toIssuerError` maps to `invalid_signature`.
 */
const boom =
  (msg = "ECONNREFUSED id.example.com:443") =>
  async (): Promise<ArrayBuffer> => {
    throw new FetchError(JWKS_URI, msg);
  };

const baseConfig = {
  issuer: ISSUER,
  audience: AUDIENCE,
  jwksUri: JWKS_URI,
  graceSeconds: 0,
  issuerKind: "generic" as const,
};

function envelope(args: {
  jwks: unknown;
  fetchedAtMs?: number;
  issuer?: string;
  jwksUri?: string;
  v?: unknown;
}): string {
  return JSON.stringify({
    v: args.v ?? 1,
    issuer: args.issuer ?? ISSUER,
    jwksUri: args.jwksUri ?? JWKS_URI,
    fetchedAt: args.fetchedAtMs ?? FIXED_EPOCH_MS - 60_000,
    jwks: args.jwks,
  });
}

/* =============================================================== *
 * 1. Fetch succeeds → cache written, fresh keys used              *
 * =============================================================== */
describe("jwks-fallback — successful fetch", () => {
  it("writes the last-good JWKS to the store and verifies with the FRESH keys", async () => {
    const key = makeRsaKey("rsa-1");
    const store = new MemoryStore();
    const logger = makeLogger();
    const fetcher = scriptedFetch([ok(jwksOf(key))]);

    const verifier = createIssuerVerifier({
      ...baseConfig,
      jwksFallback: { store, logger, now: () => FIXED_EPOCH_MS, fetchJwks: fetcher.fn },
    });

    const res = await verifier.verify(sign(key));
    expect(res.claims.sub).toBe("opaque-subject-123");

    // Persisted under the pinned issuer, with the 7-day TTL.
    expect(store.setCalls).toEqual([
      { issuer: ISSUER, ttlSeconds: JWKS_FALLBACK_DEFAULT_MAX_STALENESS_SECONDS },
    ]);
    const stored = store.entries.get(ISSUER)!.value;
    expect(JSON.parse(stored)).toMatchObject({
      v: 1,
      issuer: ISSUER,
      jwksUri: JWKS_URI,
      fetchedAt: FIXED_EPOCH_MS,
      jwks: { keys: [{ kid: "rsa-1", kty: "RSA" }] },
    });
    // Happy path is silent — no fallback warning.
    expect(logger.calls).toEqual([]);
  });

  it("a successful fetch WINS over a present (and different) cached JWKS", async () => {
    const stale = makeRsaKey("rsa-stale");
    const fresh = makeRsaKey("rsa-fresh");
    const store = new MemoryStore();
    const logger = makeLogger();
    store.seedRaw(ISSUER, envelope({ jwks: jwksOf(stale) }));

    const verifier = createIssuerVerifier({
      ...baseConfig,
      jwksFallback: {
        store,
        logger,
        now: () => FIXED_EPOCH_MS,
        fetchJwks: scriptedFetch([ok(jwksOf(fresh))]).fn,
      },
    });

    // A token signed by the FRESH key verifies; the stale entry is not consulted.
    await expect(verifier.verify(sign(fresh))).resolves.toMatchObject({ issuer: ISSUER });
    expect(store.getCalls).toEqual([]);
    expect(logger.calls).toEqual([]);
    // And the cache has been overwritten with the fresh set.
    expect(store.entries.get(ISSUER)!.value).toContain("rsa-fresh");
  });

  it("a store write failure does not fail verification (best-effort persist)", async () => {
    const key = makeRsaKey("rsa-1");
    const store = new MemoryStore();
    store.failSet = true;
    const logger = makeLogger();

    const verifier = createIssuerVerifier({
      ...baseConfig,
      jwksFallback: {
        store,
        logger,
        now: () => FIXED_EPOCH_MS,
        fetchJwks: scriptedFetch([ok(jwksOf(key))]).fn,
      },
    });

    await expect(verifier.verify(sign(key))).resolves.toMatchObject({ issuer: ISSUER });
    expect(logger.calls.map((c) => c.context.event)).toEqual(["jwks_cache_write_failed"]);
  });
});

/* =============================================================== *
 * 2. Fetch fails, fresh cache present → verify from cache + warn   *
 * =============================================================== */
describe("jwks-fallback — fetch fails with a fresh cache", () => {
  it("verifies from the cached JWKS and emits an alertable warning", async () => {
    const key = makeRsaKey("rsa-1");
    const store = new MemoryStore();
    const logger = makeLogger();
    store.seedRaw(
      ISSUER,
      buildJwksEnvelope({
        issuer: ISSUER,
        jwksUri: JWKS_URI,
        fetchedAtMs: FIXED_EPOCH_MS - 2 * DAY_MS,
        jwks: jwksOf(key) as never,
      }),
    );

    const verifier = createIssuerVerifier({
      ...baseConfig,
      jwksFallback: { store, logger, now: () => FIXED_EPOCH_MS, fetchJwks: boom() },
    });

    const res = await verifier.verify(sign(key));
    expect(res.claims.sub).toBe("opaque-subject-123");

    const used = logger.calls.filter((c) => c.context.event === "jwks_fallback_used");
    expect(used.length).toBeGreaterThanOrEqual(1);
    expect(used[0]!.context).toMatchObject({
      issuer: ISSUER,
      jwksUri: JWKS_URI,
      ageSeconds: 2 * 24 * 60 * 60,
      maxStalenessSeconds: JWKS_FALLBACK_DEFAULT_MAX_STALENESS_SECONDS,
      keyCount: 1,
    });
    expect(String(used[0]!.context.fetchError)).toContain("ECONNREFUSED");
  });

  it("does not change the fail-closed outcome for a token the cached keys cannot verify", async () => {
    const cachedKey = makeRsaKey("rsa-1");
    const otherKey = makeRsaKey("rsa-2");
    const store = new MemoryStore();
    const logger = makeLogger();
    store.seedRaw(ISSUER, envelope({ jwks: jwksOf(cachedKey) }));

    const verifier = createIssuerVerifier({
      ...baseConfig,
      jwksFallback: { store, logger, now: () => FIXED_EPOCH_MS, fetchJwks: boom() },
    });

    // kid rsa-2 is in neither the (failed) fetch nor the cached set.
    await expect(verifier.verify(sign(otherKey))).rejects.toMatchObject({
      reason: "invalid_signature",
    });
  });
});

/* =============================================================== *
 * 3. Bounded staleness                                            *
 * =============================================================== */
describe("jwks-fallback — bounded staleness (7 days)", () => {
  it("REJECTS an entry older than 7 days; verification fails", async () => {
    const key = makeRsaKey("rsa-1");
    const store = new MemoryStore();
    const logger = makeLogger();
    store.seedRaw(
      ISSUER,
      envelope({ jwks: jwksOf(key), fetchedAtMs: FIXED_EPOCH_MS - (7 * DAY_MS + 1000) }),
    );

    const verifier = createIssuerVerifier({
      ...baseConfig,
      jwksFallback: { store, logger, now: () => FIXED_EPOCH_MS, fetchJwks: boom() },
    });

    await expect(verifier.verify(sign(key))).rejects.toMatchObject({
      reason: "invalid_signature",
    });
    expect(
      logger.calls.some(
        (c) => c.context.event === "jwks_fallback_unavailable" && c.context.reason === "too_stale",
      ),
    ).toBe(true);
  });

  it("ACCEPTS an entry just inside the 7-day bound", async () => {
    const key = makeRsaKey("rsa-1");
    const store = new MemoryStore();
    store.seedRaw(
      ISSUER,
      envelope({ jwks: jwksOf(key), fetchedAtMs: FIXED_EPOCH_MS - (7 * DAY_MS - 1000) }),
    );

    const verifier = createIssuerVerifier({
      ...baseConfig,
      jwksFallback: {
        store,
        logger: makeLogger(),
        now: () => FIXED_EPOCH_MS,
        fetchJwks: boom(),
      },
    });

    await expect(verifier.verify(sign(key))).resolves.toMatchObject({ issuer: ISSUER });
  });

  it("honours a tightened maxStalenessSeconds", async () => {
    const key = makeRsaKey("rsa-1");
    const store = new MemoryStore();
    store.seedRaw(
      ISSUER,
      envelope({ jwks: jwksOf(key), fetchedAtMs: FIXED_EPOCH_MS - 2 * DAY_MS }),
    );

    const verifier = createIssuerVerifier({
      ...baseConfig,
      jwksFallback: {
        store,
        logger: makeLogger(),
        now: () => FIXED_EPOCH_MS,
        fetchJwks: boom(),
        maxStalenessSeconds: DAY_MS / 1000,
      },
    });

    await expect(verifier.verify(sign(key))).rejects.toMatchObject({
      reason: "invalid_signature",
    });
  });
});

/* =============================================================== *
 * 4. Poisoned / malformed cache → treated as a miss, never a crash *
 * =============================================================== */
describe("jwks-fallback — poisoned cache is rejected as a miss", () => {
  const key = makeRsaKey("rsa-1");

  const poison: { name: string; raw: string; reason: string }[] = [
    { name: "not JSON at all", raw: "}{ not json", reason: "unparseable" },
    { name: "a JSON scalar", raw: '"just-a-string"', reason: "malformed_envelope" },
    { name: "a JSON array", raw: "[1,2,3]", reason: "malformed_envelope" },
    {
      name: "an unknown envelope version",
      raw: envelope({ jwks: jwksOf(key), v: 99 }),
      reason: "unsupported_version",
    },
    {
      name: "a different issuer",
      raw: envelope({ jwks: jwksOf(key), issuer: "https://evil.example.com/realms/trellis" }),
      reason: "issuer_mismatch",
    },
    {
      name: "a different jwksUri",
      raw: envelope({ jwks: jwksOf(key), jwksUri: "https://evil.example.com/certs" }),
      reason: "jwks_uri_mismatch",
    },
    {
      name: "a non-numeric fetchedAt",
      raw: JSON.stringify({
        v: 1,
        issuer: ISSUER,
        jwksUri: JWKS_URI,
        fetchedAt: "yesterday",
        jwks: jwksOf(key),
      }),
      reason: "invalid_timestamp",
    },
    {
      name: "a fetchedAt far in the future (life-extension attempt)",
      raw: envelope({ jwks: jwksOf(key), fetchedAtMs: FIXED_EPOCH_MS + 365 * DAY_MS }),
      reason: "invalid_timestamp",
    },
    {
      name: "non-JWKS JSON in the jwks slot",
      raw: envelope({ jwks: { hello: "world" } }),
      reason: "invalid_jwks",
    },
    {
      name: "keys not an array",
      raw: envelope({ jwks: { keys: "nope" } }),
      reason: "invalid_jwks",
    },
    {
      name: "a mangled key (n is a number, not a string)",
      raw: envelope({ jwks: { keys: [{ kty: "RSA", kid: "rsa-1", n: 12345, e: "AQAB" }] } }),
      reason: "invalid_jwks",
    },
    {
      name: "a structurally-valid but unusable key (RSA with no n/e)",
      raw: envelope({ jwks: { keys: [{ kty: "RSA", kid: "rsa-1" }] } }),
      reason: "no_usable_signing_key",
    },
    {
      name: "an encryption-only key",
      raw: envelope({
        jwks: { keys: [{ kty: "RSA", kid: "rsa-1", use: "enc", n: "abc", e: "AQAB" }] },
      }),
      reason: "no_usable_signing_key",
    },
    {
      name: "a key with no kid",
      raw: envelope({ jwks: { keys: [{ kty: "RSA", n: "abc", e: "AQAB" }] } }),
      reason: "no_usable_signing_key",
    },
    {
      name: "an empty key set",
      raw: envelope({ jwks: { keys: [] } }),
      reason: "no_usable_signing_key",
    },
    {
      // Hand-written JSON: an object literal would set the prototype at build
      // time and vanish from JSON.stringify, so the payload must be raw text
      // to actually exercise safeJsonParse's __proto__/constructor stripping.
      name: "a prototype-pollution attempt",
      raw:
        `{"v":1,"issuer":${JSON.stringify(ISSUER)},"jwksUri":${JSON.stringify(JWKS_URI)},` +
        `"fetchedAt":${FIXED_EPOCH_MS - 1000},` +
        `"jwks":{"keys":[{"kty":"RSA","kid":"x","__proto__":{"polluted":true}}]}}`,
      reason: "no_usable_signing_key",
    },
  ];

  for (const c of poison) {
    it(`rejects ${c.name} (reason=${c.reason}) without crashing`, async () => {
      const store = new MemoryStore();
      const logger = makeLogger();
      store.seedRaw(ISSUER, c.raw);

      const verifier = createIssuerVerifier({
        ...baseConfig,
        jwksFallback: { store, logger, now: () => FIXED_EPOCH_MS, fetchJwks: boom() },
      });

      await expect(verifier.verify(sign(key))).rejects.toMatchObject({
        reason: "invalid_signature",
      });
      expect(
        logger.calls.some(
          (l) => l.context.event === "jwks_fallback_unavailable" && l.context.reason === c.reason,
        ),
      ).toBe(true);
      // Nothing was polluted.
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  }

  it("treats an absent entry as a miss and rethrows the original fetch error class", async () => {
    const store = new MemoryStore();
    const logger = makeLogger();
    const verifier = createIssuerVerifier({
      ...baseConfig,
      jwksFallback: { store, logger, now: () => FIXED_EPOCH_MS, fetchJwks: boom() },
    });

    await expect(verifier.verify(sign(key))).rejects.toMatchObject({
      reason: "invalid_signature",
    });
    expect(
      logger.calls.some(
        (l) => l.context.event === "jwks_fallback_unavailable" && l.context.reason === "absent",
      ),
    ).toBe(true);
  });

  it("survives a store READ failure (verification fails closed, warning emitted)", async () => {
    const store = new MemoryStore();
    store.failGet = true;
    const logger = makeLogger();
    const verifier = createIssuerVerifier({
      ...baseConfig,
      jwksFallback: { store, logger, now: () => FIXED_EPOCH_MS, fetchJwks: boom() },
    });

    await expect(verifier.verify(sign(key))).rejects.toMatchObject({
      reason: "invalid_signature",
    });
    expect(
      logger.calls.some(
        (l) =>
          l.context.event === "jwks_fallback_unavailable" && l.context.reason === "store_error",
      ),
    ).toBe(true);
  });

  it("does NOT persist a non-JWKS body returned by a reachable endpoint", async () => {
    const store = new MemoryStore();
    const logger = makeLogger();
    const verifier = createIssuerVerifier({
      ...baseConfig,
      jwksFallback: {
        store,
        logger,
        now: () => FIXED_EPOCH_MS,
        fetchJwks: scriptedFetch([ok("<html>captive portal</html>")]).fn,
      },
    });

    await expect(verifier.verify(sign(key))).rejects.toBeInstanceOf(Error);
    expect(store.setCalls).toEqual([]);
  });
});

/* =============================================================== *
 * 5. No store injected → byte-identical to today                   *
 * =============================================================== */
describe("jwks-fallback — absent by default", () => {
  it("calls JwtVerifier.create with EXACTLY ONE argument when no fallback is configured", () => {
    const original = JwtVerifier.create.bind(JwtVerifier);
    const seen: unknown[][] = [];
    const spy = vi.spyOn(JwtVerifier, "create").mockImplementation((...args: unknown[]): never => {
      seen.push(args);
      return original(args[0] as Parameters<typeof original>[0]) as never;
    });

    try {
      createIssuerVerifier({ ...baseConfig });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toHaveLength(1);
      expect(seen[0]![0]).toMatchObject({ issuer: ISSUER, audience: AUDIENCE, graceSeconds: 0 });
    } finally {
      spy.mockRestore();
    }
  });

  it("passes a jwksCache ONLY when the fallback is configured", () => {
    const original = JwtVerifier.create.bind(JwtVerifier);
    const seen: unknown[][] = [];
    const spy = vi.spyOn(JwtVerifier, "create").mockImplementation((...args: unknown[]): never => {
      seen.push(args);
      return original(args[0] as Parameters<typeof original>[0]) as never;
    });

    try {
      createIssuerVerifier({
        ...baseConfig,
        jwksFallback: { store: new MemoryStore(), now: () => FIXED_EPOCH_MS, fetchJwks: boom() },
      });
      expect(seen[0]).toHaveLength(2);
      expect(seen[0]![1]).toHaveProperty("jwksCache");
    } finally {
      spy.mockRestore();
    }
  });

  it("never touches the store when no fallback is configured (verification still works)", async () => {
    const key = makeRsaKey("rsa-1");
    const store = new MemoryStore();

    // Build WITHOUT jwksFallback, priming the JWKS the way the pre-[JWKS-FALLBACK]
    // suite does (library `cacheJwks`) so no network is needed.
    const original = JwtVerifier.create.bind(JwtVerifier);
    const spy = vi.spyOn(JwtVerifier, "create").mockImplementation((props: unknown): never => {
      const inst = original(props as Parameters<typeof original>[0]);
      (inst as unknown as { cacheJwks: (j: unknown) => void }).cacheJwks(jwksOf(key));
      return inst as never;
    });
    let verifier;
    try {
      verifier = createIssuerVerifier({ ...baseConfig });
    } finally {
      spy.mockRestore();
    }

    await expect(verifier.verify(sign(key))).resolves.toMatchObject({ issuer: ISSUER });
    expect(store.getCalls).toEqual([]);
    expect(store.setCalls).toEqual([]);
  });
});

/* =============================================================== *
 * 6. The kid-rotation refetch path is unchanged                    *
 * =============================================================== */
describe("jwks-fallback — rotation path unchanged", () => {
  it("refetches on a kid miss and verifies with the rotated-in key", async () => {
    const oldKey = makeRsaKey("rsa-old");
    const newKey = makeRsaKey("rsa-new");
    const store = new MemoryStore();
    const logger = makeLogger();
    // 1st fetch: only the old key. 2nd fetch (kid miss → refetch): both.
    const fetcher = scriptedFetch([ok(jwksOf(oldKey)), ok(jwksOf(oldKey, newKey))]);

    const verifier = createIssuerVerifier({
      ...baseConfig,
      jwksFallback: { store, logger, now: () => FIXED_EPOCH_MS, fetchJwks: fetcher.fn },
    });

    await expect(verifier.verify(sign(oldKey))).resolves.toMatchObject({ issuer: ISSUER });
    await expect(verifier.verify(sign(newKey))).resolves.toMatchObject({ issuer: ISSUER });
    expect(fetcher.count()).toBe(2);
    // The refreshed set was persisted; no fallback was used.
    expect(store.entries.get(ISSUER)!.value).toContain("rsa-new");
    expect(logger.calls).toEqual([]);
  });
});

/* =============================================================== *
 * 7. readCachedJwks unit-level edges                               *
 * =============================================================== */
describe("readCachedJwks", () => {
  const key = makeRsaKey("rsa-1");
  const expected = {
    issuer: ISSUER,
    jwksUri: JWKS_URI,
    nowMs: FIXED_EPOCH_MS,
    maxStalenessSeconds: JWKS_FALLBACK_DEFAULT_MAX_STALENESS_SECONDS,
  };

  it("reports absent for null and for the empty string", () => {
    expect(readCachedJwks(null, expected)).toEqual({ ok: false, reason: "absent" });
    expect(readCachedJwks("", expected)).toEqual({ ok: false, reason: "absent" });
  });

  it("round-trips buildJwksEnvelope and reports the age in seconds", () => {
    const raw = buildJwksEnvelope({
      issuer: ISSUER,
      jwksUri: JWKS_URI,
      fetchedAtMs: FIXED_EPOCH_MS - 90_000,
      jwks: jwksOf(key) as never,
    });
    const result = readCachedJwks(raw, expected);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ageSeconds).toBe(90);
      expect(result.jwks.keys).toHaveLength(1);
    }
  });

  it("a maxStalenessSeconds of 0 disables the read entirely", () => {
    const raw = buildJwksEnvelope({
      issuer: ISSUER,
      jwksUri: JWKS_URI,
      fetchedAtMs: FIXED_EPOCH_MS,
      jwks: jwksOf(key) as never,
    });
    expect(readCachedJwks(raw, { ...expected, maxStalenessSeconds: 0 })).toEqual({
      ok: false,
      reason: "too_stale",
    });
  });

  it("tolerates small forward clock skew", () => {
    const raw = buildJwksEnvelope({
      issuer: ISSUER,
      jwksUri: JWKS_URI,
      fetchedAtMs: FIXED_EPOCH_MS + 30_000,
      jwks: jwksOf(key) as never,
    });
    const result = readCachedJwks(raw, expected);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ageSeconds).toBe(0);
  });

  it("accepts EC and OKP signing keys", () => {
    for (const k of [
      { kty: "EC", kid: "ec-1", crv: "P-256", x: "aa", y: "bb" },
      { kty: "OKP", kid: "ed-1", crv: "Ed25519", x: "cc" },
    ]) {
      const raw = envelope({ jwks: { keys: [k] } });
      expect(readCachedJwks(raw, expected).ok).toBe(true);
    }
  });

  it("rejects an EC key missing its y coordinate", () => {
    const raw = envelope({ jwks: { keys: [{ kty: "EC", kid: "ec-1", crv: "P-256", x: "aa" }] } });
    expect(readCachedJwks(raw, expected)).toEqual({ ok: false, reason: "no_usable_signing_key" });
  });

  it("rejects an unknown kty", () => {
    const raw = envelope({ jwks: { keys: [{ kty: "oct", kid: "hmac-1" }] } });
    expect(readCachedJwks(raw, expected)).toEqual({ ok: false, reason: "no_usable_signing_key" });
  });
});
