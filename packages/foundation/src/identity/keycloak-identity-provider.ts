/**
 * `KeycloakIdentityProvider` — Keycloak + phasetwo (p2) adapter for the
 * {@link IdentityProviderPort} (WS-3.3).
 *
 * The REST contract is exactly the one the G2 spike proved live
 * (`trellis` spike `keycloak-magic-link`, EXIT-REPORT 2026-07-19; harness
 * `kc.ts`):
 *
 *  - **Initiate**: `POST {base}/realms/{realm}/magic-link` with a
 *    service-account (client_credentials) bearer token, body fields
 *    `email`, `client_id`, `redirect_uri`, `expiration_seconds`,
 *    `force_create`, `send_email`, `reusable`, `scope`, `state`, `nonce`,
 *    `code_challenge`, `code_challenge_method`. **`send_email` is always
 *    `false`** — the application owns the S-8 sign-in email; the IdP must
 *    never send its own vendor mail on this path (G2 C-6/F6).
 *  - **Admin**: `GET/DELETE {base}/admin/realms/{realm}/users/…` with the same
 *    service token (client's service-account role: `manage-users`).
 *  - **Sub-preserving create**: `POST {base}/admin/realms/{realm}/partialImport`
 *    — the G2 **E-1 finding (verified live on KC 26.6.3)**: `POST /users`
 *    silently REGENERATES a caller-specified `id`; `partialImport` preserves
 *    it (the imported id then appears as `sub` in issued tokens). Any
 *    sub-preserving migration must use partial-import, never per-user create.
 *    A collision pre-flight (by id, then email) fails-not-overwrites
 *    (G2 C-15b / F3).
 *
 * Fail-closed: construction throws on any missing config; no call is ever
 * attempted with a partially-resolved endpoint or credentials.
 *
 * Network is injectable (`fetchFn`) so unit tests run against a local fake —
 * no live Keycloak, no docker.
 */

import { IdentityProviderError } from "./errors.js";
import type {
  IdentityProviderPort,
  IdentityUser,
  MagicLinkInitiation,
  MagicLinkOptions,
} from "./port-types.js";

export interface KeycloakIdentityProviderConfig {
  /** Keycloak base URL, e.g. `https://id.example.com` (no trailing slash needed). */
  readonly baseUrl: string;
  /** Realm name (e.g. `skybber-dev`). */
  readonly realm: string;
  /**
   * Confidential service-account client (client_credentials grant) holding the
   * realm-management `manage-users` role — the G2 realm's `trellis-api` shape.
   */
  readonly serviceClientId: string;
  readonly serviceClientSecret: string;
  /** The PUBLIC app client the magic link authenticates against (`trellis-app`). */
  readonly appClientId: string;
  /** Injectable fetch (tests). Defaults to global `fetch`. */
  readonly fetchFn?: typeof fetch;
  /** Injectable clock, epoch ms (frozen-clock tests). Defaults to `Date.now`. */
  readonly now?: () => number;
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
}

interface MagicLinkResponse {
  user_id: string;
  link: string;
  sent: boolean;
}

/** Refresh the cached service token this many ms before its actual expiry. */
const TOKEN_EXPIRY_SLACK_MS = 30_000;

const REQUIRED_CONFIG: ReadonlyArray<
  keyof Pick<
    KeycloakIdentityProviderConfig,
    "baseUrl" | "realm" | "serviceClientId" | "serviceClientSecret" | "appClientId"
  >
> = ["baseUrl", "realm", "serviceClientId", "serviceClientSecret", "appClientId"];

export class KeycloakIdentityProvider implements IdentityProviderPort {
  private readonly cfg: KeycloakIdentityProviderConfig;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly base: string;

  private cachedToken: string | null = null;
  private cachedTokenExpiresAt = 0;

  constructor(config: KeycloakIdentityProviderConfig) {
    // Fail closed: never construct a half-configured adapter.
    for (const key of REQUIRED_CONFIG) {
      const value = config[key];
      if (typeof value !== "string" || value.length === 0) {
        throw new IdentityProviderError(
          "config_missing",
          `KeycloakIdentityProvider: required config "${key}" is missing or empty`,
        );
      }
    }
    this.cfg = config;
    this.fetchFn = config.fetchFn ?? fetch;
    this.now = config.now ?? Date.now;
    this.base = config.baseUrl.replace(/\/+$/, "");
  }

