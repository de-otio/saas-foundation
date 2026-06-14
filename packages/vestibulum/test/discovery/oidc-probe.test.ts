import * as fc from "fast-check";
import { describe, it, expect, vi } from "vitest";
import { Agent } from "undici";

import { OidcProbeError } from "../../src/errors.js";
import { buildPinnedLookup, probeOidcIssuer } from "../../src/discovery/oidc-probe.js";

// B-E: TEST-NET-1/2/3 are reserved (documentation-only) per RFC 5737
// and foundation's RFC 6890 table correctly classifies them as
// private. We use real public IPs (well-known DNS providers) as
// the "public" fixture for SSRF tests instead.
const PUBLIC_IP = "8.8.8.8"; // Google Public DNS.
const PUBLIC_IP_2 = "1.1.1.1"; // Cloudflare DNS.

/**
 * Build a discovery JSON body. Overrides win.
 */
function discoveryBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    issuer: "https://idp.example.com/",
    authorization_endpoint: "https://idp.example.com/authorize",
    token_endpoint: "https://idp.example.com/token",
    jwks_uri: "https://idp.example.com/jwks",
    userinfo_endpoint: "https://idp.example.com/userinfo",
    response_types_supported: ["code", "id_token"],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    scopes_supported: ["openid", "profile", "email"],
    ...overrides,
  };
}

/**
 * Build a Web `Response` whose body is the JSON-stringified value
 * delivered in a single chunk. The body is a real `ReadableStream`
 * so the probe's streaming read path is exercised.
 */
function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { status: 200, ...init },
  );
}

/**
 * A fetchImpl that returns a fixed Response.
 */
function fixedFetch(response: Response | (() => Response)): typeof fetch {
  return async () =>
    typeof response === "function" ? response() : response;
}

/**
 * A resolveHostname stub.
 */
function fixedResolve(...ips: string[]): (hostname: string) => Promise<string[]> {
  return async () => ips;
}

/**
 * Dispatcher factory that records every (ip, family) pair passed
 * to it. Tests use this to assert that the connect step is pinned
 * to the validated IP.
 */
function recordingDispatcher(): {
  factory: (ip: string, family: 4 | 6) => Agent;
  calls: Array<{ ip: string; family: 4 | 6 }>;
} {
  const calls: Array<{ ip: string; family: 4 | 6 }> = [];
  const factory = (ip: string, family: 4 | 6): Agent => {
    calls.push({ ip, family });
    return new Agent();
  };
  return { factory, calls };
}

/**
 * Catch and return the typed error so each test can branch on
 * `.reason`. Re-throws anything that isn't an `OidcProbeError`.
 */
async function expectProbeError(promise: Promise<unknown>): Promise<OidcProbeError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof OidcProbeError) return err;
    throw err;
  }
  throw new Error("Expected probeOidcIssuer to throw, but it did not");
}

