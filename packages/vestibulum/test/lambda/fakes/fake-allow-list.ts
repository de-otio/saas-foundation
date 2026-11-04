/**
 * In-memory `SignInAllowList` for handler tests.
 *
 * State lives here (not in call stubs), so a test can disable a person between
 * request and redemption and assert what the handler then does. `unavailable`
 * makes every call answer the closed `unavailable` error, and `calls` records
 * each question in order so tests can assert that EVERY caller class asks the
 * same questions (`signin_request_indistinguishable`).
 */

import type {
  AllowListResult,
  Eligibility,
  SignInAllowList,
} from "../../../src/lambda/shared/allow-list.js";

interface Entry {
  readonly email: string;
  readonly active: boolean;
}

export class FakeAllowList implements SignInAllowList {
  private readonly entries = new Map<string, Entry>();
  /** When true, every call answers `unavailable`. */
  unavailable = false;
  /** Questions asked, in order: `lookup` and `get` (never the argument). */
  readonly calls: string[] = [];
  /** The subjects `get` was asked about. */
  readonly gets: string[] = [];
  /** The (normalized) addresses `lookup` was asked about. Test-only: handlers never log these. */
  readonly lookups: string[] = [];

  add(subject: string, email: string, active = true): this {
    this.entries.set(subject, { email, active });
    return this;
  }

  setActive(subject: string, active: boolean): void {
    const e = this.entries.get(subject);
    if (e !== undefined) this.entries.set(subject, { ...e, active });
  }

  remove(subject: string): void {
    this.entries.delete(subject);
  }

  lookup(normalizedEmail: string): Promise<AllowListResult<Eligibility | null>> {
    this.calls.push("lookup");
    this.lookups.push(normalizedEmail);
    if (this.unavailable) return Promise.resolve({ ok: false, error: "unavailable" });
    const matches = [...this.entries].filter(([, e]) => e.email === normalizedEmail);
    const only = matches.length === 1 ? matches[0] : undefined;
    return Promise.resolve({
      ok: true,
      value: only === undefined ? null : { subject: only[0], active: only[1].active },
    });
  }

  get(subject: string): Promise<AllowListResult<Eligibility | null>> {
    this.calls.push("get");
    this.gets.push(subject);
    if (this.unavailable) return Promise.resolve({ ok: false, error: "unavailable" });
    const e = this.entries.get(subject);
    return Promise.resolve({
      ok: true,
      value: e === undefined ? null : { subject, active: e.active },
    });
  }
}
