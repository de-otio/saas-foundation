/**
 * The default Cognito allow-list adapter (U6, `signin_mail_only_to_eligible`,
 * `signin_redeem_rechecks_eligibility`).
 *
 * Cognito is mocked at the SDK boundary; the assertions are about the commands
 * the adapter SENDS (filter, limit, escaping) and what it concludes from the
 * answers — in particular that an ambiguous or unverified match is never
 * picked, and that every error is the closed `unavailable`.
 */

import {
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  NotAuthorizedException,
  UserNotFoundException,
} from "@aws-sdk/client-cognito-identity-provider";
import { mockClient } from "aws-sdk-client-mock";
import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createCognitoAllowList,
  eligible,
  escapeFilterValue,
} from "../../../src/lambda/shared/allow-list.js";

const cognito = mockClient(CognitoIdentityProviderClient);
const POOL = "eu-central-1_TESTPOOL";

const list = () =>
  createCognitoAllowList({
    client: cognito as unknown as CognitoIdentityProviderClient,
    userPoolId: POOL,
  });

const user = (username: string, opts: { enabled?: boolean; verified?: string | null } = {}) => ({
  Username: username,
  Enabled: opts.enabled ?? true,
  Attributes: [
    { Name: "email", Value: "person@example.com" },
    ...(opts.verified === null ? [] : [{ Name: "email_verified", Value: opts.verified ?? "true" }]),
  ],
});

beforeEach(() => cognito.reset());

describe("eligible()", () => {
  it("is true only for an existing, active subject", () => {
    expect(eligible({ subject: "s", active: true })).toBe(true);
    expect(eligible({ subject: "s", active: false })).toBe(false);
    expect(eligible(null)).toBe(false);
  });
});

describe("lookup (address -> subject)", () => {
  it("asks ListUsers for the exact email with Limit 2, on this pool", async () => {
    cognito.on(ListUsersCommand).resolves({ Users: [] });
    await list().lookup("person@example.com");
    const input = cognito.commandCalls(ListUsersCommand)[0]!.args[0].input;
    expect(input).toEqual({
      UserPoolId: POOL,
      Filter: 'email = "person@example.com"',
      Limit: 2,
    });
  });

  it("normalises the address before it is put in the filter", async () => {
    cognito.on(ListUsersCommand).resolves({ Users: [] });
    await list().lookup("  Person@Example.COM ");
    expect(cognito.commandCalls(ListUsersCommand)[0]!.args[0].input.Filter).toBe(
      'email = "person@example.com"',
    );
  });

  it("an address that cannot be normalised is 'not on the list' and never reaches Cognito", async () => {
    for (const bad of ["", "a@b@c", 'x" OR email = "y', "no-at-sign", "a b@example.com"]) {
      const r = await list().lookup(bad);
      expect(r).toEqual({ ok: true, value: null });
    }
    expect(cognito.calls()).toHaveLength(0);
  });

  it("exactly one verified user: the subject and whether it is enabled", async () => {
    cognito.on(ListUsersCommand).resolves({ Users: [user("subject-1")] });
    expect(await list().lookup("person@example.com")).toEqual({
      ok: true,
      value: { subject: "subject-1", active: true },
    });
    cognito.on(ListUsersCommand).resolves({ Users: [user("subject-1", { enabled: false })] });
    expect(await list().lookup("person@example.com")).toEqual({
      ok: true,
      value: { subject: "subject-1", active: false },
    });
  });

  it("zero users is null", async () => {
    cognito.on(ListUsersCommand).resolves({ Users: [] });
    expect(await list().lookup("person@example.com")).toEqual({ ok: true, value: null });
    cognito.on(ListUsersCommand).resolves({});
    expect(await list().lookup("person@example.com")).toEqual({ ok: true, value: null });
  });

  it("two or more users is ambiguous: null, never one of them (even if only one is verified/enabled)", async () => {
    cognito.on(ListUsersCommand).resolves({ Users: [user("a"), user("b")] });
    expect(await list().lookup("person@example.com")).toEqual({ ok: true, value: null });
    cognito
      .on(ListUsersCommand)
      .resolves({ Users: [user("a", { enabled: false }), user("b", { verified: "false" })] });
    expect(await list().lookup("person@example.com")).toEqual({ ok: true, value: null });
  });

  it.each([["false"], [null], ["TRUE"], [""]])(
    "one user whose email_verified is %j is not on the list",
    async (verified) => {
      cognito.on(ListUsersCommand).resolves({ Users: [user("a", { verified })] });
      expect(await list().lookup("person@example.com")).toEqual({ ok: true, value: null });
    },
  );

  it("a user with no Username is not trusted", async () => {
    cognito.on(ListUsersCommand).resolves({ Users: [{ Enabled: true, Attributes: [] }] });
    expect(await list().lookup("person@example.com")).toEqual({ ok: true, value: null });
  });

  it("any error is the closed `unavailable` (never a value)", async () => {
    for (const err of [
      new Error("throttled"),
      new NotAuthorizedException({ message: "denied", $metadata: {} }),
    ]) {
      cognito.on(ListUsersCommand).rejects(err);
      expect(await list().lookup("person@example.com")).toEqual({
        ok: false,
        error: "unavailable",
      });
    }
  });
});

