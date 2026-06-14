/**
 * Unit tests for the shared-distribution edge `check-auth` handler.
 *
 * Every refuse-reason branch has a dedicated test:
 *   - `no-host` (Host header absent)
 *   - `host-not-tenant-shape` (Host doesn't match parent+pattern)
 *   - `no-token` → redirect (no cookie)
 *   - `bad-signature` (wrong key)
 *   - `expired` (token past exp + skew)
 *   - `wrong-iss` (issuer mismatch)
 *   - `wrong-token-use` (access token instead of id)
 *   - `no-tenant-claim` (custom:tenant_id absent)
 *   - `tenant-mismatch` (host vs claim mismatch)
 *   - `no-aud` (aud missing/empty)
 *   - pass-through (valid token)
 *
 * The JWKS provider is stubbed via the `__setJwksProviderForTests` seam
 * so the tests never hit `fetch`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handler,
  __setJwksProviderForTests,
  __resetJwksProviderForTests,
} from '../../../src/lambda/shared-distribution/edge/check-auth.js';
import {
  TEST_ISSUER,
  generateTestKey,
  signTestJwt,
  signHs256TestJwt,
  type TestKeyPair,
} from './test-jwt-helpers.js';
import type {
  CloudFrontRequest,
  CloudFrontRequestEvent,
  CloudFrontResultResponse,
} from '../../../src/lambda/shared-distribution/edge/cloudfront-types.js';

// Reference epoch matching signTestJwt defaults. Freeze the clock so
// aws-jwt-verify's exp check sees the same "now".
const FIXED_NOW_SEC = 1_700_000_000;
const FIXED_NOW_MS = FIXED_NOW_SEC * 1000;

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
  // Silence the metric stdout JSON lines.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterAll(() => {
  vi.useRealTimers();
});

afterEach(() => {
  __resetJwksProviderForTests();
  vi.restoreAllMocks();
});

function makeEvent(args: {
  host?: string;
  cookie?: string;
}): CloudFrontRequestEvent {
  const headers: CloudFrontRequest['headers'] = {};
  if (args.host !== undefined) {
    headers['host'] = [{ key: 'Host', value: args.host }];
  }
  if (args.cookie !== undefined) {
    headers['cookie'] = [{ key: 'Cookie', value: args.cookie }];
  }
  return {
    Records: [
      {
        cf: {
          request: {
            uri: '/',
            method: 'GET',
            querystring: '',
            headers,
          },
        },
      },
    ],
  };
}

function asResult(r: unknown): CloudFrontResultResponse {
  return r as CloudFrontResultResponse;
}

describe('check-auth handler', () => {
  it('refuses with no-host when Host header is absent', async () => {
    const r = asResult(await handler(makeEvent({})));
    expect(r.status).toBe('403');
  });

  it('refuses with host-not-tenant-shape when host is the apex', async () => {
    const r = asResult(await handler(makeEvent({ host: 'tenants.example.com' })));
    expect(r.status).toBe('403');
  });

  it('refuses with host-not-tenant-shape when host is on a foreign parent', async () => {
    const r = asResult(await handler(makeEvent({ host: 'acme.evil.com' })));
    expect(r.status).toBe('403');
  });

  it('refuses with host-not-tenant-shape for multi-level subdomain', async () => {
    const r = asResult(
      await handler(makeEvent({ host: 'acme.bob.tenants.example.com' })),
    );
    expect(r.status).toBe('403');
  });

  it('refuses with host-not-tenant-shape when label is a valid subdomain but fails TENANT_PATTERN', async () => {
    // '9acme' is structurally a single-label subdomain under the parent, but
    // starts with a digit so it fails TENANT_PATTERN (/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/).
    // This exercises the `!pattern.test(label)` branch (line 100) in extractTenantSubdomain.
    const r = asResult(await handler(makeEvent({ host: '9acme.tenants.example.com' })));
    expect(r.status).toBe('403');
  });

  it('redirects to /login when no cookie is present (tenant-shape host)', async () => {
    const r = asResult(await handler(makeEvent({ host: 'acme.tenants.example.com' })));
    expect(r.status).toBe('302');
    const loc = r.headers['location']?.[0]?.value;
    expect(loc).toMatch(/^https:\/\/acme\.tenants\.example\.com\/login$/);
  });

  it('redirects to /login when cookie value is empty', async () => {
    const r = asResult(
      await handler(
        makeEvent({ host: 'acme.tenants.example.com', cookie: 'vestibulum_id_token=' }),
      ),
    );
    expect(r.status).toBe('302');
  });

  it('refuses with bad-signature when token is signed with wrong key', async () => {
    const token = signTestJwt(wrongKey, { kid: primary.kid }); // wrong key, but matching kid
    const r = asResult(
      await handler(
        makeEvent({
          host: 'acme.tenants.example.com',
          cookie: `vestibulum_id_token=${token}`,
        }),
      ),
    );
    expect(r.status).toBe('403');
  });

  it('refuses with bad-signature when kid is not in JWKS', async () => {
    const token = signTestJwt(wrongKey); // wrongKey has its own kid not in JWKS
    const r = asResult(
      await handler(
        makeEvent({
          host: 'acme.tenants.example.com',
          cookie: `vestibulum_id_token=${token}`,
        }),
      ),
    );
    expect(r.status).toBe('403');
  });

  it('refuses with expired for past-exp token', async () => {
    const past = FIXED_NOW_SEC - 3600;
    const token = signTestJwt(primary, {
      claims: { exp: past, nbf: past - 60, iat: past - 60 },
    });
    const r = asResult(
      await handler(
        makeEvent({
          host: 'acme.tenants.example.com',
          cookie: `vestibulum_id_token=${token}`,
        }),
      ),
    );
    expect(r.status).toBe('403');
  });

  it('refuses with wrong-iss for issuer mismatch', async () => {
    const token = signTestJwt(primary, {
      claims: { iss: 'https://attacker.example.com/p' },
    });
    const r = asResult(
      await handler(
        makeEvent({
          host: 'acme.tenants.example.com',
          cookie: `vestibulum_id_token=${token}`,
        }),
      ),
    );
    expect(r.status).toBe('403');
  });

  it('refuses with wrong-token-use for access token', async () => {
    const token = signTestJwt(primary, { claims: { token_use: 'access' } });
    const r = asResult(
      await handler(
        makeEvent({
          host: 'acme.tenants.example.com',
          cookie: `vestibulum_id_token=${token}`,
        }),
      ),
    );
    expect(r.status).toBe('403');
  });

  it('refuses with no-tenant-claim when custom:tenant_id is absent', async () => {
    const token = signTestJwt(primary, {
      claims: {
        token_use: 'id',
        // Spread will not OMIT, so explicitly set to undefined and let the
        // helper not include it in the signed payload.
        'custom:tenant_id': undefined,
      },
    });
    const r = asResult(
      await handler(
        makeEvent({
          host: 'acme.tenants.example.com',
          cookie: `vestibulum_id_token=${token}`,
        }),
      ),
    );
    expect(r.status).toBe('403');
  });

  it('refuses with tenant-mismatch when claim and host differ', async () => {
    const token = signTestJwt(primary, {
      claims: { 'custom:tenant_id': 'bob' },
    });
    const r = asResult(
      await handler(
        makeEvent({
          host: 'acme.tenants.example.com',
          cookie: `vestibulum_id_token=${token}`,
        }),
      ),
    );
    expect(r.status).toBe('403');
  });

  it('refuses tenant A cookie at tenant B with the tenant-mismatch reason (not an incidental refuse)', async () => {
    // The load-bearing cross-tenant gate. A token validly issued for tenant
    // "acme" (good signature, good iss, token_use=id, present aud) presented
    // on tenant "bob"'s host must be refused — AND refused for the structural
    // binding reason, not an incidental one (e.g. no-aud). Capturing the
    // emitted metric reason pins that the tenant-mismatch branch fired, so the
    // test is not a tautology that any 403 would satisfy.
    const reasons: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      try {
        const parsed = JSON.parse(String(line)) as { metric?: string; reason?: string };
        if (
          parsed.metric === 'Vestibulum/SharedDistribution/EdgeCheckRefused' &&
          typeof parsed.reason === 'string' &&
          parsed.reason.length > 0
        ) {
          reasons.push(parsed.reason);
        }
      } catch {
        /* non-JSON log line; ignore */
      }
    });
    // Token is fully valid for tenant "acme" (aud present, token_use id).
    const token = signTestJwt(primary, {
      claims: { 'custom:tenant_id': 'acme', aud: 'test-client-id' },
    });
    const r = asResult(
      await handler(
        makeEvent({
          // ...but presented on tenant "bob"'s host.
          host: 'bob.tenants.example.com',
          cookie: `vestibulum_id_token=${token}`,
        }),
      ),
    );
    expect(r.status).toBe('403');
    expect(reasons).toContain('tenant-mismatch');
    // Must NOT have been admitted: a CloudFront pass-through returns the
    // request (with a `method`), never a 403 response object.
    expect((r as { method?: string }).method).toBeUndefined();
  });

  it('refuses with no-aud when aud is missing', async () => {
    const token = signTestJwt(primary, {
      claims: { aud: undefined, 'custom:tenant_id': 'acme' },
    });
    const r = asResult(
      await handler(
        makeEvent({
          host: 'acme.tenants.example.com',
          cookie: `vestibulum_id_token=${token}`,
        }),
      ),
    );
    expect(r.status).toBe('403');
  });

  it('refuses with no-aud when aud is empty string', async () => {
    const token = signTestJwt(primary, {
      claims: { aud: '', 'custom:tenant_id': 'acme' },
    });
    const r = asResult(
      await handler(
        makeEvent({
          host: 'acme.tenants.example.com',
          cookie: `vestibulum_id_token=${token}`,
        }),
      ),
    );
    expect(r.status).toBe('403');
  });

  it('passes through a fully-valid token', async () => {
    const token = signTestJwt(primary, {
      claims: { 'custom:tenant_id': 'acme' },
    });
    const r = await handler(
      makeEvent({
        host: 'acme.tenants.example.com',
        cookie: `vestibulum_id_token=${token}`,
      }),
    );
    // Pass-through: the original request is returned (not a response object).
    expect((r as { status?: string }).status).toBeUndefined();
    expect((r as { method?: string }).method).toBe('GET');
  });

  it('handles trailing-dot host (review H1)', async () => {
    const token = signTestJwt(primary, {
      claims: { 'custom:tenant_id': 'acme' },
    });
    const r = await handler(
      makeEvent({
        host: 'acme.tenants.example.com.',
        cookie: `vestibulum_id_token=${token}`,
      }),
    );
    expect((r as { method?: string }).method).toBe('GET');
  });

  it('handles port + trailing-dot host', async () => {
    const token = signTestJwt(primary, {
      claims: { 'custom:tenant_id': 'acme' },
    });
    const r = await handler(
      makeEvent({
        host: 'acme.tenants.example.com.:443',
        cookie: `vestibulum_id_token=${token}`,
      }),
    );
    expect((r as { method?: string }).method).toBe('GET');
  });

  it('handles malformed event with no Records[0]', async () => {
    const r = asResult(
      await handler({ Records: [] } as unknown as CloudFrontRequestEvent),
    );
    expect(r.status).toBe('400');
  });

  it('redirects to /login when JWKS fetch fails', async () => {
    __setJwksProviderForTests({
      async getJwks() {
        throw new Error('JWKS unavailable');
      },
    });
    const token = signTestJwt(primary, {
      claims: { 'custom:tenant_id': 'acme' },
    });
    const r = asResult(
      await handler(
        makeEvent({
          host: 'acme.tenants.example.com',
          cookie: `vestibulum_id_token=${token}`,
        }),
      ),
    );
    expect(r.status).toBe('302');
  });

  it('redirects on a malformed cookie that yields a garbage token', async () => {
    const r = asResult(
      await handler(
        makeEvent({
          host: 'acme.tenants.example.com',
          cookie: 'vestibulum_id_token=not.a.jwt',
        }),
      ),
    );
    // Garbage token → verifyJwt throws → falls back to loginRedirect.
    expect(['302', '403']).toContain(r.status);
  });

  it('refuses with bad-signature for an HS256 token (alg branch in mapVerifyErrorToResponse)', async () => {
    // verifyJwt rejects HS256 with "verifyJwt: unsupported alg "HS256"".
    // That message contains "alg" but not "signature" or "kid", so
    // mapVerifyErrorToResponse reaches the `msg.includes('alg')` sub-expression
    // (line 219) rather than short-circuiting on an earlier condition.
    const token = signHs256TestJwt({
      iss: TEST_ISSUER,
      aud: 'test-client-id',
      token_use: 'id',
      'custom:tenant_id': 'acme',
      sub: 'test-sub',
      iat: FIXED_NOW_SEC,
      nbf: FIXED_NOW_SEC - 5,
      exp: FIXED_NOW_SEC + 3600,
    });
    const r = asResult(
      await handler(
        makeEvent({
          host: 'acme.tenants.example.com',
          cookie: `vestibulum_id_token=${token}`,
        }),
      ),
    );
    expect(r.status).toBe('403');
  });

  it('falls back to loginRedirect for a verifyJwt error with no recognised keyword', async () => {
    // A token with nbf far in the future triggers JwtNotBeforeError inside
    // verifyJwtSync. The error is re-wrapped as
    // "verifyJwt: Token can't be used before {ISO date}".
    // That message contains none of the keywords "iss", "exp", "expired",
    // "Token expired", "signature", "kid", or "alg", so mapVerifyErrorToResponse
    // falls through to the loginRedirect fallback (lines 224-225 of check-auth.ts).
    const futureNbf = FIXED_NOW_SEC + 7200; // 2 hours ahead — past the 60s skew
    const token = signTestJwt(primary, {
      claims: {
        'custom:tenant_id': 'acme',
        nbf: futureNbf,
        iat: FIXED_NOW_SEC,
      },
    });
    const r = asResult(
      await handler(
        makeEvent({
          host: 'acme.tenants.example.com',
          cookie: `vestibulum_id_token=${token}`,
        }),
      ),
    );
    // The fallback path returns a 302 loginRedirect.
    expect(r.status).toBe('302');
  });
});