  /** The realm issuer URL (`{base}/realms/{realm}`) this adapter targets. */
  get issuerUrl(): string {
    return `${this.base}/realms/${this.cfg.realm}`;
  }

  // ── service-account token (client_credentials) ─────────────────────────────

  private async serviceToken(): Promise<string> {
    if (this.cachedToken !== null && this.now() < this.cachedTokenExpiresAt) {
      return this.cachedToken;
    }
    const res = await this.fetchFn(`${this.issuerUrl}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.cfg.serviceClientId,
        client_secret: this.cfg.serviceClientSecret,
      }),
    });
    if (!res.ok) {
      throw new IdentityProviderError(
        res.status === 401 || res.status === 403 ? "unauthorized" : "provider_error",
        `Keycloak service-account token request failed (${res.status})`,
        res.status,
      );
    }
    const body = (await res.json()) as TokenResponse;
    if (typeof body.access_token !== "string" || body.access_token.length === 0) {
      throw new IdentityProviderError(
        "provider_error",
        "Keycloak token response carried no access_token",
      );
    }
    this.cachedToken = body.access_token;
    const lifetimeMs = (body.expires_in ?? 60) * 1000;
    this.cachedTokenExpiresAt = this.now() + Math.max(0, lifetimeMs - TOKEN_EXPIRY_SLACK_MS);
    return this.cachedToken;
  }

  private async authed(path: string, init?: RequestInit): Promise<Response> {
    const token = await this.serviceToken();
    return this.fetchFn(`${this.base}${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
    });
  }

  // ── IdentityProviderPort ───────────────────────────────────────────────────

