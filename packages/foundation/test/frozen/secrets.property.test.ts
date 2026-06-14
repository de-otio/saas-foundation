/**
 * Property-based tests for the SecretRef brand checker.
 *
 * Generators cover both valid Secrets Manager ARN shapes
 *   arn:aws:secretsmanager:<region>:<account>:secret:<name>-<6char>
 * and a variety of malformed inputs (missing components, wrong
 * service, bad suffix, non-numeric account, whitespace).
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  SecretRefValidationError,
  isSecretRef,
  secretRef,
} from "../../src/types/frozen/secrets.js";

const RUN_OPTIONS = { numRuns: 1000, seed: 0xc0ffee } as const;

const regionArbitrary = fc.constantFrom(
  "us-east-1",
  "us-west-2",
  "eu-central-1",
  "eu-west-1",
  "ap-southeast-2",
  "sa-east-1",
);

const accountArbitrary = fc
  .integer({ min: 0, max: 999_999_999_999 })
  .map((n) => n.toString().padStart(12, "0"));

const nameArbitrary = fc
  .array(
    fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_/.-".split(""),
    ),
    { minLength: 1, maxLength: 32 },
  )
  .map((chars) => chars.join(""));

const suffixArbitrary = fc
  .array(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("")),
    { minLength: 6, maxLength: 6 },
  )
  .map((chars) => chars.join(""));

const validArnArbitrary = fc
  .tuple(regionArbitrary, accountArbitrary, nameArbitrary, suffixArbitrary)
  .map(
    ([region, account, name, suffix]) =>
      `arn:aws:secretsmanager:${region}:${account}:secret:${name}-${suffix}`,
  );

const validVersionIdArbitrary = fc.option(
  fc.string({ minLength: 1, maxLength: 64 }).filter((s) => !/\s/.test(s)),
  { nil: undefined },
);

/**
 * The validation regex (mirrored from src for the post-filter below).
 * Kept in sync manually — when secrets.ts changes the ARN pattern, this
 * mirror updates; the property tests would catch the drift on the
 * "every valid ARN passes" case, this filter just keeps the
 * invalid-generator from accidentally emitting valid ARNs.
 */
const ARN_PATTERN_MIRROR =
  /^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$/;

/** Various ways an ARN can be malformed, post-filtered to ensure they truly fail. */
const invalidArnArbitrary = fc
  .oneof(
    fc.constant(""),
    fc.constant("not-an-arn"),
    fc.constant("arn:aws:secretsmanager"),
    // wrong service
    fc
      .tuple(regionArbitrary, accountArbitrary, nameArbitrary, suffixArbitrary)
      .map(
        ([region, account, name, suffix]) =>
          `arn:aws:s3:${region}:${account}:secret:${name}-${suffix}`,
      ),
    // suffix has invalid (non-alnum) characters
    fc
      .tuple(regionArbitrary, accountArbitrary, nameArbitrary)
      .map(
        ([region, account, name]) =>
          `arn:aws:secretsmanager:${region}:${account}:secret:${name}-abc!@#`,
      ),
    // suffix too long (more than 6 chars in the FINAL segment)
    fc
      .tuple(regionArbitrary, accountArbitrary, nameArbitrary, suffixArbitrary)
      .map(
        ([region, account, name, suffix]) =>
          `arn:aws:secretsmanager:${region}:${account}:secret:${name}!${suffix}extra`,
      ),
    // non-numeric account
    fc
      .tuple(regionArbitrary, nameArbitrary, suffixArbitrary)
      .map(
        ([region, name, suffix]) =>
          `arn:aws:secretsmanager:${region}:notanaccount:secret:${name}-${suffix}`,
      ),
    // contains whitespace
    fc
      .tuple(regionArbitrary, accountArbitrary, nameArbitrary, suffixArbitrary)
      .map(
        ([region, account, name, suffix]) =>
          `arn:aws:secretsmanager:${region}:${account}:secret:${name} -${suffix}`,
      ),
  )
  .filter((s) => !ARN_PATTERN_MIRROR.test(s));

