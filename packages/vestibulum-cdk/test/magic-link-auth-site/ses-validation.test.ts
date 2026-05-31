/**
 * Tests for the SES sender-domain validation helper.
 *
 * Per the integrated security review (S-C11): a sender domain that
 * does not match the Route53 hosted zone is a deploy-time DKIM / SPF
 * failure. The helper fires at synth time so consumers see the error
 * before they deploy.
 */

import { describe, expect, it } from "vitest";

import {
  SesSenderDomainMismatchError,
  SesSenderShapeError,
  extractSenderDomain,
  validateSenderAgainstZone,
} from "../../lib/magic-link-auth-site/ses-validation.js";

describe("extractSenderDomain", () => {
  it("extracts the domain part of a well-formed address", () => {
    expect(extractSenderDomain("noreply@example.com")).toBe("example.com");
  });

  it("lowercases the domain", () => {
    expect(extractSenderDomain("Auth@Example.COM")).toBe("example.com");
  });

  it.each(["", "noreply", "@example.com", "noreply@", "@", "double@at@example.com"])(
    "throws SesSenderShapeError for malformed input %s",
    (input) => {
      expect(() => extractSenderDomain(input)).toThrowError(SesSenderShapeError);
    },
  );
});

describe("validateSenderAgainstZone", () => {
  it("accepts a sender whose domain equals the zone name", () => {
    expect(() => validateSenderAgainstZone("noreply@example.com", "example.com")).not.toThrow();
  });

  it("accepts a sender on a subdomain of the zone", () => {
    expect(() =>
      validateSenderAgainstZone("noreply@auth.example.com", "example.com"),
    ).not.toThrow();
  });

  it("tolerates a trailing dot on the zone name", () => {
    expect(() => validateSenderAgainstZone("noreply@example.com", "example.com.")).not.toThrow();
  });

  it("is case-insensitive on both sides", () => {
    expect(() => validateSenderAgainstZone("Auth@Example.COM", "EXAMPLE.com")).not.toThrow();
  });

  it("throws SesSenderDomainMismatchError when the domain is unrelated", () => {
    expect(() => validateSenderAgainstZone("noreply@other.org", "example.com")).toThrowError(
      SesSenderDomainMismatchError,
    );
  });

  it("throws when the sender is on a similarly-named but distinct domain", () => {
    // 'evil-example.com' is NOT a subdomain of 'example.com'.
    expect(() => validateSenderAgainstZone("noreply@evil-example.com", "example.com")).toThrowError(
      SesSenderDomainMismatchError,
    );
  });

  it("skips the check when the sender looks like a CDK token", () => {
    expect(() => validateSenderAgainstZone("${Token[123]}", "example.com")).not.toThrow();
  });

  it("skips the check when the zone name looks like a CDK token", () => {
    expect(() => validateSenderAgainstZone("noreply@example.com", "${Token[123]}")).not.toThrow();
  });

  it("error includes both the sender domain and the zone name", () => {
    try {
      validateSenderAgainstZone("noreply@other.org", "example.com");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SesSenderDomainMismatchError);
      const e = err as SesSenderDomainMismatchError;
      expect(e.name).toBe("SesSenderDomainMismatchError");
      expect(e.message).toContain("other.org");
      expect(e.message).toContain("example.com");
    }
  });
});
