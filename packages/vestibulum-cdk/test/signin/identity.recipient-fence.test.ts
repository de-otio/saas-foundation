/**
 * MagicLinkIdentity — the IAM recipient fence on the Create trigger's send
 * grant (dot-notes doc/topics/passwordless-sign-in-aws/02-spec.md and 03-ses.md §4):
 *
 *   signin_mail_recipient_fenced_in_iam (I16)   ses:SendEmail only, on the identity and the configuration
 *                                               set, with exactly the configured From address; to allowed
 *                                               recipients only when `allowedRecipientPatterns` is set
 *   e2e_marker_never_mailed_in_prod (I19)       a separate explicit Deny on test-marker recipients: always
 *                                               present in admin-only mode (default markers) unless
 *                                               `allowTestRecipients`; `deniedRecipientPatterns` adds to it
 *
 * These are synth assertions on the policy document's shape. That SES honours
 * the conditions (the policy simulator, a live send to a non-allowed address
 * being AccessDenied) is a live check and is NOT claimed here.
 */

import * as cdk from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import * as route53 from "aws-cdk-lib/aws-route53";
import { describe, expect, it } from "vitest";

import {
  MagicLinkIdentity,
  MagicLinkIdentityPropsError,
  type MagicLinkIdentityProps,
} from "../../lib/magic-link-identity/index.js";
import { actionsForFunction, statementsForFunction, type Statement } from "./helpers.js";

const ENV = { account: "123456789012", region: "eu-west-1" };
const SENDER = "noreply@example.com";

function buildStack(extra: Partial<MagicLinkIdentityProps> = {}) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "S", { env: ENV });
  const zone = route53.HostedZone.fromHostedZoneAttributes(stack, "Zone", {
    hostedZoneId: "Z123456789",
    zoneName: "example.com",
  });
  new MagicLinkIdentity(stack, "Identity", {
    hostedZone: zone,
    allowedEmailDomains: ["example.com"],
    sesIdentitySender: SENDER,
    ...extra,
  });
  return stack;
}

function build(extra: Partial<MagicLinkIdentityProps> = {}) {
  return Template.fromStack(buildStack(extra));
}

/** The two markers an admin-only identity never mails unless a stage opts out. */
const DEFAULT_DENY = ["*+e2e-*@*", "*@maildummy.*"];

const asArray = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

const createFnId = (t: Template): string =>
  Object.keys(t.findResources("AWS::Lambda::Function")).find((id) => /CreateAuthFn/.test(id))!;

/** Every IAM statement in the template that mentions an SES send action. */
function sesStatements(t: Template): Statement[] {
  return Object.values(t.findResources("AWS::IAM::Policy"))
    .flatMap((p) =>
      asArray(
        (p.Properties as { PolicyDocument: { Statement: Statement | Statement[] } }).PolicyDocument
          .Statement,
      ),
    )
    .filter((s) => asArray(s.Action).some((a) => a.startsWith("ses:Send")));
}
const allows = (t: Template) => sesStatements(t).filter((s) => s.Effect === "Allow");
const denies = (t: Template) => sesStatements(t).filter((s) => s.Effect === "Deny");

describe("the Allow: ses:SendEmail from this sender only (always)", () => {
  const t = build();
  const [allow] = allows(t);

  it("is exactly one Allow statement, on SendEmail only (no SendRawEmail, no SendBulkEmail)", () => {
    expect(allows(t)).toHaveLength(1);
    expect(asArray(allow!.Action)).toEqual(["ses:SendEmail"]);
  });

  it("names the identity and the configuration set (SES authorises against both)", () => {
    const resources = JSON.stringify(allow!.Resource);
    expect(resources).toContain(":identity/example.com");
    expect(resources).toContain(":configuration-set/");
    expect(asArray(allow!.Resource as unknown[])).toHaveLength(2);
  });

  it("pins ses:FromAddress to the configured sender", () => {
    expect((allow!.Condition as Record<string, unknown>)["StringEquals"]).toEqual({
      "ses:FromAddress": SENDER,
    });
  });

  it("has no recipient condition when no allowed patterns are configured (the allow-list in code is the gate)", () => {
    expect(JSON.stringify(allow!.Condition)).not.toContain("ses:Recipients");
  });

  it("is attached to the Create trigger's role only", () => {
    for (const [id] of Object.entries(t.findResources("AWS::Lambda::Function"))) {
      const sends = actionsForFunction(t, id).has("ses:SendEmail");
      expect(sends).toBe(id === createFnId(t));
    }
  });
});

