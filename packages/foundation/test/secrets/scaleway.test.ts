/**
 * Unit tests for the Scaleway Secret Manager backend (WS-5).
 *
 * All HTTP is faked through the injectable `fetchFn`; the cache is
 * injected with a frozen clock (determinism rules — no `Date.now()`).
 */

import { describe, expect, it, vi } from "vitest";

import { SecretCache } from "../../src/secrets/cache.js";
import {
  SecretsAccessDeniedError,
  SecretsNotFoundError,
  SecretsResolveError,
  SecretsTransientError,
} from "../../src/secrets/errors.js";
import {
  resolveScalewaySecret,
  resolveSecretsProvider,
  scalewaySecretRef,
  ScalewaySecretRefValidationError,
  type ScalewaySecretRef,
} from "../../src/secrets/scaleway.js";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeContext(fetchFn: typeof fetch, nowRef = { current: 0 }) {
  return {
    fetchFn,
    cache: new SecretCache({ clock: () => nowRef.current }),
    secretKey: "test-token",
    nowRef,
  };
}

const byIdRef: ScalewaySecretRef = {
  secretId: "11111111-2222-3333-4444-555555555555",
  region: "fr-par",
};

describe("scalewaySecretRef validation", () => {
  it("requires a region and one of secretId/name", () => {
    expect(() => scalewaySecretRef({ region: "" })).toThrow(
      ScalewaySecretRefValidationError,
    );
    expect(() => scalewaySecretRef({ region: "fr-par" })).toThrow(
      /one of secretId or name/,
    );
  });

  it("rejects malformed revisions, accepts the documented forms", () => {
    expect(() =>
      scalewaySecretRef({ ...byIdRef, revision: "newest" }),
    ).toThrow(/revision/);
    for (const revision of ["latest", "latest_enabled", "3"]) {
      expect(scalewaySecretRef({ ...byIdRef, revision }).revision).toBe(revision);
    }
  });

  it("returns a frozen ref", () => {
    expect(Object.isFrozen(scalewaySecretRef(byIdRef))).toBe(true);
  });
});

describe("resolveScalewaySecret — routes and auth", () => {
  it("hits the by-id v1beta1 access route with X-Auth-Token, default revision latest_enabled", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(200, { data: Buffer.from("s3cret").toString("base64") }),
    ) as unknown as typeof fetch;
    const ctx = makeContext(fetchFn);

    const bytes = await resolveScalewaySecret(byIdRef, ctx);
    expect(bytes.toString("utf8")).toBe("s3cret");

    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://api.scaleway.com/secret-manager/v1beta1/regions/fr-par/secrets/11111111-2222-3333-4444-555555555555/versions/latest_enabled/access",
    );
    expect((init.headers as Record<string, string>)["X-Auth-Token"]).toBe("test-token");
  });

  it("hits the by-path route with secret_name/secret_path/project_id query params", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(200, { data: Buffer.from("x").toString("base64") }),
    ) as unknown as typeof fetch;
    const ctx = makeContext(fetchFn);

    await resolveScalewaySecret(
      {
        name: "db-password",
        path: "/trellis/dev",
        projectId: "proj-1",
        region: "nl-ams",
        revision: "latest",
      },
      ctx,
    );

    const url = new URL((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(url.pathname).toBe(
      "/secret-manager/v1beta1/regions/nl-ams/secrets-by-path/versions/latest/access",
    );
    expect(url.searchParams.get("secret_name")).toBe("db-password");
    expect(url.searchParams.get("secret_path")).toBe("/trellis/dev");
    expect(url.searchParams.get("project_id")).toBe("proj-1");
  });

  it("fails closed (AccessDenied) when no token is available", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const previous = process.env.SCW_SECRET_KEY;
    delete process.env.SCW_SECRET_KEY;
    try {
      await expect(
        resolveScalewaySecret(byIdRef, { fetchFn, cache: new SecretCache({ clock: () => 0 }) }),
      ).rejects.toBeInstanceOf(SecretsAccessDeniedError);
      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      if (previous !== undefined) process.env.SCW_SECRET_KEY = previous;
    }
  });
});

