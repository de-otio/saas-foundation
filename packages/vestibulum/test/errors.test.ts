import { describe, it, expect } from "vitest";
import {
  VestibulumRuntimeError,
  OidcProbeError,
  SamlMetadataError,
  IdpManagerError,
  ReservedClaimError,
  MultiPoolVerifierError,
} from "../src/errors.js";

describe("errors", () => {
  describe("VestibulumRuntimeError", () => {
    it("carries name and code", () => {
      const subclass = new (class extends VestibulumRuntimeError {})("test.code", "msg");
      expect(subclass.code).toBe("test.code");
      expect(subclass.message).toBe("msg");
      expect(subclass).toBeInstanceOf(VestibulumRuntimeError);
      expect(subclass).toBeInstanceOf(Error);
    });
  });

  describe("OidcProbeError", () => {
    it.each([
      "unreachable",
      "timeout",
      "invalid_json",
      "issuer_mismatch",
      "unsupported_alg",
      "too_large",
      "not_https",
      "ssrf_blocked_destination",
      "unsupported_auth_method",
      "redirect_blocked",
      "url_too_long",
      "url_has_credentials",
    ] as const)("constructs with reason %s", (reason) => {
      const err = new OidcProbeError(reason, "detail");
      expect(err.reason).toBe(reason);
      expect(err.code).toBe(`oidc_probe.${reason}`);
      expect(err).toBeInstanceOf(VestibulumRuntimeError);
    });
  });

  describe("SamlMetadataError", () => {
    it.each([
      "invalid_xml",
      "unsigned",
      "expired",
      "unsupported_binding",
      "no_signing_cert",
      "too_large",
      "ssrf_blocked_destination",
      "redirect_blocked",
    ] as const)("constructs with reason %s", (reason) => {
      const err = new SamlMetadataError(reason, "detail");
      expect(err.reason).toBe(reason);
      expect(err.code).toBe(`saml_metadata.${reason}`);
    });
  });

  describe("IdpManagerError", () => {
    it.each([
      "name_too_long",
      "name_collision",
      "cognito_quota",
      "concurrent_modification",
      "not_found",
      "idp_identifier_invalid",
    ] as const)("constructs with reason %s", (reason) => {
      const err = new IdpManagerError(reason, "detail");
      expect(err.reason).toBe(reason);
      expect(err.code).toBe(`idp_manager.${reason}`);
    });
  });

  describe("ReservedClaimError", () => {
    it("carries claimName and references the design doc", () => {
      const err = new ReservedClaimError("iss");
      expect(err.claimName).toBe("iss");
      expect(err.code).toBe("reserved_claim");
      expect(err.message).toContain("RESERVED_CLAIMS");
    });
  });

  describe("MultiPoolVerifierError", () => {
    it.each([
      "unknown_issuer",
      "expired",
      "invalid_signature",
      "wrong_client_id",
      "wrong_token_use",
      "malformed_token",
      "wrong_pool",
    ] as const)("constructs with reason %s", (reason) => {
      const err = new MultiPoolVerifierError(reason, "detail");
      expect(err.reason).toBe(reason);
      expect(err.code).toBe(`multi_pool_verifier.${reason}`);
    });
  });

  it("all errors are instanceof VestibulumRuntimeError", () => {
    const errs = [
      new OidcProbeError("timeout", ""),
      new SamlMetadataError("unsigned", ""),
      new IdpManagerError("not_found", ""),
      new ReservedClaimError("iss"),
      new MultiPoolVerifierError("expired", ""),
    ];
    for (const err of errs) {
      expect(err).toBeInstanceOf(VestibulumRuntimeError);
      expect(err).toBeInstanceOf(Error);
    }
  });
});