describe("the default test-marker Deny (admin-only)", () => {
  it("is ALWAYS present in admin-only mode, on both send actions, for the default markers", () => {
    for (const t of [build(), build({ allowedRecipientPatterns: ["*@example.com"] })]) {
      expect(denies(t)).toHaveLength(1);
      const [deny] = denies(t);
      expect(asArray(deny!.Action)).toEqual(["ses:SendEmail", "ses:SendRawEmail"]);
      expect(deny!.Resource).toBe("*");
      expect(deny!.Condition).toEqual({ "ForAnyValue:StringLike": { "ses:Recipients": DEFAULT_DENY } });
    }
  });

  it("allowTestRecipients: true opts out (a dev stage with a mail-capture domain): no Deny at all", () => {
    expect(denies(build({ allowTestRecipients: true }))).toEqual([]);
  });

  it("allowTestRecipients: false is the default", () => {
    expect(denies(build({ allowTestRecipients: false }))).toHaveLength(1);
  });

  it("self-signup mode has no default Deny (it is a legacy mode that never had one)", () => {
    expect(denies(build({ enrollment: "self-signup" }))).toEqual([]);
  });

  it("no Allow ever names a marker", () => {
    for (const a of allows(build())) {
      expect(JSON.stringify(a)).not.toContain("maildummy");
      expect(JSON.stringify(a)).not.toContain("e2e");
    }
  });
});

describe("a synth warning when admin-only has no allowedRecipientPatterns", () => {
  const warning = /allowedRecipientPatterns/;
  const warnings = (stack: cdk.Stack) =>
    Annotations.fromStack(stack).findWarning("*", Match.stringLikeRegexp(warning.source));

  it("warns when unset in admin-only mode", () => {
    expect(warnings(buildStack())).toHaveLength(1);
  });

  it("does not warn when set, nor in self-signup mode", () => {
    expect(warnings(buildStack({ allowedRecipientPatterns: ["*@example.com"] }))).toHaveLength(0);
    expect(warnings(buildStack({ enrollment: "self-signup" }))).toHaveLength(0);
  });
});

describe("allowedRecipientPatterns -> ForAllValues:StringLike ses:Recipients", () => {
  const patterns = ["*@example.com", "*@mail.example.org"];
  const t = build({ allowedRecipientPatterns: patterns });
  const [allow] = allows(t);
  const cond = allow!.Condition as Record<string, Record<string, unknown>>;

  it("restricts every recipient to the patterns", () => {
    expect(cond["ForAllValues:StringLike"]).toEqual({ "ses:Recipients": patterns });
  });

  it("guards the vacuous case: a call carrying no recipients at all is refused (Null ses:Recipients = false)", () => {
    expect(cond["Null"]).toEqual({ "ses:Recipients": "false" });
  });

  it("keeps the From-address pin and stays a single Allow", () => {
    expect(cond["StringEquals"]).toEqual({ "ses:FromAddress": SENDER });
    expect(allows(t)).toHaveLength(1);
  });

  it("still only ses:SendEmail", () => {
    expect(asArray(allow!.Action)).toEqual(["ses:SendEmail"]);
  });
});