describe("probeOidcIssuer — happy path", () => {
  it("returns the parsed metadata for a well-formed discovery document", async () => {
    const result = await probeOidcIssuer("https://idp.example.com/", {
      fetchImpl: fixedFetch(jsonResponse(discoveryBody())),
      resolveHostname: fixedResolve(PUBLIC_IP),
    });
    expect(result).toMatchObject({
      issuer: "https://idp.example.com/",
      authorizationEndpoint: "https://idp.example.com/authorize",
      tokenEndpoint: "https://idp.example.com/token",
      jwksUri: "https://idp.example.com/jwks",
      userinfoEndpoint: "https://idp.example.com/userinfo",
      responseTypesSupported: ["code", "id_token"],
      idTokenSigningAlgValuesSupported: ["RS256"],
      tokenEndpointAuthMethodsSupported: ["client_secret_post", "client_secret_basic"],
      scopesSupported: ["openid", "profile", "email"],
    });
  });

  it("treats a URL without a trailing slash as equivalent to one with", async () => {
    const result = await probeOidcIssuer("https://idp.example.com", {
      fetchImpl: fixedFetch(jsonResponse(discoveryBody({ issuer: "https://idp.example.com/" }))),
      resolveHostname: fixedResolve(PUBLIC_IP),
    });
    expect(result.issuer).toBe("https://idp.example.com/");
  });

  it("accepts IPv6 public addresses", async () => {
    const result = await probeOidcIssuer("https://idp.example.com/", {
      fetchImpl: fixedFetch(jsonResponse(discoveryBody())),
      resolveHostname: fixedResolve("2606:4700:4700::1111"),
    });
    expect(result).toBeDefined();
  });

  it("omits scopesSupported when the discovery doc omits it", async () => {
    const body = discoveryBody();
    delete (body as Record<string, unknown>).scopes_supported;
    const result = await probeOidcIssuer("https://idp.example.com/", {
      fetchImpl: fixedFetch(jsonResponse(body)),
      resolveHostname: fixedResolve(PUBLIC_IP),
    });
    expect(result.scopesSupported).toBeUndefined();
  });

  it("omits userinfoEndpoint when the discovery doc omits it", async () => {
    const body = discoveryBody();
    delete (body as Record<string, unknown>).userinfo_endpoint;
    const result = await probeOidcIssuer("https://idp.example.com/", {
      fetchImpl: fixedFetch(jsonResponse(body)),
      resolveHostname: fixedResolve(PUBLIC_IP),
    });
    expect(result.userinfoEndpoint).toBeUndefined();
  });

  it("accepts a multi-token response_types_supported entry", async () => {
    const result = await probeOidcIssuer("https://idp.example.com/", {
      fetchImpl: fixedFetch(
        jsonResponse(discoveryBody({ response_types_supported: ["code id_token", "token"] })),
      ),
      resolveHostname: fixedResolve(PUBLIC_IP),
    });
    expect(result.responseTypesSupported).toEqual(["code id_token", "token"]);
  });

  it("accepts the full set of permitted signing algorithms", async () => {
    const result = await probeOidcIssuer("https://idp.example.com/", {
      fetchImpl: fixedFetch(
        jsonResponse(
          discoveryBody({
            id_token_signing_alg_values_supported: [
              "RS256",
              "RS384",
              "RS512",
              "ES256",
              "ES384",
              "ES512",
            ],
          }),
        ),
      ),
      resolveHostname: fixedResolve(PUBLIC_IP),
    });
    expect(result.idTokenSigningAlgValuesSupported).toHaveLength(6);
  });
});

describe("probeOidcIssuer — URL validation", () => {
  it("rejects URLs longer than 2048 chars (url_too_long)", async () => {
    const long = "https://example.com/" + "x".repeat(2048);
    const err = await expectProbeError(probeOidcIssuer(long));
    expect(err.reason).toBe("url_too_long");
  });

  it("rejects garbage URLs (unreachable)", async () => {
    const err = await expectProbeError(probeOidcIssuer("not-a-url"));
    expect(err.reason).toBe("unreachable");
  });

  it("rejects http:// URLs (not_https)", async () => {
    const err = await expectProbeError(probeOidcIssuer("http://idp.example.com/"));
    expect(err.reason).toBe("not_https");
  });

  it("rejects URLs with user:pass@ credentials (url_has_credentials)", async () => {
    const err = await expectProbeError(probeOidcIssuer("https://attacker:bearer@idp.example.com/"));
    expect(err.reason).toBe("url_has_credentials");
  });

  it("rejects URLs with just a username", async () => {
    const err = await expectProbeError(probeOidcIssuer("https://user@idp.example.com/"));
    expect(err.reason).toBe("url_has_credentials");
  });
});