  /**
   * p2 magic-link initiation, exactly per the G2 contract. Always
   * `send_email: false` (the app owns the S-8 email) and `reusable: false`
   * (single-use, S-11).
   */
  async initiateMagicLink(email: string, opts: MagicLinkOptions): Promise<MagicLinkInitiation> {
    if (typeof email !== "string" || email.length === 0) {
      throw new IdentityProviderError("config_missing", "initiateMagicLink: email is required");
    }
    const res = await this.authed(`/realms/${this.cfg.realm}/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        client_id: this.cfg.appClientId,
        redirect_uri: opts.redirectUri,
        expiration_seconds: opts.expirationSeconds,
        force_create: opts.forceCreate ?? false,
        send_email: false, // app-owned S-8 email — never IdP-sent (G2 C-6/F6)
        reusable: false, // single-use (G2 S-11 / C-8)
        scope: "openid",
        ...(opts.state !== undefined ? { state: opts.state } : {}),
        ...(opts.nonce !== undefined ? { nonce: opts.nonce } : {}),
        ...(opts.codeChallenge !== undefined
          ? { code_challenge: opts.codeChallenge, code_challenge_method: "S256" }
          : {}),
      }),
    });
    if (res.status === 404) {
      // Unknown email with force_create=false (G2 C-13). The app decides what
      // end clients see (F10 enumeration stance) — never surface this raw.
      throw new IdentityProviderError("unknown_user", "No user for this email", 404);
    }
    if (res.status === 401 || res.status === 403) {
      throw new IdentityProviderError(
        "unauthorized",
        `Keycloak magic-link initiate rejected the service token (${res.status})`,
        res.status,
      );
    }
    if (!res.ok) {
      throw new IdentityProviderError(
        "provider_error",
        `Keycloak magic-link initiate failed (${res.status})`,
        res.status,
      );
    }
    const body = (await res.json()) as MagicLinkResponse;
    if (typeof body.link !== "string" || body.link.length === 0) {
      throw new IdentityProviderError(
        "provider_error",
        "Keycloak magic-link response carried no link",
      );
    }
    return {
      userId: body.user_id,
      link: body.link,
      emailSent: false, // send_email=false — delivery is the caller's job
    };
  }

  /**
   * Delete the user identified by email (the X6 admin surface). Resolves the
   * user by exact-match email lookup, then deletes by id. A missing user is a
   * NO-OP (idempotent delete) — documented adapter behavior; the Cognito
   * adapter throws its SDK's not-found instead (both are "best-effort" at the
   * WS-2 call sites, which swallow failures).
   */
  async deleteUser(input: { readonly email: string }): Promise<void> {
    const found = await this.findUsersByEmail(input.email);
    for (const user of found) {
      const res = await this.authed(
        `/admin/realms/${this.cfg.realm}/users/${encodeURIComponent(user.id)}`,
        { method: "DELETE" },
      );
      if (!res.ok && res.status !== 404) {
        throw new IdentityProviderError(
          res.status === 401 || res.status === 403 ? "unauthorized" : "provider_error",
          `Keycloak user delete failed (${res.status})`,
          res.status,
        );
      }
    }
  }

  // ── admin surface beyond the port (migration/ops tooling) ─────────────────

  /** Fetch a user by provider id. Returns null when absent. */
  async getUser(id: string): Promise<IdentityUser | null> {
    const res = await this.authed(
      `/admin/realms/${this.cfg.realm}/users/${encodeURIComponent(id)}`,
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new IdentityProviderError(
        res.status === 401 || res.status === 403 ? "unauthorized" : "provider_error",
        `Keycloak user fetch failed (${res.status})`,
        res.status,
      );
    }
    const body = (await res.json()) as {
      id: string;
      email?: string;
      attributes?: Record<string, string[]>;
    };
    return {
      id: body.id,
      email: body.email ?? "",
      ...(body.attributes !== undefined ? { attributes: body.attributes } : {}),
    };
  }

  /**
   * Create a user **with a caller-specified id** via `partialImport`.
   *
   * G2 E-1 (verified live, KC 26.6.3): `POST /admin/realms/{realm}/users`
   * does NOT honor a caller `id` — it silently regenerates one. Only
   * `partialImport` preserves the id, which then surfaces as `sub` in issued
   * tokens (criterion (b), C-11). Sub-preserving imports MUST come through
   * here.
   *
   * Collision pre-flight (fail-not-overwrite, C-15b): an existing user with
   * the same id or email yields `"conflict"` and the existing user is never
   * modified (`ifResourceExists: "SKIP"` as the second line of defense).
   */
  async createUser(user: IdentityUser & { readonly emailVerified?: boolean }): Promise<
    "created" | "conflict"
  > {
    const byId = await this.getUser(user.id);
    if (byId !== null) return "conflict";
    const byEmail = await this.findUsersByEmail(user.email);
    if (byEmail.length > 0) return "conflict";

    const res = await this.authed(`/admin/realms/${this.cfg.realm}/partialImport`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ifResourceExists: "SKIP",
        users: [
          {
            id: user.id,
            username: user.email,
            email: user.email,
            emailVerified: user.emailVerified ?? true,
            enabled: true,
            ...(user.attributes !== undefined ? { attributes: user.attributes } : {}),
          },
        ],
      }),
    });
    if (!res.ok) {
      throw new IdentityProviderError(
        res.status === 401 || res.status === 403 ? "unauthorized" : "provider_error",
        `Keycloak partialImport failed (${res.status})`,
        res.status,
      );
    }
    const body = (await res.json()) as { added?: number; skipped?: number };
    return body.added === 1 ? "created" : "conflict";
  }

  private async findUsersByEmail(email: string): Promise<Array<{ id: string }>> {
    if (typeof email !== "string" || email.length === 0) {
      throw new IdentityProviderError("config_missing", "email is required");
    }
    const res = await this.authed(
      `/admin/realms/${this.cfg.realm}/users?email=${encodeURIComponent(email)}&exact=true`,
    );
    if (!res.ok) {
      throw new IdentityProviderError(
        res.status === 401 || res.status === 403 ? "unauthorized" : "provider_error",
        `Keycloak user lookup failed (${res.status})`,
        res.status,
      );
    }
    return (await res.json()) as Array<{ id: string }>;
  }
}
