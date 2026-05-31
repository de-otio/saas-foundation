/**
 * Tests for extractTenantSubdomain (review fix H1).
 *
 * Spec: doc/vestibulum/shared-distribution/04-multi-aud-edge-check.md
 *       § Subdomain extraction.
 *
 * Covers all 13 spec test cases (11 originals + 2 new trailing-dot cases)
 * plus property-based tests for valid and invalid inputs.
 *
 * Coverage target: 100 % branch.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { extractTenantSubdomain } from '../../../src/lambda/shared-distribution/shared/extract-tenant-subdomain.js';

const PARENT = 'tenants.example.com';
const RUN_OPTIONS = { numRuns: 1000, seed: 0xc0ffee } as const;

// ---------------------------------------------------------------------------
// 13 spec test cases
// ---------------------------------------------------------------------------

describe('extractTenantSubdomain — spec test cases', () => {
  // Case 1
  it('basic subdomain → returns label', () => {
    expect(extractTenantSubdomain('acme.tenants.example.com', PARENT)).toBe('acme');
  });

  // Case 2
  it('uppercase input → lowercased label', () => {
    expect(extractTenantSubdomain('ACME.TENANTS.EXAMPLE.COM', PARENT)).toBe('acme');
  });

  // Case 3
  it('port is stripped before matching', () => {
    expect(extractTenantSubdomain('acme.tenants.example.com:443', PARENT)).toBe('acme');
  });

  // Case 4 — trailing dot (bold in spec, review fix H1)
  it('trailing dot is stripped (FQDN form)', () => {
    expect(extractTenantSubdomain('acme.tenants.example.com.', PARENT)).toBe('acme');
  });

  // Case 5 — trailing dot + port (bold in spec, review fix H1)
  it('trailing dot + port → both stripped, label returned', () => {
    expect(extractTenantSubdomain('acme.tenants.example.com.:443', PARENT)).toBe('acme');
  });

  // Case 6
  it('multi-level subdomain → null (not a direct child)', () => {
    expect(extractTenantSubdomain('acme.bob.tenants.example.com', PARENT)).toBeNull();
  });

  // Case 7
  it('parent apex (no subdomain) → null', () => {
    expect(extractTenantSubdomain('tenants.example.com', PARENT)).toBeNull();
  });

  // Case 8
  it('empty label (leading dot before parent) → null', () => {
    expect(extractTenantSubdomain('.tenants.example.com', PARENT)).toBeNull();
  });

  // Case 9
  it('leading dot in subdomain → null', () => {
    expect(extractTenantSubdomain('.acme.tenants.example.com', PARENT)).toBeNull();
  });

  // Case 10
  it('trailing dash in label → null (fails pattern)', () => {
    expect(extractTenantSubdomain('acme-.tenants.example.com', PARENT)).toBeNull();
  });

  // Case 11
  it('leading digit in label → null (fails pattern)', () => {
    expect(extractTenantSubdomain('1acme.tenants.example.com', PARENT)).toBeNull();
  });

  // Case 12
  it('wrong parent domain → null', () => {
    expect(extractTenantSubdomain('acme.evil.com', PARENT)).toBeNull();
  });

  // Case 13
  it('correctly-named subdomain with a substring match is accepted', () => {
    // "evilacme" happens to contain "acme" but that does not affect extraction.
    expect(extractTenantSubdomain('evilacme.tenants.example.com', PARENT)).toBe('evilacme');
  });
});

// ---------------------------------------------------------------------------
// Additional edge cases for branch coverage
// ---------------------------------------------------------------------------

describe('extractTenantSubdomain — edge cases', () => {
  it('undefined host → null', () => {
    expect(extractTenantSubdomain(undefined, PARENT)).toBeNull();
  });

  it('empty string host → null', () => {
    expect(extractTenantSubdomain('', PARENT)).toBeNull();
  });

  it('parent with trailing dot is normalised at call time', () => {
    // Parent trailing dot stripped before matching.
    expect(extractTenantSubdomain('acme.tenants.example.com', 'tenants.example.com.')).toBe('acme');
  });

  it('custom pattern is respected', () => {
    // Minimal pattern: single lowercase char.
    const singleChar = /^[a-z]$/;
    expect(extractTenantSubdomain('a.tenants.example.com', PARENT, singleChar)).toBe('a');
    // Default pattern rejects single char — min length is 3.
    expect(extractTenantSubdomain('a.tenants.example.com', PARENT)).toBeNull();
  });

  it('port-only host (no domain) → null', () => {
    expect(extractTenantSubdomain(':443', PARENT)).toBeNull();
  });

  it('host without colon → first element of split is the full host', () => {
    // Exercises the split(':')[0] path when no colon is present (no port stripping needed).
    expect(extractTenantSubdomain('acme.tenants.example.com', PARENT)).toBe('acme');
  });

  it('exact parent match with trailing port → null (no label)', () => {
    expect(extractTenantSubdomain('tenants.example.com:443', PARENT)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('extractTenantSubdomain — property tests', () => {
  /** Generator for valid tenant subdomain labels. */
  const validLabel = (): fc.Arbitrary<string> =>
    fc
      .tuple(
        fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), {
          minLength: 1,
          maxLength: 1,
        }),
        fc.stringOf(
          fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
          { minLength: 1, maxLength: 61 },
        ),
        fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
          minLength: 1,
          maxLength: 1,
        }),
      )
      .map(([a, m, z]) => `${a}${m}${z}`);

  it('valid label → extractTenantSubdomain returns that label', () => {
    fc.assert(
      fc.property(validLabel(), (label) => {
        const host = `${label}.${PARENT}`;
        const result = extractTenantSubdomain(host, PARENT);
        expect(result).toBe(label);
      }),
      RUN_OPTIONS,
    );
  });

  it('valid label with trailing dot → same label returned', () => {
    fc.assert(
      fc.property(validLabel(), (label) => {
        const host = `${label}.${PARENT}.`;
        const result = extractTenantSubdomain(host, PARENT);
        expect(result).toBe(label);
      }),
      RUN_OPTIONS,
    );
  });

  it('wrong parent → always null', () => {
    fc.assert(
      fc.property(
        fc.domain().filter((d) => !d.endsWith(PARENT)),
        (wrongHost) => {
          expect(extractTenantSubdomain(wrongHost, PARENT)).toBeNull();
        },
      ),
      RUN_OPTIONS,
    );
  });

  it('multi-level subdomain (two dots before parent) → always null', () => {
    fc.assert(
      fc.property(
        validLabel(),
        validLabel(),
        (a, b) => {
          const host = `${a}.${b}.${PARENT}`;
          expect(extractTenantSubdomain(host, PARENT)).toBeNull();
        },
      ),
      RUN_OPTIONS,
    );
  });
});
