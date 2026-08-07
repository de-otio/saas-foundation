/**
 * KeycloakIdentityProvider unit tests against a LOCAL FAKE (no live Keycloak,
 * no docker): an injected `fetchFn` implementing the exact endpoints the G2
 * spike proved (token, p2 magic-link, admin users, partialImport).
 *
 * The fake asserts the REST *contract* (paths, bodies, auth headers) — the
 * load-bearing checks are `send_email: false` (app-owned S-8 email),
 * `reusable: false` (single-use), partialImport-not-POST-/users (G2 E-1), and
 * the collision pre-flight (fail-not-overwrite, C-15b).
 */

import { describe, expect, it } from "vitest";

import {
  IdentityProviderError,
  KeycloakIdentityProvider,
  type IdentityProviderPort,
  type KeycloakIdentityProviderConfig,
} from "../../src/identity/index.js";

const BASE = "https://id.example.test";
const REALM = "skybber-dev";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

interface FakeKeycloakState {
  /** users by id */
  users: Map<string, { id: string; email: string; attributes?: Record<string, string[]> }>;
  tokenCalls: number;
  tokenExpiresIn: number;
  /** When set, the magic-link endpoint returns this HTTP status. */
  magicLinkStatus?: number;
  /** [F3] User Profile config `attributes` returned by GET .../users/profile. */
  profileAttributes?: Array<{
    name?: string;
    permissions?: { edit?: string[]; view?: string[] };
  }>;
  /** [F3] When set, the users/profile endpoint returns this HTTP status. */
  profileStatus?: number;
  requests: RecordedRequest[];
}

function makeFake(state: FakeKeycloakState): typeof fetch {
  return (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.href;
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const rawBody = init?.body;
    let body: unknown;
    if (typeof rawBody === "string") {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    } else if (rawBody instanceof URLSearchParams) {
      body = Object.fromEntries(rawBody.entries());
    }
    state.requests.push({ url, method, headers, body });

    const json = (status: number, payload: unknown): Response =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });

    // token endpoint
    if (url === `${BASE}/realms/${REALM}/protocol/openid-connect/token`) {
      state.tokenCalls += 1;
      const form = body as Record<string, string>;
      if (form.grant_type !== "client_credentials") return json(400, { error: "bad grant" });
      if (form.client_secret !== "svc-secret") return json(401, { error: "bad secret" });
      return json(200, {
        access_token: `svc-token-${state.tokenCalls}`,
        expires_in: state.tokenExpiresIn,
      });
    }

    const authed = headers["authorization"]?.startsWith("Bearer svc-token-") === true;

    // p2 magic-link
    if (url === `${BASE}/realms/${REALM}/magic-link` && method === "POST") {
      if (!authed) return json(401, { error: "unauthorized" });
      if (state.magicLinkStatus !== undefined) {
        return json(state.magicLinkStatus, { error: "forced" });
      }
      const req = body as { email: string };
      const user = [...state.users.values()].find((u) => u.email === req.email);
      if (!user) return json(404, { error: "user not found" });
      return json(200, {
        user_id: user.id,
        link: `${BASE}/realms/${REALM}/login-actions/action-token?key=tok-${user.id}`,
        sent: false,
      });
    }

    // admin: lookup by email
    const lookupPrefix = `${BASE}/admin/realms/${REALM}/users?email=`;
    if (url.startsWith(lookupPrefix) && method === "GET") {
      if (!authed) return json(401, {});
      const email = decodeURIComponent(url.slice(lookupPrefix.length).replace(/&exact=true$/, ""));
      const found = [...state.users.values()].filter((u) => u.email === email);
      return json(200, found);
    }

    // [F3] admin: User Profile config (checked BEFORE the /users/{id} regex,
    // which would otherwise treat "profile" as a user id).
    if (url === `${BASE}/admin/realms/${REALM}/users/profile` && method === "GET") {
      if (!authed) return json(401, {});
      if (state.profileStatus !== undefined) return json(state.profileStatus, { error: "forced" });
      return json(200, { attributes: state.profileAttributes ?? [] });
    }

    // admin: get / delete by id
    const userMatch = url.match(
      new RegExp(`^${BASE}/admin/realms/${REALM}/users/([^/?]+)$`),
    );
    if (userMatch) {
      if (!authed) return json(401, {});
      const id = decodeURIComponent(userMatch[1]!);
      const user = state.users.get(id);
      if (method === "GET") {
        return user ? json(200, user) : json(404, {});
      }
      if (method === "DELETE") {
        if (!user) return json(404, {});
        state.users.delete(id);
        return new Response(null, { status: 204 });
      }
    }

    // admin: partialImport (the ONLY id-preserving create — G2 E-1)
    // POST /users — what a `manage-users` service account may do. The fake
    // assigns the id itself, exactly as Keycloak does (G2 E-1).
    if (url === `${BASE}/admin/realms/${REALM}/users` && method === "POST") {
      const req = (body ?? {}) as {
        email: string;
        emailVerified?: boolean;
        attributes?: Record<string, string[]>;
      };
      if ([...state.users.values()].some((u) => u.email === req.email)) {
        return json(409, { errorMessage: "User exists with same email" });
      }
      const id = `kc-generated-${state.users.size + 1}`;
      state.users.set(id, {
        id,
        email: req.email,
        ...(req.attributes !== undefined ? { attributes: req.attributes } : {}),
      });
      return json(201, {});
    }

    if (url === `${BASE}/admin/realms/${REALM}/partialImport` && method === "POST") {
      if (!authed) return json(401, {});
      const req = body as {
        ifResourceExists: string;
        users: Array<{ id: string; email: string; attributes?: Record<string, string[]> }>;
      };
      let added = 0;
      let skipped = 0;
      for (const u of req.users) {
        if (state.users.has(u.id)) {
          skipped += 1;
          continue;
        }
        state.users.set(u.id, {
          id: u.id,
          email: u.email,
          ...(u.attributes !== undefined ? { attributes: u.attributes } : {}),
        });
        added += 1;
      }
      return json(200, { added, skipped });
    }

    return json(500, { error: `fake: unhandled ${method} ${url}` });
  }) as typeof fetch;
}

