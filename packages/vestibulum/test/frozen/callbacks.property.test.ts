/**
 * Property-based tests for the vestibulum-owned frozen callback shapes.
 *
 * These types have no runtime brand-checker (they're structural shapes
 * passed to consumer callbacks). The tests assert:
 *   - Valid shapes type-check with no `any` escape hatches.
 *   - `RESERVED_CLAIMS` is honoured as a blocklist when generating
 *     `ClaimResolverOutput.claimsToAddOrOverride` keys (the runtime
 *     validator that enforces this lands in P4; the test here pins
 *     the set's content and its blocklist semantics).
 *   - `untrustedClientMetadata` is present at the expected key
 *     (the H-3 rename).
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  RESERVED_CLAIMS,
  type ClaimResolverInput,
  type ClaimResolverOutput,
  type ProvisionerInput,
} from "../../src/types/frozen/callbacks.js";

const RUN_OPTIONS = { numRuns: 1000, seed: 0xc0ffee } as const;

const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 32 });

const identityArbitrary = fc.oneof(
  fc.record({ kind: fc.constant("cognito" as const) }),
  fc.record({
    kind: fc.constant("federated" as const),
    providerName: nonEmptyStringArb,
    providerType: fc.constantFrom("OIDC" as const, "SAML" as const),
  }),
);

const stringRecordArb = fc.dictionary(nonEmptyStringArb, fc.string());

/**
 * Generator: a ClaimResolverInput-shaped object. Type assertion at
 * the end is the contract — if the generator drifts from the type,
 * tsc fails here.
 */
const claimResolverInputArbitrary = fc
  .record({
    userSub: nonEmptyStringArb,
    userAttributes: stringRecordArb,
    clientId: nonEmptyStringArb,
    triggerSource: fc.oneof(
      fc.constantFrom(
        "TokenGeneration_Authentication" as const,
        "TokenGeneration_HostedAuth" as const,
        "TokenGeneration_RefreshTokens" as const,
      ),
      // open-union extension
      nonEmptyStringArb,
    ),
    identity: identityArbitrary,
    federatedGroups: fc.array(nonEmptyStringArb, { maxLength: 8 }),
    isRefresh: fc.boolean(),
    untrustedClientMetadata: stringRecordArb,
  })
  .map((r): ClaimResolverInput => r);

const provisionerInputArbitrary = fc
  .record({
    userSub: nonEmptyStringArb,
    userAttributes: stringRecordArb,
    clientId: nonEmptyStringArb,
    triggerSource: fc.oneof(
      fc.constantFrom(
        "PostConfirmation_ConfirmSignUp" as const,
        "PostConfirmation_ConfirmForgotPassword" as const,
      ),
      nonEmptyStringArb,
    ),
    identity: identityArbitrary,
  })
  .map((r): ProvisionerInput => r);

/**
 * Generator: claim keys that are NOT reserved. Used to assert
 * RESERVED_CLAIMS works as a blocklist.
 */
const nonReservedClaimKeyArb = nonEmptyStringArb.filter((k) => !RESERVED_CLAIMS.has(k));

const claimResolverOutputArbitrary = fc
  .record(
    {
      claimsToAddOrOverride: fc.dictionary(
        nonReservedClaimKeyArb,
        fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.array(fc.string(), { maxLength: 4 })),
      ),
      claimsToSuppress: fc.array(nonEmptyStringArb, { maxLength: 4 }),
      groupsToOverride: fc.array(nonEmptyStringArb, { maxLength: 4 }),
      scopesToAdd: fc.array(nonEmptyStringArb, { maxLength: 4 }),
      scopesToSuppress: fc.array(nonEmptyStringArb, { maxLength: 4 }),
    },
    { requiredKeys: [] },
  )
  .map((r): ClaimResolverOutput => r);

describe("ClaimResolverInput / ProvisionerInput — shape", () => {
  it("every generated input has the H-3 field name `untrustedClientMetadata`", () => {
    fc.assert(
      fc.property(claimResolverInputArbitrary, (input) => {
        expect("untrustedClientMetadata" in input).toBe(true);
        // and the old name is NOT present (lint at the type level)
        expect("clientMetadata" in input).toBe(false);
      }),
      RUN_OPTIONS,
    );
  });

  it("federatedGroups is always an array", () => {
    fc.assert(
      fc.property(claimResolverInputArbitrary, (input) => {
        expect(Array.isArray(input.federatedGroups)).toBe(true);
      }),
      RUN_OPTIONS,
    );
  });

  it("identity is a discriminated union on `kind`", () => {
    fc.assert(
      fc.property(claimResolverInputArbitrary, (input) => {
        expect(["cognito", "federated"]).toContain(input.identity.kind);
        if (input.identity.kind === "federated") {
          expect(typeof input.identity.providerName).toBe("string");
          expect(["OIDC", "SAML"]).toContain(input.identity.providerType);
        }
      }),
      RUN_OPTIONS,
    );
  });

  it("ProvisionerInput omits the claim-resolver-only fields", () => {
    fc.assert(
      fc.property(provisionerInputArbitrary, (input) => {
        expect("untrustedClientMetadata" in input).toBe(false);
        expect("federatedGroups" in input).toBe(false);
        expect("isRefresh" in input).toBe(false);
      }),
      RUN_OPTIONS,
    );
  });
});

describe("ClaimResolverOutput — RESERVED_CLAIMS blocklist", () => {
  it("generator never produces reserved claim keys (round-trip)", () => {
    fc.assert(
      fc.property(claimResolverOutputArbitrary, (output) => {
        const keys = Object.keys(output.claimsToAddOrOverride ?? {});
        for (const key of keys) {
          expect(RESERVED_CLAIMS.has(key)).toBe(false);
        }
      }),
      RUN_OPTIONS,
    );
  });

  it("RESERVED_CLAIMS contains the OIDC core claims", () => {
    const oidcCore = ["sub", "iss", "aud", "exp", "iat", "auth_time", "nonce"];
    for (const claim of oidcCore) {
      expect(RESERVED_CLAIMS.has(claim)).toBe(true);
    }
  });

  it("RESERVED_CLAIMS contains the Cognito-managed identifiers", () => {
    const cognito = [
      "cognito:username",
      "cognito:groups",
      "cognito:roles",
      "cognito:preferred_role",
    ];
    for (const claim of cognito) {
      expect(RESERVED_CLAIMS.has(claim)).toBe(true);
    }
  });

  it("RESERVED_CLAIMS is frozen and cannot be mutated via add", () => {
    expect(() => {
      (RESERVED_CLAIMS as Set<string>).add("attacker-claim");
    }).toThrow(TypeError);
  });

  it("RESERVED_CLAIMS rejects delete", () => {
    expect(() => {
      (RESERVED_CLAIMS as Set<string>).delete("sub");
    }).toThrow(TypeError);
  });

  it("RESERVED_CLAIMS rejects clear", () => {
    expect(() => {
      (RESERVED_CLAIMS as Set<string>).clear();
    }).toThrow(TypeError);
  });

  it("RESERVED_CLAIMS supports read operations (has, iterate, size)", () => {
    expect(RESERVED_CLAIMS.has("sub")).toBe(true);
    expect(RESERVED_CLAIMS.has("not-a-claim")).toBe(false);
    expect(RESERVED_CLAIMS.size).toBeGreaterThan(0);
    const collected: string[] = [];
    for (const claim of RESERVED_CLAIMS) {
      collected.push(claim);
    }
    expect(collected).toContain("sub");
  });
});
