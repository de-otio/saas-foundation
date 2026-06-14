/**
 * Property tests for the shared-distribution edge `check-auth` handler.
 *
 * Pinned to seed `0xc0ffee`, `numRuns: 1000` per the implementation plan
 * (and the canonical spec at `04-multi-aud-edge-check.md`).
 *
 * The cross-tenant rejection property is the **gating** property — if it
 * ever fails, the merge is blocked.
 *
 * Properties:
 *   1. Cross-tenant rejection (gating).
 *   2. Missing claim rejection.
 *   3. No token → tenant-scoped redirect.
 *   4. Wrong key rejection.
 *   5. Wrong issuer rejection.
 *   6. Expired token rejection.
 *   7. Access token rejection (review N6).
 */

import fc from 'fast-check';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handler,
  __setJwksProviderForTests,
  __resetJwksProviderForTests,
} from '../../../src/lambda/shared-distribution/edge/check-auth.js';
import {
  generateTestKey,
  signTestJwt,
  type TestKeyPair,
} from './test-jwt-helpers.js';
import type {
  CloudFrontRequest,
  CloudFrontRequestEvent,
  CloudFrontResultResponse,
} from '../../../src/lambda/shared-distribution/edge/cloudfront-types.js';

const RUN_OPTIONS = { numRuns: 1000, seed: 0xc0ffee } as const;

// Reference epoch matching signTestJwt defaults. Freeze the clock so
// aws-jwt-verify's exp check sees the same "now".
const FIXED_NOW_SEC = 1_700_000_000;
const FIXED_NOW_MS = FIXED_NOW_SEC * 1000;

// fast-check tenant-id arbitrary: matches the bundle-baked TENANT_PATTERN
// (`/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/`). We generate labels 3..16 chars,
// all-lowercase, no leading dash/digit, no trailing dash.
const tenantIdArb = fc
  .stringMatching(/^[a-z][a-z0-9-]{1,14}[a-z0-9]$/)
  .filter((s) => s.length >= 3 && s.length <= 16);

let primary: TestKeyPair;
let wrongKey: TestKeyPair;

beforeAll(() => {
  vi.useFakeTimers({ now: FIXED_NOW_MS });
  primary = generateTestKey('primary-kid');
  wrongKey = generateTestKey('rotated-kid');
});

