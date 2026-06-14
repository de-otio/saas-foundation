/**
 * Tests for the shared-distribution edge `JwksCache`.
 *
 * Asserts:
 * - Constructor validates jwksUrl + ttlMs.
 * - First call fetches.
 * - Within TTL → cached set returned without refetch.
 * - After TTL → fresh fetch; new set fully replaces old (no union).
 * - Fetch error → cache cleared, next call retries.
 * - Non-2xx → cache cleared, error thrown.
 * - Parse error (malformed JSON) → cache cleared, error thrown.
 * - Missing `keys` array → cache cleared, error thrown.
 * - Non-object key entries are dropped.
 */

import { describe, expect, it } from 'vitest';

import {
  JwksCache,
  type JsonWebKey,
  type JwksFetcher,
} from '../../../src/lambda/shared-distribution/edge/jwks-cache.js';

function makeResponse(body: string, ok = true, status = 200) {
  return {
    ok,
    status,
    async text() {
      return body;
    },
  };
}

function makeFetcher(responses: Array<Awaited<ReturnType<JwksFetcher>>>): {
  fetcher: JwksFetcher;
  calls: number;
} {
  let idx = 0;
  const state = { calls: 0 };
  const fetcher: JwksFetcher = async () => {
    state.calls += 1;
    const r = responses[idx];
    idx = Math.min(idx + 1, responses.length - 1);
    if (r === undefined) throw new Error('no response staged');
    return r;
  };
  return {
    fetcher,
    get calls() {
      return state.calls;
    },
  };
}

function jwksJson(keys: Array<Record<string, unknown>>): string {
  return JSON.stringify({ keys });
}

describe('JwksCache constructor', () => {
  it('rejects empty jwksUrl', () => {
    expect(() => new JwksCache({ jwksUrl: '', ttlMs: 1000 })).toThrow(TypeError);
  });

  it('rejects non-positive ttlMs', () => {
    expect(() => new JwksCache({ jwksUrl: 'https://x', ttlMs: 0 })).toThrow();
    expect(() => new JwksCache({ jwksUrl: 'https://x', ttlMs: -1 })).toThrow();
  });

  it('rejects non-finite ttlMs', () => {
    expect(() => new JwksCache({ jwksUrl: 'https://x', ttlMs: Infinity })).toThrow();
    expect(() => new JwksCache({ jwksUrl: 'https://x', ttlMs: NaN })).toThrow();
  });
});

describe('JwksCache.getJwks', () => {
  it('fetches on first call', async () => {
    const { fetcher } = makeFetcher([
      makeResponse(jwksJson([{ kid: 'a', kty: 'RSA' }])),
    ]);
    let calls = 0;
    const c = new JwksCache({
      jwksUrl: 'https://x',
      ttlMs: 10_000,
      fetcher: async (...args) => {
        calls += 1;
        return fetcher(...args);
      },
    });
    const keys = await c.getJwks();
    expect(keys).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it('returns cached set within TTL (no second fetch)', async () => {
    let calls = 0;
    const c = new JwksCache({
      jwksUrl: 'https://x',
      ttlMs: 10_000,
      fetcher: async () => {
        calls += 1;
        return makeResponse(jwksJson([{ kid: 'a', kty: 'RSA' }]));
      },
      clock: () => 0,
    });
    const a = await c.getJwks();
    const b = await c.getJwks();
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  it('refetches after TTL (full replace, not union)', async () => {
    let now = 0;
    let calls = 0;
    const c = new JwksCache({
      jwksUrl: 'https://x',
      ttlMs: 1000,
      fetcher: async () => {
        calls += 1;
        const keys: JsonWebKey[] =
          calls === 1
            ? [{ kid: 'old-key', kty: 'RSA' }]
            : [{ kid: 'new-key', kty: 'RSA' }];
        return makeResponse(jwksJson(keys));
      },
      clock: () => now,
    });

    const first = await c.getJwks();
    expect(first.map((k) => k['kid'])).toEqual(['old-key']);

    now = 1001; // exceed TTL
    const second = await c.getJwks();
    expect(calls).toBe(2);
    // Full-replace: old key MUST NOT appear in the new set.
    expect(second.map((k) => k['kid'])).toEqual(['new-key']);
    expect(second.map((k) => k['kid'])).not.toContain('old-key');
  });

  it('on fetch error, clears cache and rethrows; retries on next call', async () => {
    let calls = 0;
    const c = new JwksCache({
      jwksUrl: 'https://x',
      ttlMs: 10_000,
      fetcher: async () => {
        calls += 1;
        if (calls === 1) throw new Error('network down');
        return makeResponse(jwksJson([{ kid: 'a', kty: 'RSA' }]));
      },
    });
    await expect(c.getJwks()).rejects.toThrow(/network down/);
    // Next call must retry (not return a stale empty/last-known).
    const ok = await c.getJwks();
    expect(calls).toBe(2);
    expect(ok).toHaveLength(1);
  });

  it('on non-2xx, clears cache and throws with status', async () => {
    let calls = 0;
    const c = new JwksCache({
      jwksUrl: 'https://x',
      ttlMs: 10_000,
      fetcher: async () => {
        calls += 1;
        return makeResponse('forbidden', false, 403);
      },
    });
    await expect(c.getJwks()).rejects.toThrow(/HTTP 403/);
    expect(calls).toBe(1);
  });

  it('on malformed JSON, clears cache and throws', async () => {
    const c = new JwksCache({
      jwksUrl: 'https://x',
      ttlMs: 10_000,
      fetcher: async () => makeResponse('{not json'),
    });
    await expect(c.getJwks()).rejects.toThrow(/JWKS parse failed/);
  });

  it('on missing keys array, clears cache and throws', async () => {
    const c = new JwksCache({
      jwksUrl: 'https://x',
      ttlMs: 10_000,
      fetcher: async () => makeResponse(JSON.stringify({ wrong: true })),
    });
    await expect(c.getJwks()).rejects.toThrow(/missing `keys` array/);
  });

  it('on null body, clears cache and throws', async () => {
    const c = new JwksCache({
      jwksUrl: 'https://x',
      ttlMs: 10_000,
      fetcher: async () => makeResponse('null'),
    });
    await expect(c.getJwks()).rejects.toThrow(/missing `keys` array/);
  });

  it('filters out non-object key entries', async () => {
    const c = new JwksCache({
      jwksUrl: 'https://x',
      ttlMs: 10_000,
      fetcher: async () =>
        makeResponse(
          JSON.stringify({
            keys: [{ kid: 'ok', kty: 'RSA' }, null, 'string-key', { kid: 'ok2', kty: 'RSA' }],
          }),
        ),
    });
    const keys = await c.getJwks();
    expect(keys.map((k) => k['kid'])).toEqual(['ok', 'ok2']);
  });

  it('after error then success, the success result is cached', async () => {
    let calls = 0;
    const c = new JwksCache({
      jwksUrl: 'https://x',
      ttlMs: 10_000,
      fetcher: async () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        return makeResponse(jwksJson([{ kid: 'a', kty: 'RSA' }]));
      },
      clock: () => 0,
    });
    await expect(c.getJwks()).rejects.toThrow();
    const a = await c.getJwks();
    const b = await c.getJwks();
    expect(a).toBe(b);
    expect(calls).toBe(2);
  });
});