describe("probeOidcIssuer — SSRF guard", () => {
  it.each([
    ["10.0.0.1"],
    ["127.0.0.1"],
    ["169.254.169.254"], // EC2 IMDS
    ["172.16.0.1"],
    ["192.168.1.1"],
    ["100.64.0.1"], // CGNAT
    ["198.18.0.1"], // benchmark
    ["224.0.0.1"], // multicast
    ["::1"],
    ["fe80::1"],
    ["::ffff:127.0.0.1"],
    ["fc00::1"],
    ["2001:db8::1"],
  ])("refuses to connect when DNS resolves to %s (ssrf_blocked_destination)", async (ip) => {
    const err = await expectProbeError(
      probeOidcIssuer("https://idp.example.com/", {
        fetchImpl: fixedFetch(jsonResponse(discoveryBody())),
        resolveHostname: fixedResolve(ip),
      }),
    );
    expect(err.reason).toBe("ssrf_blocked_destination");
  });

  it("refuses if ANY resolved address is private (defends against multi-A records)", async () => {
    const err = await expectProbeError(
      probeOidcIssuer("https://idp.example.com/", {
        fetchImpl: fixedFetch(jsonResponse(discoveryBody())),
        resolveHostname: fixedResolve(PUBLIC_IP, "169.254.169.254"),
      }),
    );
    expect(err.reason).toBe("ssrf_blocked_destination");
  });

  it("refuses when DNS resolution fails (unreachable)", async () => {
    const err = await expectProbeError(
      probeOidcIssuer("https://idp.example.com/", {
        fetchImpl: fixedFetch(jsonResponse(discoveryBody())),
        resolveHostname: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    );
    expect(err.reason).toBe("unreachable");
  });

  it("refuses when DNS returns an empty list (unreachable)", async () => {
    const err = await expectProbeError(
      probeOidcIssuer("https://idp.example.com/", {
        fetchImpl: fixedFetch(jsonResponse(discoveryBody())),
        resolveHostname: fixedResolve(),
      }),
    );
    expect(err.reason).toBe("unreachable");
  });

  it("refuses when the resolver returns a non-IP literal (defensive)", async () => {
    const err = await expectProbeError(
      probeOidcIssuer("https://idp.example.com/", {
        fetchImpl: fixedFetch(jsonResponse(discoveryBody())),
        // The classifier treats non-literals as private (fail
        // closed), so this is caught by the SSRF branch -- verify
        // exhaustive defence rather than fall-through.
        resolveHostname: fixedResolve("definitely-not-an-ip"),
      }),
    );
    expect(err.reason).toBe("ssrf_blocked_destination");
  });

  it("strips IPv6 bracket notation from the hostname before resolving", async () => {
    let capturedHost: string | undefined;
    await probeOidcIssuer("https://[2606:4700:4700::1111]/", {
      fetchImpl: fixedFetch(
        jsonResponse(discoveryBody({ issuer: "https://[2606:4700:4700::1111]/" })),
      ),
      resolveHostname: async (host: string) => {
        capturedHost = host;
        return ["2606:4700:4700::1111"];
      },
    });
    expect(capturedHost).toBe("2606:4700:4700::1111");
  });
});

describe("probeOidcIssuer — DNS-rebinding TOCTOU pin", () => {
  it("pins the connect step to the IP returned by the resolver, not whatever DNS says at fetch time", async () => {
    const { factory, calls } = recordingDispatcher();
    await probeOidcIssuer("https://idp.example.com/", {
      fetchImpl: fixedFetch(jsonResponse(discoveryBody())),
      resolveHostname: fixedResolve(PUBLIC_IP_2),
      dispatcherFactory: factory,
    });
    expect(calls).toHaveLength(1);
    // The IP captured by the dispatcher equals the IP the resolver
    // returned -- proving the connect step does not perform its own
    // DNS lookup at fetch time.
    expect(calls[0]).toEqual({ ip: PUBLIC_IP_2, family: 4 });
  });

  it("passes family=6 when the validated IP is IPv6", async () => {
    const { factory, calls } = recordingDispatcher();
    await probeOidcIssuer("https://idp.example.com/", {
      fetchImpl: fixedFetch(jsonResponse(discoveryBody())),
      resolveHostname: fixedResolve("2606:4700:4700::1111"),
      dispatcherFactory: factory,
    });
    expect(calls[0]?.family).toBe(6);
  });

  it("does not invoke the dispatcher factory before SSRF validation passes", async () => {
    const { factory, calls } = recordingDispatcher();
    await expectProbeError(
      probeOidcIssuer("https://idp.example.com/", {
        fetchImpl: fixedFetch(jsonResponse(discoveryBody())),
        resolveHostname: fixedResolve("10.0.0.1"),
        dispatcherFactory: factory,
      }),
    );
    expect(calls).toHaveLength(0);
  });
});

describe("probeOidcIssuer — fetch / response handling", () => {
  it("rejects 3xx redirects (redirect_blocked)", async () => {
    const err = await expectProbeError(
      probeOidcIssuer("https://idp.example.com/", {
        fetchImpl: fixedFetch(new Response(null, { status: 302 })),
        resolveHostname: fixedResolve(PUBLIC_IP),
      }),
    );
    expect(err.reason).toBe("redirect_blocked");
  });

  it.each([301, 302, 303, 307, 308])(
    "rejects HTTP %s redirects (redirect_blocked)",
    async (status) => {
      const err = await expectProbeError(
        probeOidcIssuer("https://idp.example.com/", {
          fetchImpl: fixedFetch(new Response(null, { status })),
          resolveHostname: fixedResolve(PUBLIC_IP),
        }),
      );
      expect(err.reason).toBe("redirect_blocked");
    },
  );

  it("rejects non-2xx non-3xx (unreachable)", async () => {
    const err = await expectProbeError(
      probeOidcIssuer("https://idp.example.com/", {
        fetchImpl: fixedFetch(new Response("not found", { status: 404 })),
        resolveHostname: fixedResolve(PUBLIC_IP),
      }),
    );
    expect(err.reason).toBe("unreachable");
  });

  it("rejects an empty response body (unreachable)", async () => {
    // Workaround: Response(null) is constructible but the spec
    // gives it a null body; the probe must treat that as a
    // network-level failure.
    const err = await expectProbeError(
      probeOidcIssuer("https://idp.example.com/", {
        fetchImpl: fixedFetch(new Response(null, { status: 200 })),
        resolveHostname: fixedResolve(PUBLIC_IP),
      }),
    );
    expect(err.reason).toBe("unreachable");
  });

  it("maps an AbortError fetch failure to timeout", async () => {
    const err = await expectProbeError(
      probeOidcIssuer("https://idp.example.com/", {
        fetchImpl: (async () => {
          const abortErr = new Error("aborted");
          abortErr.name = "AbortError";
          throw abortErr;
        }) as unknown as typeof fetch,
        resolveHostname: fixedResolve(PUBLIC_IP),
      }),
    );
    expect(err.reason).toBe("timeout");
  });

  it("aborts via the timeout when fetch hangs longer than timeoutMs", async () => {
    // A fetchImpl that never resolves, paired with a tiny
    // timeoutMs, exercises the `setTimeout(() => controller.abort())`
    // path. The abort signal triggers the controller's listener
    // and the probe maps the resulting AbortError to `timeout`.
    const err = await expectProbeError(
      probeOidcIssuer("https://idp.example.com/", {
        fetchImpl: ((_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              const abortErr = new Error("aborted by signal");
              abortErr.name = "AbortError";
              reject(abortErr);
            });
          })) as unknown as typeof fetch,
        resolveHostname: fixedResolve(PUBLIC_IP),
        timeoutMs: 10,
      }),
    );
    expect(err.reason).toBe("timeout");
  });

  it("maps a generic fetch failure to unreachable", async () => {
    const err = await expectProbeError(
      probeOidcIssuer("https://idp.example.com/", {
        fetchImpl: (async () => {
          throw new Error("ECONNRESET");
        }) as unknown as typeof fetch,
        resolveHostname: fixedResolve(PUBLIC_IP),
      }),
    );
    expect(err.reason).toBe("unreachable");
  });

  it("enforces the body cap (too_large)", async () => {
    // Two-chunk stream: chunk 1 is at the cap, chunk 2 pushes past.
    const big = new Uint8Array(1024 * 1024); // exactly 1 MiB
    const more = new Uint8Array(1);
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(big);
          controller.enqueue(more);
          controller.close();
        },
      }),
      { status: 200 },
    );
    const err = await expectProbeError(
      probeOidcIssuer("https://idp.example.com/", {
        fetchImpl: fixedFetch(response),
        resolveHostname: fixedResolve(PUBLIC_IP),
      }),
    );
    expect(err.reason).toBe("too_large");
  });

  it("maps a stream error to unreachable", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("socket hangup"));
        },
      }),
      { status: 200 },
    );
    const err = await expectProbeError(
      probeOidcIssuer("https://idp.example.com/", {
        fetchImpl: fixedFetch(response),
        resolveHostname: fixedResolve(PUBLIC_IP),
      }),
    );
    expect(err.reason).toBe("unreachable");
  });

  it("honours a custom timeoutMs", async () => {
    // Test that the timeout option is accepted and the call still
    // works for fast fetches.
    const result = await probeOidcIssuer("https://idp.example.com/", {
      fetchImpl: fixedFetch(jsonResponse(discoveryBody())),
      resolveHostname: fixedResolve(PUBLIC_IP),
      timeoutMs: 100,
    });
    expect(result).toBeDefined();
  });
});

