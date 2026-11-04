/**
 * The sign-in allow-list port (`signin_mail_only_to_eligible`,
 * `signin_redeem_rechecks_eligibility`, U6) and its default Cognito adapter.
 *
 * Dot-notes `doc/topics/passwordless-sign-in-aws/02-spec.md` §9 defines the
 * contract. The consumer owns the allow-list; vestibulum only asks two
 * questions of it:
 *
 * - `lookup(normalizedEmail)` — at `/auth-login`: which subject, if any, does
 *   this address belong to? (the answer picks the `InitiateAuth` username)
 * - `get(subject)` — in the Create trigger (issue) and the Verify trigger
 *   (redeem): is this subject eligible right now?
 *
 * Every answer is either a value or `{ ok: false, error: "unavailable" }`.
 * An `unavailable` answer is NEVER treated as eligible (`signin_fails_closed`).
 */

import {
  AdminGetUserCommand,
  ListUsersCommand,
  UserNotFoundException,
  type CognitoIdentityProviderClient,
  type AttributeType,
} from "@aws-sdk/client-cognito-identity-provider";

import { normalizeEmail } from "./normalize-email.js";

/** One subject's current state in the allow-list. */
export type Eligibility = {
  /** The Cognito username. Immutable; the value `InitiateAuth` takes. */
  readonly subject: string;
  /** Whether the subject may sign in right now. */
  readonly active: boolean;
};

/** A value, or the closed `unavailable` error (a dependency failed). */
export type AllowListResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: "unavailable" };

/**
 * The allow-list a consumer provides.
 *
 * **Roles are the consumer's.** The spec's `eligible` predicate also requires
 * `roles ≠ ∅`; vestibulum has no notion of roles, so the consumer's admin path
 * MUST disable the Cognito user (`AdminDisableUser`) in the same operation that
 * ends eligibility (`disable_ends_sessions`). The default
 * {@link createCognitoAllowList} maps `active` to "the Cognito user is enabled
 * and its email is verified".
 */
export interface SignInAllowList {
  /**
   * Normalized address → subject, or `null` when the address is not on the
   * list (or is ambiguous). Must be a strongly consistent read.
   */
  lookup(normalizedEmail: string): Promise<AllowListResult<Eligibility | null>>;
  /** Subject → current state; `null` when the subject is gone. */
  get(subject: string): Promise<AllowListResult<Eligibility | null>>;
}

/** The only predicate any caller may use: a missing or inactive subject is not eligible. */
export const eligible = (e: Eligibility | null): boolean => e !== null && e.active;

const UNAVAILABLE = { ok: false, error: "unavailable" } as const;

function attr(attrs: readonly AttributeType[] | undefined, name: string): string | undefined {
  return attrs?.find((a) => a.Name === name)?.Value;
}

/** Escapes a value for a Cognito `ListUsers` filter string literal. */
export function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export interface CognitoAllowListOptions {
  readonly client: CognitoIdentityProviderClient;
  readonly userPoolId: string;
}

/**
 * The allow-list backed by the pool's own users, for the default
 * `enrollment: "admin-only"` mode: a person is on the list when an
 * administrator created a Cognito user for them with a verified email.
 *
 * - `lookup` lists users by exact `email` (Cognito's filter is case-sensitive,
 *   so users must be created with the normalized, lower-case address). Exactly
 *   one user, with `email_verified = "true"`, is a match. Zero users, an
 *   unverified user, or two or more users (ambiguous — never pick one) are
 *   "not on the list".
 * - `get` reads the user by subject.
 *
 * Any other error is `unavailable`.
 */
export function createCognitoAllowList(options: CognitoAllowListOptions): SignInAllowList {
  const { client, userPoolId } = options;
  return {
    async lookup(normalizedEmail) {
      const address = normalizeEmail(normalizedEmail);
      if (address === undefined) return { ok: true, value: null };
      try {
        const out = await client.send(
          new ListUsersCommand({
            UserPoolId: userPoolId,
            Filter: `email = "${escapeFilterValue(address)}"`,
            // Two is enough to see ambiguity; never read the whole pool.
            Limit: 2,
          }),
        );
        const users = out.Users ?? [];
        const only = users.length === 1 ? users[0] : undefined;
        if (only?.Username === undefined || only.Username === "") return { ok: true, value: null };
        if (attr(only.Attributes, "email_verified") !== "true") return { ok: true, value: null };
        return { ok: true, value: { subject: only.Username, active: only.Enabled === true } };
      } catch {
        return UNAVAILABLE;
      }
    },

    async get(subject) {
      try {
        const out = await client.send(
          new AdminGetUserCommand({ UserPoolId: userPoolId, Username: subject }),
        );
        const verified = attr(out.UserAttributes, "email_verified") === "true";
        return {
          ok: true,
          value: { subject, active: out.Enabled === true && verified },
        };
      } catch (err) {
        // By name as well: a second copy of the SDK would fail `instanceof`.
        if (err instanceof UserNotFoundException || (err instanceof Error && err.name === "UserNotFoundException")) {
          return { ok: true, value: null };
        }
        return UNAVAILABLE;
      }
    },
  };
}