describe("deniedRecipientPatterns -> additive to the default Deny (ForAnyValue:StringLike)", () => {
  const extra = ["*+qa-*", "*@sandbox.*"];

  it("admin-only: ONE Deny holding the default markers and the extra patterns", () => {
    const t = build({ deniedRecipientPatterns: extra });
    expect(denies(t)).toHaveLength(1);
    expect(denies(t)[0]!.Condition).toEqual({
      "ForAnyValue:StringLike": { "ses:Recipients": [...DEFAULT_DENY, ...extra] },
    });
  });

  it("a pattern equal to a default marker is not repeated", () => {
    const t = build({ deniedRecipientPatterns: ["*@maildummy.*", "*+qa-*"] });
    expect(denies(t)[0]!.Condition).toEqual({
      "ForAnyValue:StringLike": { "ses:Recipients": [...DEFAULT_DENY, "*+qa-*"] },
    });
  });

  it("with the opt-out, only the consumer's patterns are denied", () => {
    const t = build({ allowTestRecipients: true, deniedRecipientPatterns: extra });
    expect(denies(t)[0]!.Condition).toEqual({ "ForAnyValue:StringLike": { "ses:Recipients": extra } });
  });

  it("self-signup: only the consumer's patterns", () => {
    const t = build({ enrollment: "self-signup", deniedRecipientPatterns: extra });
    expect(denies(t)[0]!.Condition).toEqual({ "ForAnyValue:StringLike": { "ses:Recipients": extra } });
  });

  it("is on the Create trigger's role, next to the Allow, and does not change the Allow", () => {
    const t = build({ deniedRecipientPatterns: extra });
    expect(statementsForFunction(t, createFnId(t)).filter((s) => s.Effect === "Deny")).toHaveLength(1);
    expect(allows(t)).toHaveLength(1);
    expect(JSON.stringify(allows(t)[0]!.Condition)).not.toContain("ses:Recipients");
  });
});

describe("e2e_marker_never_mailed_in_prod (I19) — a production-shaped configuration", () => {
  const t = build({
    allowedRecipientPatterns: ["*@example.com"],
    deniedRecipientPatterns: ["*+e2e-*", "*@maildummy.*"],
  });

  it("has the Deny, and the maildummy domain appears in no Allow", () => {
    expect(denies(t)).toHaveLength(1);
    for (const a of allows(t)) {
      expect(JSON.stringify(a)).not.toContain("maildummy");
      expect(JSON.stringify(a)).not.toContain("e2e");
    }
    expect(JSON.stringify(denies(t)[0])).toContain("maildummy");
  });
});

describe("pattern validation (synth time)", () => {
  it("allowedRecipientPatterns: rejects an empty list, an empty entry, an entry with no @, and a non-array", () => {
    for (const bad of [[], [""], ["example.com"], ["*@example.com", "*"], "x@y", [42]]) {
      expect(() => build({ allowedRecipientPatterns: bad } as never)).toThrow(MagicLinkIdentityPropsError);
    }
  });

  it("deniedRecipientPatterns: rejects an empty list, an empty entry and a non-array — but not an entry without @ (the spec's own '*+e2e-*')", () => {
    for (const bad of [[], [""], "x@y", [42]]) {
      expect(() => build({ deniedRecipientPatterns: bad } as never)).toThrow(MagicLinkIdentityPropsError);
    }
    expect(() => build({ deniedRecipientPatterns: ["*+e2e-*"] })).not.toThrow();
  });

  it("names the offending prop and entry", () => {
    expect(() => build({ allowedRecipientPatterns: ["*"] })).toThrow(/allowedRecipientPatterns.*'\*'/s);
    expect(() => build({ deniedRecipientPatterns: [""] })).toThrow(/deniedRecipientPatterns/);
  });

  it("accepts valid patterns", () => {
    expect(() =>
      build({ allowedRecipientPatterns: ["*@example.com"], deniedRecipientPatterns: ["a@b", "*+e2e-*"] }),
    ).not.toThrow();
  });
});