describe("probeOidcIssuer — JSON / metadata validation", () => {
  it("rejects non-JSON bodies (invalid_json)", async () => {
    const err = await expectProbeError(
      probeOidcIssuer("https://idp.example.com/", {
        fetchImpl: fixedFetch(jsonResponse("not json at all")),
        resolveHostname: fixedResolve(PUBLIC_IP),
      }),
    );
    expect(err.reason).toBe("invalid_json");
  });

  it("rejects a JSON array body (invalid_json)", async () => {
    const err = await expectProbeError(
      probeOidcIssuer("https://idp.example.com/", {
        fetchImpl: fixedFetch(jsonResponse([1, 2, 3])),
        resolveHostname: fixedResolve(PUBLIC_IP),
      }),
    );
    expect(err.reason).toBe("invalid_json");
  });

  it("rejects a null JSON body (invalid_json)", async () => {
    const err = await expectProbeError(
      probeOidcIssuer("https://idp.example.com/", {
        fetchImpl: fixedFetch(jsonResponse(null)),
        resolveHostname: fixedResolve(PUBLIC_IP),
      }),
    );
    expect(err.reason).toBe("invalid_json");
  });

  it.each([["issuer"], ["authorization_endpoint"], ["token_endpoint"], ["jwks_uri"]])(
    'rejects when "%s" is missing (invalid_json)',
    async (missing) => {
      const body = discoveryBody();
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (body as Record<string, unknown>)[missing];
      const err = await expectProbeError(
        probeOidcIssuer("https://idp.example.com/", {
          fetchImpl: fixedFetch(jsonResponse(body)),
          resolveHostname: fixedResolve(PUBLIC_IP),
        }),
      );
      expect(err.reason).toBe("invalid_json");
    },
  );

  it("rejects mismatched issuer (issuer_mismatch)", async () => {
    const err = await expectProbeError(
      probeOidcIssuer("https://idp.example.com/", {
        fetchImpl: fixedFetch(
          jsonResponse(discoveryBody({ issuer: "https://attacker.example.com/" })),
        ),
        resolveHostname: fixedResolve(PUBLIC_IP),
      }),
    );
    expect(err.reason).toBe("issuer_mismatch");
  });

  it('rejects when response_types_supported lacks "code" (unsupported_alg)', async () => {
    const err = await expectProbeError(
      probeOidcIssuer("https://idp.example.com/", {
        fetchImpl: fixedFetch(
          jsonResponse(discoveryBody({ response_types_supported: ["token", "id_token"] })),
        ),
        resolveHostname: fixedResolve(PUBLIC_IP),
      }),
    );
    expect(err.reason).toBe("unsupported_alg");
  });

  it("rejects when id_token_signing_alg_values_supported is empty (unsupported_alg)", async () => {
    const err = await expectProbeError(
      probeOidcIssuer("https://idp.example.com/", {
        fetchImpl: fixedFetch(
          jsonResponse(discoveryBody({ id_token_signing_alg_values_supported: [] })),
        ),
        resolveHostname: fixedResolve(PUBLIC_IP),
      }),
    );
    expect(err.reason).toBe("unsupported_alg");
  });

  it('rejects when id_token_signing_alg_values_supported contains "none" (unsupported_alg)', async () => {
    const err = await expectProbeError(
      probeOidcIssuer("https://idp.example.com/", {
        fetchImpl: fixedFetch(
          jsonResponse(discoveryBody({ id_token_signing_alg_values_supported: ["none"] })),
        ),
        resolveHostname: fixedResolve(PUBLIC_IP),
      }),
    );
    expect(err.reason).toBe("unsupported_alg");
  });

  it("rejects when id_token_signing_alg_values_supported contains HS256 (unsupported_alg)", async () => {
    const err = await expectProbeError(
      probeOidcIssuer("https://idp.example.com/", {
        fetchImpl: fixedFetch(
          jsonResponse(discoveryBody({ id_token_signing_alg_values_supported: ["HS256"] })),
        ),
        resolveHostname: fixedResolve(PUBLIC_IP),
      }),
    );
    expect(err.reason).toBe("unsupported_alg");
  });

  it("rejects when token_endpoint_auth_methods_supported lacks client_secret_post (unsupported_auth_method)", async () => {
    const err = await expectProbeError(
      probeOidcIssuer("https://idp.example.com/", {
        fetchImpl: fixedFetch(
          jsonResponse(
            discoveryBody({ token_endpoint_auth_methods_supported: ["client_secret_basic"] }),
          ),
        ),
        resolveHostname: fixedResolve(PUBLIC_IP),
      }),
    );
    expect(err.reason).toBe("unsupported_auth_method");
  });

  it("rejects when token_endpoint_auth_methods_supported is missing (unsupported_auth_method)", async () => {
    const body = discoveryBody();
    delete (body as Record<string, unknown>).token_endpoint_auth_methods_supported;
    const err = await expectProbeError(
      probeOidcIssuer("https://idp.example.com/", {
        fetchImpl: fixedFetch(jsonResponse(body)),
        resolveHostname: fixedResolve(PUBLIC_IP),
      }),
    );
    expect(err.reason).toBe("unsupported_auth_method");
  });

  it("treats a non-string issuer field as missing (invalid_json)", async () => {
    const body = discoveryBody({ issuer: 42 });
    const err = await expectProbeError(
      probeOidcIssuer("https://idp.example.com/", {
        fetchImpl: fixedFetch(jsonResponse(body)),
        resolveHostname: fixedResolve(PUBLIC_IP),
      }),
    );
    expect(err.reason).toBe("invalid_json");
  });

  it("treats non-array response_types_supported as empty (rejected unsupported_alg)", async () => {
    const err = await expectProbeError(
      probeOidcIssuer("https://idp.example.com/", {
        fetchImpl: fixedFetch(jsonResponse(discoveryBody({ response_types_supported: "code" }))),
        resolveHostname: fixedResolve(PUBLIC_IP),
      }),
    );
    expect(err.reason).toBe("unsupported_alg");
  });

  it("normalises issuer case + trailing slash before comparison", async () => {
    // The probed URL has no trailing slash and is fully lowercase;
    // the response advertises a trailing slash and mixed case on the
    // host. They normalise to the same canonical form.
    const result = await probeOidcIssuer("https://idp.example.com", {
      fetchImpl: fixedFetch(jsonResponse(discoveryBody({ issuer: "https://IDP.EXAMPLE.COM/" }))),
      resolveHostname: fixedResolve(PUBLIC_IP),
    });
    expect(result.issuer).toBe("https://IDP.EXAMPLE.COM/");
  });
});