function makeProvider(
  state: FakeKeycloakState,
  overrides: Partial<KeycloakIdentityProviderConfig> = {},
): KeycloakIdentityProvider {
  return new KeycloakIdentityProvider({
    baseUrl: BASE,
    realm: REALM,
    serviceClientId: "trellis-api",
    serviceClientSecret: "svc-secret",
    appClientId: "trellis-app",
    fetchFn: makeFake(state),
    ...overrides,
  });
}

function freshState(): FakeKeycloakState {
  return {
    users: new Map([
      ["u-1", { id: "u-1", email: "user1@example.test" }],
    ]),
    tokenCalls: 0,
    tokenExpiresIn: 300,
    requests: [],
  };
}

const LINK_OPTS = {
  expirationSeconds: 300,
  redirectUri: "https://app.example.test/auth/verify",
  state: "st",
  nonce: "no",
  codeChallenge: "chal",
} as const;

describe("KeycloakIdentityProvider", () => {
  describe("fail-closed construction", () => {
    for (const key of [
      "baseUrl",
      "realm",
      "serviceClientId",
      "serviceClientSecret",
      "appClientId",
    ] as const) {
      it(`throws config_missing when ${key} is empty`, () => {
        const state = freshState();
        expect(() => makeProvider(state, { [key]: "" })).toThrowError(IdentityProviderError);
        try {
          makeProvider(state, { [key]: "" });
        } catch (err) {
          expect((err as IdentityProviderError).reason).toBe("config_missing");
        }
      });
    }
  });

  describe("initiateMagicLink (p2 contract)", () => {
    it("sends the exact G2 body — send_email=false, reusable=false, S256", async () => {
      const state = freshState();
      const provider = makeProvider(state);
      const result = await provider.initiateMagicLink("user1@example.test", LINK_OPTS);

      expect(result.userId).toBe("u-1");
      expect(result.link).toContain("/login-actions/action-token");
      expect(result.emailSent).toBe(false);

      const call = state.requests.find((r) => r.url.endsWith("/magic-link"));
      expect(call).toBeDefined();
      expect(call!.body).toEqual({
        email: "user1@example.test",
        client_id: "trellis-app",
        redirect_uri: LINK_OPTS.redirectUri,
        expiration_seconds: 300,
        force_create: false,
        send_email: false, // load-bearing: app-owned S-8 email
        reusable: false, // load-bearing: single-use (S-11)
        scope: "openid",
        state: "st",
        nonce: "no",
        code_challenge: "chal",
        code_challenge_method: "S256",
      });
    });

    it("maps an unknown email (404, force_create=false) to unknown_user", async () => {
      const state = freshState();
      const provider = makeProvider(state);
      await expect(
        provider.initiateMagicLink("nobody@example.test", LINK_OPTS),
      ).rejects.toMatchObject({ reason: "unknown_user", status: 404 });
    });

    it("maps a 403 to unauthorized and a 500 to provider_error", async () => {
      const state = freshState();
      const provider = makeProvider(state);
      state.magicLinkStatus = 403;
      await expect(
        provider.initiateMagicLink("user1@example.test", LINK_OPTS),
      ).rejects.toMatchObject({ reason: "unauthorized" });
      state.magicLinkStatus = 500;
      await expect(
        provider.initiateMagicLink("user1@example.test", LINK_OPTS),
      ).rejects.toMatchObject({ reason: "provider_error" });
    });
  });

  describe("service-token error handling (F5 — secret must not leak)", () => {
    it("wraps a raw fetch rejection in a clean, secret-free provider_error", async () => {
      const secret = "svc-secret-super-sensitive";
      // A fetch impl whose rejection ECHOES the request body (which carries the
      // client_secret) — the exact leak F5 guards against.
      const leakyFetch = (async (_input: string | URL, init?: RequestInit) => {
        throw new Error(
          `ECONNREFUSED — request body was ${init?.body == null ? "" : String(init.body as string | URLSearchParams)} (client_secret=${secret})`,
        );
      }) as unknown as typeof fetch;

      const provider = new KeycloakIdentityProvider({
        baseUrl: BASE,
        realm: REALM,
        serviceClientId: "trellis-api",
        serviceClientSecret: secret,
        appClientId: "trellis-app",
        fetchFn: leakyFetch,
      });

      let caught: unknown;
      try {
        await provider.initiateMagicLink("user1@example.test", LINK_OPTS);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(IdentityProviderError);
      const e = caught as IdentityProviderError;
      expect(e.reason).toBe("provider_error");
      expect(e.message).toBe("Keycloak token endpoint unreachable");
      // The raw error (which carried the secret) must NOT propagate.
      expect(e.message).not.toContain(secret);
      expect(e.message).not.toContain("ECONNREFUSED");
    });
  });

  describe("service-token caching", () => {
    it("reuses the token within its lifetime and refreshes after expiry", async () => {
      const state = freshState();
      let nowMs = 1_000_000;
      const provider = makeProvider(state, { now: () => nowMs });

      await provider.initiateMagicLink("user1@example.test", LINK_OPTS);
      await provider.initiateMagicLink("user1@example.test", LINK_OPTS);
      expect(state.tokenCalls).toBe(1); // cached

      nowMs += 300_000; // past expires_in
      await provider.initiateMagicLink("user1@example.test", LINK_OPTS);
      expect(state.tokenCalls).toBe(2); // refreshed
    });
  });

  describe("deleteUser (X6 admin surface)", () => {
    it("resolves by exact email and deletes by id", async () => {
      const state = freshState();
      const provider = makeProvider(state);
      await provider.deleteUser({ email: "user1@example.test" });
      expect(state.users.has("u-1")).toBe(false);
      const del = state.requests.find((r) => r.method === "DELETE");
      expect(del?.url).toBe(`${BASE}/admin/realms/${REALM}/users/u-1`);
    });

    it("is a no-op for an unknown email (idempotent delete)", async () => {
      const state = freshState();
      const provider = makeProvider(state);
      await expect(provider.deleteUser({ email: "nobody@example.test" })).resolves.toBeUndefined();
      expect(state.users.size).toBe(1);
    });
  });

  describe("createUser (sub-preserving partialImport — G2 E-1)", () => {
    it("imports via partialImport (never POST /users) and preserves the caller id", async () => {
      const state = freshState();
      const provider = makeProvider(state);
      const result = await provider.createUser({
        id: "00000000-0000-4000-8000-000000000002",
        email: "user2@example.test",
        attributes: { "custom:userId": ["c123"] },
      });
      expect(result).toBe("created");
      expect(state.users.get("00000000-0000-4000-8000-000000000002")?.email).toBe(
        "user2@example.test",
      );
      // E-1: the create MUST go through partialImport — POST /users regenerates ids.
      const postUsers = state.requests.find(
        (r) => r.method === "POST" && r.url.endsWith(`/admin/realms/${REALM}/users`),
      );
      expect(postUsers).toBeUndefined();
      const partialImport = state.requests.find((r) => r.url.endsWith("/partialImport"));
      expect(partialImport).toBeDefined();
      expect((partialImport!.body as { ifResourceExists: string }).ifResourceExists).toBe("SKIP");
    });

    it("returns conflict on an existing id without touching the existing user", async () => {
      const state = freshState();
      const provider = makeProvider(state);
      const result = await provider.createUser({ id: "u-1", email: "other@example.test" });
      expect(result).toBe("conflict");
      expect(state.users.get("u-1")?.email).toBe("user1@example.test"); // unmodified
      // pre-flight caught it — no import was even attempted
      expect(state.requests.some((r) => r.url.endsWith("/partialImport"))).toBe(false);
    });

    it("returns conflict on an existing email (fail-not-overwrite, C-15b)", async () => {
      const state = freshState();
      const provider = makeProvider(state);
      const result = await provider.createUser({ id: "u-9", email: "user1@example.test" });
      expect(result).toBe("conflict");
      expect(state.users.has("u-9")).toBe(false);
    });
  });

  describe("registerUser (product registration — attributes at creation)", () => {
    it("uses POST /users, NOT the sub-preserving partialImport", async () => {
      // A privilege decision, verified live on KC 2026-08-07: partialImport
      // needs `manage-realm` (the service account got 403), POST /users needs
      // only `manage-users` (201). partialImport exists to preserve a
      // caller-specified id, which matters for MIGRATION and not here —
      // registration deliberately does not choose the sub. Using it would have
      // meant a realm-admin credential on the API, able to rewrite clients,
      // roles and flows, just to create one user.
      const state = freshState();
      const provider = makeProvider(state);

      await provider.registerUser({ email: "newcomer@example.test" });

      expect(state.requests.some((r) => r.url.endsWith("/partialImport"))).toBe(false);
      expect(
        state.requests.some(
          (r) => r.method === "POST" && r.url.endsWith(`/admin/realms/${REALM}/users`),
        ),
      ).toBe(true);
    });

    it("stamps the signup attributes on the new user", async () => {
      // These attributes are the whole point: the application provisions its
      // invitation gate and age tier from them on first sign-in, so a create
      // that drops them yields an un-gated account rather than an error.
      const state = freshState();
      const provider = makeProvider(state);

      const result = await provider.registerUser({
        email: "newcomer@example.test",
        attributes: {
          invitationCode: ["INVITE-1"],
          dateOfBirth: ["2000-01-01"],
          guardianEmail: ["parent@example.test"],
        },
      });

      expect(result).toBe("created");
      const created = [...state.users.values()].find((u) => u.email === "newcomer@example.test");
      expect(created?.attributes).toEqual({
        invitationCode: ["INVITE-1"],
        dateOfBirth: ["2000-01-01"],
        guardianEmail: ["parent@example.test"],
      });
    });

    it("does NOT mark the address verified by default", async () => {
      // Registration has not proven the address — the magic link that follows
      // is what proves it. Creating the user pre-verified would let someone
      // register an address they do not control and have it trusted.
      const state = freshState();
      const provider = makeProvider(state);

      await provider.registerUser({ email: "unproven@example.test" });

      const create = state.requests.find(
        (r) => r.method === "POST" && r.url.endsWith(`/admin/realms/${REALM}/users`),
      );
      expect((create!.body as { emailVerified: boolean }).emailVerified).toBe(false);
    });

    it("sends no id — Keycloak assigns the sub", async () => {
      const state = freshState();
      const provider = makeProvider(state);

      await provider.registerUser({ email: "a@example.test" });

      const create = state.requests.find(
        (r) => r.method === "POST" && r.url.endsWith(`/admin/realms/${REALM}/users`),
      );
      expect(create!.body).not.toHaveProperty("id");
    });

    it("returns exists for a known email WITHOUT rewriting it", async () => {
      // The replay property. A resubmitted registration must not be able to
      // overwrite an existing user's date of birth or re-consume an invitation.
      const state = freshState();
      state.users.set("u-2", {
        id: "u-2",
        email: "taken@example.test",
        attributes: { dateOfBirth: ["1990-01-01"] },
      });
      const provider = makeProvider(state);

      const result = await provider.registerUser({
        email: "taken@example.test",
        attributes: { dateOfBirth: ["2015-06-06"], invitationCode: ["REPLAY"] },
      });

      expect(result).toBe("exists");
      expect(state.users.get("u-2")?.attributes).toEqual({ dateOfBirth: ["1990-01-01"] });
      // The pre-flight caught it — no create was even attempted.
      expect(
        state.requests.some(
          (r) => r.method === "POST" && r.url.endsWith(`/admin/realms/${REALM}/users`),
        ),
      ).toBe(false);
    });

    it("treats Keycloak's own 409 as exists (pre-flight race)", async () => {
      // Two concurrent registrations for one address: the pre-flight can pass
      // in both before either writes. Keycloak's uniqueness constraint is the
      // real arbiter, and losing that race is still fail-not-overwrite.
      const state = freshState();
      const provider = makeProvider(state);
      // Slip the row in AFTER the pre-flight would have run.
      const original = provider["findUsersByEmail"].bind(provider);
      (provider as unknown as { findUsersByEmail: unknown }).findUsersByEmail = async (
        email: string,
      ) => {
        const out = await original(email);
        state.users.set("racer", { id: "racer", email: "race@example.test" });
        return out;
      };

      const result = await provider.registerUser({ email: "race@example.test" });

      expect(result).toBe("exists");
    });

    it("maps a rejected admin call to unauthorized", async () => {
      // What a service account WITHOUT manage-users gets. Surfacing it as
      // `unauthorized` is what let the live 403 be diagnosed from one log line.
      const state = freshState();
      const provider = makeProvider(state, {
        fetchFn: (async (input: string | URL, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input.href;
          if (url.endsWith(`/admin/realms/${REALM}/users`) && init?.method === "POST") {
            return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
          }
          return makeFake(state)(input, init);
        }) as typeof fetch,
      });

      await expect(provider.registerUser({ email: "x@example.test" })).rejects.toMatchObject({
        reason: "unauthorized",
      });
    });

    it("satisfies the optional port method", () => {
      const port: IdentityProviderPort = makeProvider(freshState());
      expect(typeof port.registerUser).toBe("function");
    });
  });

  describe("verifyProfileLockdown (F3 — privilege-attribute lockdown health-check)", () => {
    it("passes when every privilege attribute is admin-edit-only", async () => {
      const state = freshState();
      state.profileAttributes = [
        { name: "username", permissions: { edit: ["admin", "user"] } }, // non-privilege, ignored
        { name: "custom:globalRole", permissions: { edit: ["admin"] } },
        { name: "custom:tenantRole", permissions: { edit: ["admin"] } },
        { name: "custom:activeTenantId", permissions: { edit: ["admin"] } },
      ];
      const provider = makeProvider(state);
      await expect(provider.verifyProfileLockdown()).resolves.toBeUndefined();
    });

    it("passes when the privilege attributes are absent from the profile config", async () => {
      const state = freshState();
      state.profileAttributes = [{ name: "username", permissions: { edit: ["admin", "user"] } }];
      const provider = makeProvider(state);
      // Absent ⇒ not a user-editable managed attribute ⇒ safe.
      await expect(provider.verifyProfileLockdown()).resolves.toBeUndefined();
    });

    it("FAILS when a privilege attribute is user-editable", async () => {
      const state = freshState();
      state.profileAttributes = [
        { name: "custom:globalRole", permissions: { edit: ["admin", "user"] } },
        { name: "custom:tenantRole", permissions: { edit: ["admin"] } },
        { name: "custom:activeTenantId", permissions: { edit: ["admin"] } },
      ];
      const provider = makeProvider(state);
      let caught: unknown;
      try {
        await provider.verifyProfileLockdown();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(IdentityProviderError);
      expect((caught as IdentityProviderError).reason).toBe("config_missing");
      expect((caught as Error).message).toContain("custom:globalRole");
      expect((caught as Error).message).not.toContain("custom:tenantRole"); // that one is locked
    });

    it("FAILS (fail-closed) when a privilege attribute has no explicit edit permission", async () => {
      const state = freshState();
      state.profileAttributes = [{ name: "custom:globalRole", permissions: {} }];
      const provider = makeProvider(state);
      await expect(provider.verifyProfileLockdown()).rejects.toMatchObject({
        reason: "config_missing",
      });
    });

    it("maps a 403 on the profile call to unauthorized", async () => {
      const state = freshState();
      state.profileStatus = 403;
      const provider = makeProvider(state);
      await expect(provider.verifyProfileLockdown()).rejects.toMatchObject({
        reason: "unauthorized",
      });
    });
  });

  describe("getUser", () => {
    it("returns the user by id and null when absent", async () => {
      const state = freshState();
      const provider = makeProvider(state);
      expect(await provider.getUser("u-1")).toMatchObject({
        id: "u-1",
        email: "user1@example.test",
      });
      expect(await provider.getUser("missing")).toBeNull();
    });
  });
});
