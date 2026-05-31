import { describe, expect, it } from "vitest";

import {
  CROSS_REGION_REFERENCES_DEPLOY_ROLE_PERMISSIONS,
  renderCrossRegionPermissionGuidance,
} from "../../lib/edge-resources/cross-region.js";

describe("cross-region deploy-role guidance", () => {
  it("pins the canonical least-privilege permission statement (S-C10)", () => {
    const p = CROSS_REGION_REFERENCES_DEPLOY_ROLE_PERMISSIONS;
    // Same-account, us-east-1, scoped to the CDK exports prefix — not a wildcard.
    expect(p.actions).toEqual(["ssm:GetParameter", "ssm:PutParameter"]);
    expect(p.resourcePattern).toBe(
      "arn:aws:ssm:us-east-1:<account-id>:parameter/cdk/exports/*",
    );
    expect(p.note).toContain("No cross-account grant required");
  });

  it("substitutes the account id into the guidance when one is given", () => {
    const out = renderCrossRegionPermissionGuidance("123456789012");
    expect(out).toContain("arn:aws:ssm:us-east-1:123456789012:parameter/cdk/exports/*");
    // It must not leave the placeholder behind once an id is supplied.
    expect(out).not.toContain("<account-id>");
    // Both actions and the closing note are surfaced verbatim.
    expect(out).toContain("ssm:GetParameter + ssm:PutParameter");
    expect(out).toContain(CROSS_REGION_REFERENCES_DEPLOY_ROLE_PERMISSIONS.note);
  });

  it("keeps the <account-id> placeholder when no id is given", () => {
    const out = renderCrossRegionPermissionGuidance();
    expect(out).toContain("arn:aws:ssm:us-east-1:<account-id>:parameter/cdk/exports/*");
  });
});