describe("probeOidcIssuer — coverage of all 12 OidcProbeError reasons", () => {
  // Every documented reason is reachable. Build a tiny test that
  // walks all of them via a single it.each. Some have already been
  // exercised in detail above; here we record that each reason is
  // explicitly produced by at least one probe configuration.
  const cases: Array<{
    reason: OidcProbeError["reason"];
    setup: () => Promise<unknown>;
  }> = [
    {
      reason: "url_too_long",
      setup: () => probeOidcIssuer("https://example.com/" + "x".repeat(2048)),
    },
    {
      reason: "unreachable",
      setup: () => probeOidcIssuer("not a url"),
    },
    {
      reason: "not_https",
      setup: () => probeOidcIssuer("http://idp.example.com/"),
    },
    {
      reason: "url_has_credentials",
      setup: () => probeOidcIssuer("https://user:pass@idp.example.com/"),
    },
    {
      reason: "ssrf_blocked_destination",
      setup: () =>
        probeOidcIssuer("https://idp.example.com/", {
          fetchImpl: fixedFetch(jsonResponse(discoveryBody())),
          resolveHostname: fixedResolve("10.0.0.1"),
        }),
    },
    {
      reason: "redirect_blocked",
      setup: () =>
        probeOidcIssuer("https://idp.example.com/", {
          fetchImpl: fixedFetch(new Response(null, { status: 302 })),
          resolveHostname: fixedResolve(PUBLIC_IP),
        }),
    },
    {
      reason: "timeout",
      setup: () =>
        probeOidcIssuer("https://idp.example.com/", {
          fetchImpl: (async () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            throw e;
          }) as unknown as typeof fetch,
          resolveHostname: fixedResolve(PUBLIC_IP),
        }),
    },
    {
      reason: "too_large",
      setup: () =>
        probeOidcIssuer("https://idp.example.com/", {
          fetchImpl: fixedFetch(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new Uint8Array(1024 * 1024 + 1));
                  controller.close();
                },
              }),
              { status: 200 },
            ),
          ),
          resolveHostname: fixedResolve(PUBLIC_IP),
        }),
    },
    {
      reason: "invalid_json",
      setup: () =>
        probeOidcIssuer("https://idp.example.com/", {
          fetchImpl: fixedFetch(jsonResponse("garbage")),
          resolveHostname: fixedResolve(PUBLIC_IP),
        }),
    },
    {
      reason: "issuer_mismatch",
      setup: () =>
        probeOidcIssuer("https://idp.example.com/", {
          fetchImpl: fixedFetch(
            jsonResponse(discoveryBody({ issuer: "https://other.example.com/" })),
          ),
          resolveHostname: fixedResolve(PUBLIC_IP),
        }),
    },
    {
      reason: "unsupported_alg",
      setup: () =>
        probeOidcIssuer("https://idp.example.com/", {
          fetchImpl: fixedFetch(
            jsonResponse(discoveryBody({ id_token_signing_alg_values_supported: ["none"] })),
          ),
          resolveHostname: fixedResolve(PUBLIC_IP),
        }),
    },
    {
      reason: "unsupported_auth_method",
      setup: () =>
        probeOidcIssuer("https://idp.example.com/", {
          fetchImpl: fixedFetch(
            jsonResponse(discoveryBody({ token_endpoint_auth_methods_supported: [] })),
          ),
          resolveHostname: fixedResolve(PUBLIC_IP),
        }),
    },
  ];

  it.each(cases.map((c) => [c.reason] as const))("produces reason %s", async (reason) => {
    const c = cases.find((x) => x.reason === reason)!;
    const err = await expectProbeError(c.setup());
    expect(err.reason).toBe(reason);
  });
});

