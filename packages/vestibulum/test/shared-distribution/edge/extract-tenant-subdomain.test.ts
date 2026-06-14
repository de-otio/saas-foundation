/**
 * Edge-side tests for tenant-subdomain extraction.
 *
 * The handler wraps P1a's structural `extractTenantSubdomain(host, parent)`
 * with normalisation (lowercase, port strip, trailing-dot strip — review H1)
 * and the synth-time `TENANT_PATTERN` check. This file covers the 13 cases
 * from `04-multi-aud-edge-check.md` (11 originals + 2 trailing-dot ones).
 *
 * The P1a test suite covers the structural piece in isolation; this file
 * asserts the integration matches the spec end-to-end.
 */

import { describe, expect, it } from 'vitest';

import {
  extractTenantSubdomain,
  normalizeHost,
} from '../../../src/lambda/shared-distribution/edge/check-auth.js';

const PARENT = 'tenants.example.com';
const PATTERN = /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/;

describe('extractTenantSubdomain (edge-side, pattern applied)', () => {
  it.each<[string, string | null]>([
    ['acme.tenants.example.com', 'acme'],
    ['ACME.TENANTS.EXAMPLE.COM', 'acme'],
    ['acme.tenants.example.com:443', 'acme'],
    ['acme.tenants.example.com.', 'acme'],
    ['acme.tenants.example.com.:443', 'acme'],
    ['acme.bob.tenants.example.com', null],
    ['tenants.example.com', null],
    ['.tenants.example.com', null],
    ['.acme.tenants.example.com', null],
    ['acme-.tenants.example.com', null],
    ['1acme.tenants.example.com', null],
    ['acme.evil.com', null],
    ['evilacme.tenants.example.com', 'evilacme'],
  ])('host=%s → %s', (host, expected) => {
    expect(extractTenantSubdomain(host, PARENT, PATTERN)).toBe(expected);
  });

  it('returns null for undefined host', () => {
    expect(extractTenantSubdomain(undefined, PARENT, PATTERN)).toBeNull();
  });

  it('returns null for empty host', () => {
    expect(extractTenantSubdomain('', PARENT, PATTERN)).toBeNull();
  });

  it('returns null when label fails the pattern (e.g. uppercase residue)', () => {
    // Constructive: a pattern that rejects single-character labels.
    const tight = /^[a-z]{4,}$/;
    expect(extractTenantSubdomain('ab.tenants.example.com', PARENT, tight)).toBeNull();
  });
});

describe('normalizeHost', () => {
  it('lowercases', () => {
    expect(normalizeHost('ACME.TENANTS.EXAMPLE.COM')).toBe('acme.tenants.example.com');
  });

  it('strips port', () => {
    expect(normalizeHost('acme.tenants.example.com:443')).toBe('acme.tenants.example.com');
  });

  it('strips trailing dot', () => {
    expect(normalizeHost('acme.tenants.example.com.')).toBe('acme.tenants.example.com');
  });

  it('strips trailing dot + port', () => {
    expect(normalizeHost('acme.tenants.example.com.:443')).toBe('acme.tenants.example.com');
  });

  it('handles already-normalised host', () => {
    expect(normalizeHost('acme.tenants.example.com')).toBe('acme.tenants.example.com');
  });
});