describe("escapeFilterValue (no filter injection through the address)", () => {
  it("escapes backslash and double quote", () => {
    expect(escapeFilterValue('a"b\\c')).toBe('a\\"b\\\\c');
  });

  it("P: after escaping, no unescaped quote or lone backslash remains", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (raw) => {
        const escaped = escapeFilterValue(raw);
        // Remove every valid escape pair; nothing special may be left over.
        expect(escaped.replace(/\\\\|\\"/g, "")).not.toMatch(/["\\]/);
      }),
      { numRuns: 300 },
    );
  });

  it("a hostile address that survives normalisation cannot close the quoted literal", async () => {
    cognito.on(ListUsersCommand).resolves({ Users: [] });
    // One @, no whitespace: passes normalisation, so it IS sent — escaped.
    await list().lookup('a"or"b@example.com');
    const filter = cognito.commandCalls(ListUsersCommand)[0]!.args[0].input.Filter!;
    expect(filter).toBe('email = "a\\"or\\"b@example.com"');
  });
});

describe("get (subject -> state)", () => {
  it("reads the user by subject on this pool", async () => {
    cognito.on(AdminGetUserCommand).resolves({
      Enabled: true,
      UserAttributes: [{ Name: "email_verified", Value: "true" }],
    });
    expect(await list().get("subject-1")).toEqual({
      ok: true,
      value: { subject: "subject-1", active: true },
    });
    expect(cognito.commandCalls(AdminGetUserCommand)[0]!.args[0].input).toEqual({
      UserPoolId: POOL,
      Username: "subject-1",
    });
  });

  it("a disabled user is inactive", async () => {
    cognito.on(AdminGetUserCommand).resolves({
      Enabled: false,
      UserAttributes: [{ Name: "email_verified", Value: "true" }],
    });
    expect(await list().get("s")).toEqual({ ok: true, value: { subject: "s", active: false } });
  });

  it.each([["false"], [undefined]])("an enabled user whose email_verified is %j is inactive", async (v) => {
    cognito.on(AdminGetUserCommand).resolves({
      Enabled: true,
      UserAttributes: v === undefined ? [] : [{ Name: "email_verified", Value: v }],
    });
    expect(await list().get("s")).toEqual({ ok: true, value: { subject: "s", active: false } });
  });

  it("UserNotFoundException is null (the subject is gone)", async () => {
    cognito.on(AdminGetUserCommand).rejects(new UserNotFoundException({ message: "no", $metadata: {} }));
    expect(await list().get("phantom")).toEqual({ ok: true, value: null });
  });

  it("an error that only carries the name UserNotFoundException is also null (second SDK copy)", async () => {
    const err = Object.assign(new Error("x"), { name: "UserNotFoundException" });
    cognito.on(AdminGetUserCommand).rejects(err);
    expect(await list().get("phantom")).toEqual({ ok: true, value: null });
  });

  it("any other error is `unavailable`, never null and never active", async () => {
    cognito.on(AdminGetUserCommand).rejects(new Error("boom"));
    expect(await list().get("s")).toEqual({ ok: false, error: "unavailable" });
    cognito
      .on(AdminGetUserCommand)
      .rejects(new NotAuthorizedException({ message: "denied", $metadata: {} }));
    expect(await list().get("s")).toEqual({ ok: false, error: "unavailable" });
  });

  it("a non-Error rejection is `unavailable`", async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    cognito.on(AdminGetUserCommand).callsFake(() => Promise.reject("string"));
    expect(await list().get("s")).toEqual({ ok: false, error: "unavailable" });
  });
});
