/**
 * Property-based tests for AuditEvent shape via Zod schemas.
 *
 * AuditEvent itself has no runtime brand-checker (it's a structural
 * type with many optional fields). Validation goes through
 * `AuditEventSchema.safeParse`; the property tests assert valid
 * events parse cleanly and invalid events fail with a descriptive
 * ZodError path.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { AuditActorSchema, AuditEventSchema } from "../../src/types/frozen/schemas.js";
import { tenantId } from "../../src/types/frozen/tenant.js";

const RUN_OPTIONS = { numRuns: 1000, seed: 0xc0ffee } as const;

const validTenantChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.";

const tenantStringArb = fc
  .array(fc.constantFrom(...validTenantChars.split("")), {
    minLength: 1,
    maxLength: 32,
  })
  .map((cs) => cs.join(""));

const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 64 });

const actorArbitrary = fc.oneof(
  fc.record({
    kind: fc.constant("user" as const),
    userSub: nonEmptyStringArb,
  }),
  fc.record({
    kind: fc.constant("service" as const),
    serviceName: nonEmptyStringArb,
  }),
  fc.record({
    kind: fc.constant("system" as const),
    component: nonEmptyStringArb,
  }),
  fc.record({ kind: fc.constant("anonymous" as const) }),
);

const validEventArbitrary = fc.record(
  {
    id: nonEmptyStringArb,
    timestamp: nonEmptyStringArb,
    actor: actorArbitrary,
    action: fc.constantFrom("auth.login", "auth.logout", "data.read", "consumer.custom.action"),
    outcome: fc.constantFrom("success" as const, "failure" as const),
    severity: fc.constantFrom("info" as const, "warning" as const, "error" as const),
  },
  { requiredKeys: ["id", "timestamp", "actor", "action", "outcome", "severity"] },
);

describe("AuditEventSchema — property-based", () => {
  it("every valid event passes safeParse", () => {
    fc.assert(
      fc.property(validEventArbitrary, (event) => {
        const result = AuditEventSchema.safeParse(event);
        expect(result.success).toBe(true);
      }),
      RUN_OPTIONS,
    );
  });

  it("accepts optional tenantId when it is a valid TenantId", () => {
    fc.assert(
      fc.property(validEventArbitrary, tenantStringArb, (base, tid) => {
        const event = { ...base, tenantId: tenantId(tid) };
        const result = AuditEventSchema.safeParse(event);
        expect(result.success).toBe(true);
      }),
      RUN_OPTIONS,
    );
  });

  it("rejects tenantId values that violate the TenantId rules", () => {
    fc.assert(
      fc.property(
        validEventArbitrary,
        fc.constantFrom("", "has space", "ctrl\x01", "tab\there"),
        (base, badTid) => {
          const event = { ...base, tenantId: badTid };
          const result = AuditEventSchema.safeParse(event);
          expect(result.success).toBe(false);
          if (!result.success) {
            const paths = result.error.issues.map((i) => i.path.join("."));
            expect(paths).toContain("tenantId");
          }
        },
      ),
      RUN_OPTIONS,
    );
  });

  it("rejects events missing required fields", () => {
    const missingActor = {
      id: "01H...",
      timestamp: "2026-05-24T00:00:00.000Z",
      action: "auth.login",
      outcome: "success",
      severity: "info",
    };
    const result = AuditEventSchema.safeParse(missingActor);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("actor");
    }
  });

  it("rejects events with an out-of-band outcome", () => {
    fc.assert(
      fc.property(
        validEventArbitrary,
        fc.constantFrom("unknown", "pending", "n/a", ""),
        (base, bad) => {
          const event = { ...base, outcome: bad };
          const result = AuditEventSchema.safeParse(event);
          expect(result.success).toBe(false);
        },
      ),
      RUN_OPTIONS,
    );
  });

  it("rejects events with an out-of-band severity", () => {
    fc.assert(
      fc.property(
        validEventArbitrary,
        fc.constantFrom("debug", "fatal", "", "INFO"),
        (base, bad) => {
          const event = { ...base, severity: bad };
          const result = AuditEventSchema.safeParse(event);
          expect(result.success).toBe(false);
        },
      ),
      RUN_OPTIONS,
    );
  });

  it("AuditActorSchema rejects unknown kind", () => {
    const result = AuditActorSchema.safeParse({ kind: "robot", id: "r2d2" });
    expect(result.success).toBe(false);
  });

  it("AuditActorSchema requires userSub on kind=user", () => {
    const result = AuditActorSchema.safeParse({ kind: "user" });
    expect(result.success).toBe(false);
  });

  it("AuditActorSchema accepts kind=user with a federated idp", () => {
    const result = AuditActorSchema.safeParse({
      kind: "user",
      userSub: "abc-123",
      idp: { providerName: "Google", providerType: "OIDC" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts metadata containing JSON-safe values", () => {
    fc.assert(
      fc.property(validEventArbitrary, (base) => {
        const event = {
          ...base,
          metadata: {
            stringField: "value",
            numberField: 42,
            boolField: true,
            nullField: null,
            nestedArray: [1, "two", false],
            nestedObject: { inner: "value" },
          },
        };
        const result = AuditEventSchema.safeParse(event);
        expect(result.success).toBe(true);
      }),
      { numRuns: 100, seed: 0xc0ffee },
    );
  });
});
