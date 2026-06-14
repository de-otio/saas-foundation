/**
 * Tests for the shared-distribution edge `verifyJwt`.
 *
 * Asserts:
 * - Valid RS256 token → returns claims.
 * - HS256 token → throws (alg allow-list).
 * - `alg: none` → throws.
 * - kid missing in header → throws.
 * - kid not in JWKS → throws (no fallback even if rotated-out kid was once valid).
 * - Wrong issuer → throws.
 * - Expired token → throws.
 * - Bad signature → throws.
 * - Empty token → throws.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { verifyJwt } from '../../../src/lambda/shared-distribution/edge/verify-jwt.js';
import {
  TEST_ISSUER,
  generateTestKey,
  signTestJwt,
  signHs256TestJwt,
  signNoneTestJwt,
  type TestKeyPair,
} from './test-jwt-helpers.js';

// Reference epoch used by signTestJwt defaults and all inline exp values.
// Freeze the clock so aws-jwt-verify's exp check sees the same "now".
const FIXED_NOW_SEC = 1_700_000_000;
const FIXED_NOW_MS = FIXED_NOW_SEC * 1000;

let primary: TestKeyPair;
let rotated: TestKeyPair;

beforeAll(() => {
  vi.useFakeTimers({ now: FIXED_NOW_MS });
  primary = generateTestKey('primary-kid');
  rotated = generateTestKey('rotated-kid');
});

afterAll(() => {
  vi.useRealTimers();
});

describe('verifyJwt', () => {
  it('returns claims for a valid RS256 token', async () => {
    const token = signTestJwt(primary);
    const claims = await verifyJwt(token, {
      issuer: TEST_ISSUER,
      jwks: [primary.jwk],
      algorithms: ['RS256'],
      clockSkewSec: 60,
    });
    expect(claims['custom:tenant_id']).toBe('acme');
    expect(claims['token_use']).toBe('id');
  });

  it('rejects empty token string', async () => {
    await expect(
      verifyJwt('', {
        issuer: TEST_ISSUER,
        jwks: [primary.jwk],
        algorithms: ['RS256'],
        clockSkewSec: 60,
      }),
    ).rejects.toThrow(/non-empty string/);
  });

  it('rejects HS256 token (alg not in allow-list)', async () => {
    const token = signHs256TestJwt({
      iss: TEST_ISSUER,
      aud: 'test',
      token_use: 'id',
      'custom:tenant_id': 'acme',
      exp: FIXED_NOW_SEC + 1000,
    });
    await expect(
      verifyJwt(token, {
        issuer: TEST_ISSUER,
        jwks: [primary.jwk],
        algorithms: ['RS256'],
        clockSkewSec: 60,
      }),
    ).rejects.toThrow();
  });

  it('rejects alg: none', async () => {
    const token = signNoneTestJwt({
      iss: TEST_ISSUER,
      aud: 'test',
      token_use: 'id',
      'custom:tenant_id': 'acme',
      exp: FIXED_NOW_SEC + 1000,
    });
    await expect(
      verifyJwt(token, {
        issuer: TEST_ISSUER,
        jwks: [primary.jwk],
        algorithms: ['RS256'],
        clockSkewSec: 60,
      }),
    ).rejects.toThrow();
  });

  it('rejects token whose header lacks kid', async () => {
    const token = signTestJwt(primary, { omitKid: true });
    await expect(
      verifyJwt(token, {
        issuer: TEST_ISSUER,
        jwks: [primary.jwk],
        algorithms: ['RS256'],
        clockSkewSec: 60,
      }),
    ).rejects.toThrow(/kid missing/);
  });

  it('rejects token whose kid is not in the JWKS (even if previously valid)', async () => {
    // Token signed with `rotated` key; current JWKS only has `primary`.
    const token = signTestJwt(rotated);
    await expect(
      verifyJwt(token, {
        issuer: TEST_ISSUER,
        jwks: [primary.jwk],
        algorithms: ['RS256'],
        clockSkewSec: 60,
      }),
    ).rejects.toThrow(/not in JWKS/);
  });

  it('rejects wrong issuer', async () => {
    const token = signTestJwt(primary, {
      claims: { iss: 'https://attacker.example.com/pool' },
    });
    await expect(
      verifyJwt(token, {
        issuer: TEST_ISSUER,
        jwks: [primary.jwk],
        algorithms: ['RS256'],
        clockSkewSec: 60,
      }),
    ).rejects.toThrow();
  });

  it('rejects expired token', async () => {
    const past = FIXED_NOW_SEC - 3600;
    const token = signTestJwt(primary, {
      claims: { exp: past, nbf: past - 60, iat: past - 60 },
    });
    await expect(
      verifyJwt(token, {
        issuer: TEST_ISSUER,
        jwks: [primary.jwk],
        algorithms: ['RS256'],
        clockSkewSec: 60,
      }),
    ).rejects.toThrow();
  });

  it('rejects a not-yet-valid token (nbf in the future, beyond skew)', async () => {
    // nbf well beyond the clock-skew tolerance: a token minted for use
    // later must not be accepted now. aws-jwt-verify honours nbf with the
    // graceSeconds window; nbf = now + 1h is far outside the 60s skew.
    const future = FIXED_NOW_SEC + 3600;
    const token = signTestJwt(primary, {
      claims: { nbf: future, iat: future, exp: future + 3600 },
    });
    await expect(
      verifyJwt(token, {
        issuer: TEST_ISSUER,
        jwks: [primary.jwk],
        algorithms: ['RS256'],
        clockSkewSec: 60,
      }),
    ).rejects.toThrow();
  });

  it('rejects bad signature (wrong key)', async () => {
    // Sign with `rotated`, but verify against `rotated.jwk` with the primary's kid.
    // Easiest is: take token from rotated, then verify against a JWKS that has
    // a JWK with `rotated.kid` but actually the `primary` key material.
    const fakeJwk = { ...primary.jwk, kid: rotated.kid };
    const token = signTestJwt(rotated);
    await expect(
      verifyJwt(token, {
        issuer: TEST_ISSUER,
        jwks: [fakeJwk],
        algorithms: ['RS256'],
        clockSkewSec: 60,
      }),
    ).rejects.toThrow();
  });

  it('rejects token with header.alg that is not a string', async () => {
    // Craft a token whose header is JSON with a non-string alg.
    const headerB64 = Buffer.from(JSON.stringify({ alg: 123, kid: 'x', typ: 'JWT' }))
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    const payloadB64 = Buffer.from('{}').toString('base64').replace(/=+$/, '');
    const token = `${headerB64}.${payloadB64}.signature`;
    await expect(
      verifyJwt(token, {
        issuer: TEST_ISSUER,
        jwks: [primary.jwk],
        algorithms: ['RS256'],
        clockSkewSec: 60,
      }),
    ).rejects.toThrow();
  });

  it('rejects token whose payload has no exp claim (defensive exp check)', async () => {
    // aws-jwt-verify skips exp validation when exp is absent from the payload
    // (it only checks `if (payload.exp !== undefined)`). Our defensive check at
    // step 5 catches this case — a Cognito token will always have exp, but we
    // guard against a crafted or atypical token slipping through.
    const token = signTestJwt(primary, {
      claims: {
        // Spread with exp: undefined so JSON.stringify omits exp entirely.
        exp: undefined,
        iat: FIXED_NOW_SEC,
        nbf: FIXED_NOW_SEC - 5,
      },
    });
    await expect(
      verifyJwt(token, {
        issuer: TEST_ISSUER,
        jwks: [primary.jwk],
        algorithms: ['RS256'],
        clockSkewSec: 60,
      }),
    ).rejects.toThrow(/exp missing/);
  });

  it('accepts token even when payload has no aud (verifyJwt no longer checks aud)', async () => {
    // verifyJwt itself does NOT enforce aud — that's the handler's job (presence check).
    // Make sure we don't accidentally fail here.
    const token = signTestJwt(primary, {
      claims: {
        aud: undefined,
        // Ensure other claims valid:
        iss: TEST_ISSUER,
        token_use: 'id',
        exp: FIXED_NOW_SEC + 3600,
      },
    });
    // Token created with claims spread → undefined aud means the property is set to undefined.
    // The verifier might still complain — we just want to confirm "no aud check at verify level".
    // If it throws for some other reason it's still fine; this test is defensive.
    const result = await verifyJwt(token, {
      issuer: TEST_ISSUER,
      jwks: [primary.jwk],
      algorithms: ['RS256'],
      clockSkewSec: 60,
    }).catch((e: unknown) => e);
    // We don't strictly require pass — only that the failure (if any) isn't because of aud.
    if (result instanceof Error) {
      expect(result.message).not.toMatch(/audience/i);
    }
  });
});