describe("probeOidcIssuer — defaults exercised", () => {
  it("uses the default undici.Agent dispatcher when no factory is injected", async () => {
    // We do NOT inject dispatcherFactory; the defaultPinnedDispatcher
    // path runs (constructs a real undici.Agent). The fetchImpl is
    // still mocked so no socket-level work happens, but the
    // dispatcher constructor and its custom lookup are executed --
    // covering those branches.
    const result = await probeOidcIssuer("https://idp.example.com/", {
      fetchImpl: fixedFetch(jsonResponse(discoveryBody())),
      resolveHostname: fixedResolve(PUBLIC_IP),
    });
    expect(result).toBeDefined();
  });

  it("uses the default DNS resolver when none is injected (fails on a non-resolvable host)", async () => {
    // We use a TLD that does not resolve. The default resolver runs
    // and throws ENOTFOUND, which the probe maps to `unreachable`.
    // The host literal is the IANA-reserved `invalid` TLD that
    // promises never to resolve.
    const err = await expectProbeError(
      probeOidcIssuer("https://nonexistent-host.invalid/", {
        // No resolveHostname -> default `dns.lookup` runs.
        // No dispatcherFactory -> default undici.Agent runs (but is
        // never reached because the resolver throws first).
        fetchImpl: fixedFetch(jsonResponse(discoveryBody())),
      }),
    );
    expect(err.reason).toBe("unreachable");
  });

  it("exercises the default resolver `.then(map)` path on a host that does resolve", async () => {
    // `localhost` reliably resolves to a loopback address on every
    // platform we ship to. The SSRF guard then refuses the
    // connection -- but the `.then((addrs) => addrs.map(...))`
    // callback in defaultResolve has already run by that point,
    // covering line 227.
    const err = await expectProbeError(
      probeOidcIssuer("https://localhost/", {
        fetchImpl: fixedFetch(jsonResponse(discoveryBody())),
      }),
    );
    expect(err.reason).toBe("ssrf_blocked_destination");
  });

  it("buildPinnedLookup() returns a callback that pins to the validated IP (v4)", () => {
    const lookup = buildPinnedLookup("203.0.113.10", 4);
    const cb = vi.fn();
    lookup("whatever-hostname.example.com", { family: 0 }, cb);
    expect(cb).toHaveBeenCalledWith(null, "203.0.113.10", 4);
  });

  it("buildPinnedLookup() returns a callback that pins to the validated IP (v6)", () => {
    const lookup = buildPinnedLookup("2606:4700:4700::1111", 6);
    const cb = vi.fn();
    lookup("any-host", undefined, cb);
    expect(cb).toHaveBeenCalledWith(null, "2606:4700:4700::1111", 6);
  });
});