describe("secretRef / isSecretRef — property-based", () => {
  it("constructs a SecretRef for every valid ARN", () => {
    fc.assert(
      fc.property(validArnArbitrary, validVersionIdArbitrary, (arn, versionId) => {
        const result = secretRef(arn, versionId);
        expect(result.arn).toBe(arn);
        if (versionId === undefined) {
          expect(result.versionId).toBeUndefined();
        } else {
          expect(result.versionId).toBe(versionId);
        }
        expect(isSecretRef(result)).toBe(true);
      }),
      RUN_OPTIONS,
    );
  });

  it("throws SecretRefValidationError for every malformed ARN", () => {
    fc.assert(
      fc.property(invalidArnArbitrary, (arn) => {
        let thrown: unknown = null;
        try {
          secretRef(arn);
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(SecretRefValidationError);
        expect((thrown as SecretRefValidationError).name).toBe("SecretRefValidationError");
      }),
      RUN_OPTIONS,
    );
  });

  it("isSecretRef returns false for every malformed ARN wrapped in an object", () => {
    fc.assert(
      fc.property(invalidArnArbitrary, (arn) => {
        expect(isSecretRef({ arn })).toBe(false);
      }),
      RUN_OPTIONS,
    );
  });

  it("isSecretRef returns false for non-object inputs", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.constant(undefined),
        ),
        (input) => {
          expect(isSecretRef(input)).toBe(false);
        },
      ),
      RUN_OPTIONS,
    );
  });

  it("rejects empty-string versionId", () => {
    fc.assert(
      fc.property(validArnArbitrary, (arn) => {
        expect(() => secretRef(arn, "")).toThrow(SecretRefValidationError);
        expect(isSecretRef({ arn, versionId: "" })).toBe(false);
      }),
      RUN_OPTIONS,
    );
  });

  it("rejects whitespace-containing versionId", () => {
    fc.assert(
      fc.property(
        validArnArbitrary,
        fc.constantFrom(" ", "\t", "version with space", "\nleading newline"),
        (arn, badVersion) => {
          expect(() => secretRef(arn, badVersion)).toThrow(SecretRefValidationError);
          expect(isSecretRef({ arn, versionId: badVersion })).toBe(false);
        },
      ),
      RUN_OPTIONS,
    );
  });

  it("rejects non-string ARN inputs", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.constant(undefined)),
        (input) => {
          expect(() => secretRef(input as unknown as string)).toThrow(SecretRefValidationError);
        },
      ),
      RUN_OPTIONS,
    );
  });

  it("rejects non-string versionId inputs", () => {
    fc.assert(
      fc.property(validArnArbitrary, fc.oneof(fc.integer(), fc.boolean()), (arn, badVersion) => {
        expect(() => secretRef(arn, badVersion as unknown as string)).toThrow(
          SecretRefValidationError,
        );
      }),
      RUN_OPTIONS,
    );
  });

  it("isSecretRef and secretRef agree on every input (consistency)", () => {
    const inputArb = fc.oneof(validArnArbitrary, invalidArnArbitrary);
    fc.assert(
      fc.property(inputArb, validVersionIdArbitrary, (arn, versionId) => {
        let constructorSucceeded = true;
        try {
          secretRef(arn, versionId);
        } catch {
          constructorSucceeded = false;
        }
        const obj = versionId === undefined ? { arn } : { arn, versionId };
        expect(isSecretRef(obj)).toBe(constructorSucceeded);
      }),
      RUN_OPTIONS,
    );
  });

  it("returned SecretRef is frozen", () => {
    const arn = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:my-secret-abc123";
    const ref = secretRef(arn);
    expect(Object.isFrozen(ref)).toBe(true);
  });

  it("isSecretRef returns false when arn field is missing or non-string", () => {
    expect(isSecretRef({})).toBe(false);
    expect(isSecretRef({ arn: 42 })).toBe(false);
    expect(isSecretRef({ arn: null })).toBe(false);
    expect(isSecretRef({ arn: undefined })).toBe(false);
    expect(isSecretRef({ versionId: "v1" })).toBe(false);
  });

  it("isSecretRef returns false when versionId is non-string", () => {
    const validArn = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:foo-abc123";
    expect(isSecretRef({ arn: validArn, versionId: 42 })).toBe(false);
    expect(isSecretRef({ arn: validArn, versionId: null })).toBe(false);
    expect(isSecretRef({ arn: validArn, versionId: {} })).toBe(false);
  });

  it("SecretRefValidationError preserves the offending input", () => {
    const badArn = "not-an-arn";
    try {
      secretRef(badArn);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretRefValidationError);
      // The input includes both arn and versionId
      expect((err as SecretRefValidationError).input).toEqual({
        arn: badArn,
        versionId: undefined,
      });
    }
  });
});