beforeEach(() => {
  __setJwksProviderForTests({
    async getJwks() {
      return [primary.jwk];
    },
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterAll(() => {
  vi.useRealTimers();
});

afterEach(() => {
  __resetJwksProviderForTests();
  vi.restoreAllMocks();
});

function makeEvent(args: { host: string; cookie?: string }): CloudFrontRequestEvent {
  const headers: CloudFrontRequest['headers'] = {
    host: [{ key: 'Host', value: args.host }],
  };
  if (args.cookie !== undefined) {
    headers['cookie'] = [{ key: 'Cookie', value: args.cookie }];
  }
  return {
    Records: [
      {
        cf: { request: { uri: '/', method: 'GET', querystring: '', headers } },
      },
    ],
  };
}

function asResult(r: unknown): CloudFrontResultResponse {
  return r as CloudFrontResultResponse;
}

describe('check-auth property tests', () => {
  it(
    '[gating] cross-tenant rejection: token for A presented at B → refuse',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.tuple(tenantIdArb, tenantIdArb).filter(([a, b]) => a !== b),
          async ([tenantA, tenantB]) => {
            // The token is otherwise fully valid for tenantA (good signature,
            // iss, token_use=id, aud present) — so the ONLY thing that can
            // reject it at tenantB is the structural tenant binding. Capturing
            // the refuse reason makes this non-tautological: a 403 from an
            // incidental cause (e.g. no-aud) would NOT satisfy the assertion.
            const reasons: string[] = [];
            vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
              try {
                const p = JSON.parse(String(line)) as { metric?: string; reason?: string };
                if (
                  p.metric === 'Vestibulum/SharedDistribution/EdgeCheckRefused' &&
                  p.reason !== undefined
                ) {
                  reasons.push(p.reason);
                }
              } catch {
                /* ignore non-JSON log lines */
              }
            });
            const token = signTestJwt(primary, {
              claims: { 'custom:tenant_id': tenantA, aud: 'test-client-id' },
            });
            const r = await handler(
              makeEvent({
                host: `${tenantB}.tenants.example.com`,
                cookie: `vestibulum_id_token=${token}`,
              }),
            );
            // The gating assertion: any cross-tenant token MUST be refused (403)
            // and MUST NOT be admitted as a pass-through (no `.method`).
            expect(asResult(r).status).toBe('403');
            expect((r as { method?: string }).method).toBeUndefined();
            // And it must refuse for the structural-binding reason, not an
            // incidental one.
            expect(reasons).toContain('tenant-mismatch');
          },
        ),
        RUN_OPTIONS,
      );
    },
    20_000,
  );

  it(
    'missing claim: token without custom:tenant_id is always rejected',
    async () => {
      await fc.assert(
        fc.asyncProperty(tenantIdArb, async (tenant) => {
          const token = signTestJwt(primary, {
            claims: { 'custom:tenant_id': undefined },
          });
          const r = asResult(
            await handler(
              makeEvent({
                host: `${tenant}.tenants.example.com`,
                cookie: `vestibulum_id_token=${token}`,
              }),
            ),
          );
          expect(r.status).toBe('403');
        }),
        RUN_OPTIONS,
      );
    },
    20_000,
  );

  it(
    'no token: tenant-scoped redirect to login',
    async () => {
      await fc.assert(
        fc.asyncProperty(tenantIdArb, async (tenant) => {
          const r = asResult(
            await handler(makeEvent({ host: `${tenant}.tenants.example.com` })),
          );
          expect(r.status).toBe('302');
          const loc = r.headers['location']?.[0]?.value ?? '';
          expect(loc).toMatch(
            new RegExp(`^https://${tenant}\\.tenants\\.example\\.com/login$`),
          );
        }),
        RUN_OPTIONS,
      );
    },
    20_000,
  );

  it(
    'wrong key: token signed by a key not in the JWKS is always refused',
    async () => {
      await fc.assert(
        fc.asyncProperty(tenantIdArb, async (tenant) => {
          // wrongKey has kid 'rotated-kid' which is NOT in the JWKS we
          // injected (only primary.kid).
          const token = signTestJwt(wrongKey, {
            claims: { 'custom:tenant_id': tenant },
          });
          const r = asResult(
            await handler(
              makeEvent({
                host: `${tenant}.tenants.example.com`,
                cookie: `vestibulum_id_token=${token}`,
              }),
            ),
          );
          expect(r.status).toBe('403');
        }),
        RUN_OPTIONS,
      );
    },
    20_000,
  );

  it(
    'wrong iss: token with foreign issuer is always refused',
    async () => {
      await fc.assert(
        fc.asyncProperty(tenantIdArb, async (tenant) => {
          const token = signTestJwt(primary, {
            claims: {
              iss: 'https://attacker.example.com/pool',
              'custom:tenant_id': tenant,
            },
          });
          const r = asResult(
            await handler(
              makeEvent({
                host: `${tenant}.tenants.example.com`,
                cookie: `vestibulum_id_token=${token}`,
              }),
            ),
          );
          expect(r.status).toBe('403');
        }),
        RUN_OPTIONS,
      );
    },
    20_000,
  );

  it(
    'expired token: always refused',
    async () => {
      await fc.assert(
        fc.asyncProperty(tenantIdArb, async (tenant) => {
          const past = FIXED_NOW_SEC - 3600;
          const token = signTestJwt(primary, {
            claims: {
              'custom:tenant_id': tenant,
              exp: past,
              nbf: past - 60,
              iat: past - 60,
            },
          });
          const r = asResult(
            await handler(
              makeEvent({
                host: `${tenant}.tenants.example.com`,
                cookie: `vestibulum_id_token=${token}`,
              }),
            ),
          );
          expect(r.status).toBe('403');
        }),
        RUN_OPTIONS,
      );
    },
    20_000,
  );

  it(
    '[N6] access token: token_use=access is always refused (no access path)',
    async () => {
      await fc.assert(
        fc.asyncProperty(tenantIdArb, async (tenant) => {
          const token = signTestJwt(primary, {
            claims: {
              token_use: 'access',
              'custom:tenant_id': tenant,
            },
          });
          const r = asResult(
            await handler(
              makeEvent({
                host: `${tenant}.tenants.example.com`,
                cookie: `vestibulum_id_token=${token}`,
              }),
            ),
          );
          expect(r.status).toBe('403');
        }),
        RUN_OPTIONS,
      );
    },
    20_000,
  );
});