describe("probeOidcIssuer — property: random URL fuzz never connects to a private IP", () => {
  it("no input ever causes the dispatcher to be invoked with a private IP", async () => {
    // The dispatcher should only ever be called with the validated
    // (= public) IP -- never with a private one. The property holds
    // across arbitrary URLs because:
    //   1. URL parse / scheme / cred checks happen before resolve.
    //   2. Resolve happens before dispatcher.
    //   3. Private IPs throw ssrf_blocked_destination, skipping the
    //      dispatcher call.
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constant("https://idp.example.com/"),
          fc.constant("http://idp.example.com/"),
          fc.constant("https://user:pass@idp.example.com/"),
          fc.webUrl({ validSchemes: ["https"] }),
          fc.string({ minLength: 0, maxLength: 50 }),
        ),
        fc.constantFrom(
          "10.0.0.1",
          "127.0.0.1",
          "169.254.169.254",
          "192.168.1.1",
          "::1",
          "fe80::1",
          "::ffff:10.0.0.1",
          PUBLIC_IP, // benign mix-in
          PUBLIC_IP_2,
        ),
        async (url, ip) => {
          const { factory, calls } = recordingDispatcher();
          try {
            await probeOidcIssuer(url, {
              fetchImpl: fixedFetch(jsonResponse(discoveryBody())),
              resolveHostname: fixedResolve(ip),
              dispatcherFactory: factory,
            });
          } catch {
            // Many configurations error out before the dispatcher
            // is built -- that's the point.
          }
          // Anything in `calls` must be a non-private IP. The
          // probe should never invoke the dispatcher factory
          // with a private IP.
          for (const c of calls) {
            // We assert via the same classifier the probe uses,
            // closing the property loop.
            const { isPrivateAddress } = await import("../../src/discovery/private-ip.js");
            expect(isPrivateAddress(c.ip)).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