describe("resolveScalewaySecret — error classification (fail-closed)", () => {
  it("404 → SecretsNotFoundError", async () => {
    const ctx = makeContext(
      vi.fn(async () => jsonResponse(404, { message: "not found" })),
    );
    await expect(resolveScalewaySecret(byIdRef, ctx)).rejects.toBeInstanceOf(
      SecretsNotFoundError,
    );
  });

  it("403 and 401 → SecretsAccessDeniedError", async () => {
    for (const status of [401, 403]) {
      const ctx = makeContext(
        vi.fn(async () => jsonResponse(status, {})),
      );
      await expect(resolveScalewaySecret(byIdRef, ctx)).rejects.toBeInstanceOf(
        SecretsAccessDeniedError,
      );
    }
  });

  it("retries 5xx internally, then SecretsTransientError after budget exhaustion", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(500, { message: "boom" }),
    ) as unknown as typeof fetch;
    const ctx = makeContext(fetchFn);

    await expect(resolveScalewaySecret(byIdRef, ctx)).rejects.toBeInstanceOf(
      SecretsTransientError,
    );
    // transientRetry: initial call + maxAttempts(3) retries = 4 sends.
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
  }, 15000);

  it("recovers when a transient failure clears within the retry budget", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}))
      .mockResolvedValueOnce(
        jsonResponse(200, { data: Buffer.from("ok").toString("base64") }),
      ) as unknown as typeof fetch;
    const ctx = makeContext(fetchFn);

    const bytes = await resolveScalewaySecret(byIdRef, ctx);
    expect(bytes.toString("utf8")).toBe("ok");
  }, 15000);

  it("does NOT retry 404 (terminal)", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(404, {}),
    ) as unknown as typeof fetch;
    const ctx = makeContext(fetchFn);
    await expect(resolveScalewaySecret(byIdRef, ctx)).rejects.toBeInstanceOf(
      SecretsNotFoundError,
    );
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("missing data field → SecretsResolveError (never an empty Buffer)", async () => {
    const ctx = makeContext(
      vi.fn(async () => jsonResponse(200, { revision: 1 })),
    );
    await expect(resolveScalewaySecret(byIdRef, ctx)).rejects.toBeInstanceOf(
      SecretsResolveError,
    );
  });
});

describe("resolveScalewaySecret — cache semantics (mirrors the AWS resolver)", () => {
  it("caches by (region, ident, revision); second call is a hit", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(200, { data: Buffer.from("v1").toString("base64") }),
    ) as unknown as typeof fetch;
    const ctx = makeContext(fetchFn);

    await resolveScalewaySecret(byIdRef, ctx);
    const again = await resolveScalewaySecret(byIdRef, ctx);
    expect(again.toString("utf8")).toBe("v1");
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("different revisions do not collide", async () => {
    const fetchFn = vi.fn(async (url: string) =>
      jsonResponse(200, {
        data: Buffer.from(String(url).includes("/versions/2/") ? "two" : "latest").toString(
          "base64",
        ),
      }),
    ) as unknown as typeof fetch;
    const ctx = makeContext(fetchFn);

    const latest = await resolveScalewaySecret(byIdRef, ctx);
    const pinned = await resolveScalewaySecret({ ...byIdRef, revision: "2" }, ctx);
    expect(latest.toString("utf8")).toBe("latest");
    expect(pinned.toString("utf8")).toBe("two");
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("fresh: true invalidates and re-fetches", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: Buffer.from("old").toString("base64") }))
      .mockResolvedValueOnce(
        jsonResponse(200, { data: Buffer.from("new").toString("base64") }),
      ) as unknown as typeof fetch;
    const ctx = makeContext(fetchFn);

    await resolveScalewaySecret(byIdRef, ctx);
    const fresh = await resolveScalewaySecret(byIdRef, ctx, { fresh: true });
    expect(fresh.toString("utf8")).toBe("new");
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("expired entries re-fetch (TTL via the injected clock)", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(200, { data: Buffer.from("v").toString("base64") }),
    ) as unknown as typeof fetch;
    const nowRef = { current: 0 };
    const ctx = makeContext(fetchFn, nowRef);

    await resolveScalewaySecret(byIdRef, ctx);
    nowRef.current = 301_000; // past the 300s default TTL
    await resolveScalewaySecret(byIdRef, ctx);
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });
});

describe("resolveSecretsProvider (env-driven, KV_PROVIDER pattern)", () => {
  it("defaults to aws (zero change for existing deployments)", () => {
    expect(resolveSecretsProvider({})).toBe("aws");
    expect(resolveSecretsProvider({ SECRETS_PROVIDER: "aws" })).toBe("aws");
    expect(resolveSecretsProvider({ SECRETS_PROVIDER: "nonsense" })).toBe("aws");
  });

  it("selects scaleway only on the exact value", () => {
    expect(resolveSecretsProvider({ SECRETS_PROVIDER: "scaleway" })).toBe("scaleway");
  });
});
