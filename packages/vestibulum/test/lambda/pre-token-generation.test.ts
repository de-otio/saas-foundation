import { describe, it, expect, vi } from "vitest";
import { ReservedClaimError } from "../../src/errors.js";
import {
  createPreTokenGenerationHandler,
  type PreTokenGenerationHandler,
} from "../../src/lambda/pre-token-generation.js";
import type {
  PreTokenGenerationV1Event,
  PreTokenGenerationV2Event,
} from "../../src/lambda/cognito-events.js";
import { RESERVED_CLAIMS } from "../../src/types/reserved-claims.js";
import type {
  ClaimResolver,
  ClaimResolverInput,
} from "../../src/callbacks/types.js";

function v1Event(overrides: Partial<PreTokenGenerationV1Event> = {}): PreTokenGenerationV1Event {
  return {
    version: "1",
    region: "eu-central-1",
    userPoolId: "eu-central-1_test",
    triggerSource: "TokenGeneration_Authentication",
    userName: "sub-1",
    callerContext: { awsSdkVersion: "1.0", clientId: "client-1" },
    request: {
      userAttributes: { email: "a@example.com" },
      groupConfiguration: {},
    },
    response: {},
    ...overrides,
  };
}

function v2Event(overrides: Partial<PreTokenGenerationV2Event> = {}): PreTokenGenerationV2Event {
  return {
    version: "2",
    region: "eu-central-1",
    userPoolId: "eu-central-1_test",
    triggerSource: "TokenGeneration_Authentication",
    userName: "sub-1",
    callerContext: { awsSdkVersion: "1.0", clientId: "client-1" },
    request: {
      userAttributes: { email: "a@example.com" },
      groupConfiguration: {},
      scopes: ["aws.cognito.signin.user.admin"],
    },
    response: { claimsAndScopeOverrideDetails: {} },
    ...overrides,
  };
}

describe("createPreTokenGenerationHandler — V1 event", () => {
  it("normalises input and applies V1 response shape", async () => {
    const captured: ClaimResolverInput[] = [];
    const resolver: ClaimResolver = async (input) => {
      captured.push(input);
      return {
        claimsToAddOrOverride: { "custom:tenant_id": "t-1" },
        claimsToSuppress: ["email"],
        groupsToOverride: ["admins"],
        iamRolesToOverride: ["arn:aws:iam::1:role/r"],
        preferredRole: "arn:aws:iam::1:role/r",
      };
    };

    const handler: PreTokenGenerationHandler = createPreTokenGenerationHandler({
      resolveClaims: resolver,
    });
    const event = v1Event();
    const out = (await handler(event)) as PreTokenGenerationV1Event;

    expect(captured).toHaveLength(1);
    expect(captured[0]?.userSub).toBe("sub-1");
    expect(captured[0]?.clientId).toBe("client-1");
    expect(captured[0]?.triggerSource).toBe("TokenGeneration_Authentication");
    expect(captured[0]?.isRefresh).toBe(false);

    expect(out.response.claimsOverrideDetails).toEqual({
      claimsToAddOrOverride: { "custom:tenant_id": "t-1" },
      claimsToSuppress: ["email"],
      groupOverrideDetails: {
        groupsToOverride: ["admins"],
        iamRolesToOverride: ["arn:aws:iam::1:role/r"],
        preferredRole: "arn:aws:iam::1:role/r",
      },
    });
  });

  it("omits groupOverrideDetails when no group fields are returned", async () => {
    const handler = createPreTokenGenerationHandler({
      resolveClaims: async () => ({
        claimsToAddOrOverride: { "custom:k": "v" },
      }),
    });
    const event = v1Event();
    const out = (await handler(event)) as PreTokenGenerationV1Event;
    expect(out.response.claimsOverrideDetails?.groupOverrideDetails).toBeUndefined();
  });

  it("stringifies array, boolean, and number claim values", async () => {
    const handler = createPreTokenGenerationHandler({
      resolveClaims: async () => ({
        claimsToAddOrOverride: {
          "custom:roles": ["admin", "viewer"],
          "custom:active": true,
          "custom:count": 42,
          "custom:name": "plain",
        },
      }),
    });
    const event = v1Event();
    const out = (await handler(event)) as PreTokenGenerationV1Event;
    expect(out.response.claimsOverrideDetails?.claimsToAddOrOverride).toEqual({
      "custom:roles": '["admin","viewer"]',
      "custom:active": "true",
      "custom:count": "42",
      "custom:name": "plain",
    });
  });

  it("silently no-ops V2-only scope fields on V1 with console.debug", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      const handler = createPreTokenGenerationHandler({
        resolveClaims: async () => ({
          claimsToAddOrOverride: { "custom:k": "v" },
          scopesToAdd: ["extra-scope"],
          scopesToSuppress: ["unwanted"],
        }),
      });
      const event = v1Event();
      const out = (await handler(event)) as PreTokenGenerationV1Event;

      expect(debugSpy).toHaveBeenCalled();
      expect(debugSpy.mock.calls[0]?.[0] as string).toContain(
        "scopesToAdd/scopesToSuppress ignored on V1",
      );
      // The applied response shape is V1's claimsOverrideDetails;
      // no scope wiring leaks through.
      expect(out.response.claimsOverrideDetails).toBeDefined();
      expect(JSON.stringify(out.response)).not.toContain("scopesToAdd");
      expect(JSON.stringify(out.response)).not.toContain("scopesToSuppress");
    } finally {
      debugSpy.mockRestore();
    }
  });
});

describe("createPreTokenGenerationHandler — V2 event", () => {
  it("applies idTokenGeneration + accessTokenGeneration + groupOverrideDetails", async () => {
    const handler = createPreTokenGenerationHandler({
      resolveClaims: async () => ({
        claimsToAddOrOverride: { "custom:tenant_id": "t-1" },
        claimsToSuppress: ["email"],
        scopesToAdd: ["extra"],
        scopesToSuppress: ["unwanted"],
        groupsToOverride: ["admins"],
        iamRolesToOverride: ["arn:aws:iam::1:role/r"],
        preferredRole: "arn:aws:iam::1:role/r",
      }),
    });
    const event = v2Event();
    const out = (await handler(event)) as PreTokenGenerationV2Event;

    expect(out.response.claimsAndScopeOverrideDetails).toEqual({
      idTokenGeneration: {
        claimsToAddOrOverride: { "custom:tenant_id": "t-1" },
        claimsToSuppress: ["email"],
      },
      accessTokenGeneration: {
        claimsToAddOrOverride: { "custom:tenant_id": "t-1" },
        claimsToSuppress: ["email"],
        scopesToAdd: ["extra"],
        scopesToSuppress: ["unwanted"],
      },
      groupOverrideDetails: {
        groupsToOverride: ["admins"],
        iamRolesToOverride: ["arn:aws:iam::1:role/r"],
        preferredRole: "arn:aws:iam::1:role/r",
      },
    });
  });

  it("detects V2 via request.scopes even without response marker", async () => {
    const handler = createPreTokenGenerationHandler({
      resolveClaims: async () => ({
        claimsToAddOrOverride: { "custom:k": "v" },
      }),
    });
    const event = v2Event({ response: {} });
    const out = (await handler(event)) as PreTokenGenerationV2Event;
    expect(out.response.claimsAndScopeOverrideDetails).toBeDefined();
  });

  it("omits empty sub-shapes when no overrides provided", async () => {
    const handler = createPreTokenGenerationHandler({
      resolveClaims: async () => ({}),
    });
    const event = v2Event();
    const out = (await handler(event)) as PreTokenGenerationV2Event;
    expect(out.response.claimsAndScopeOverrideDetails).toEqual({});
  });

  it("emits scope-only overrides without claims", async () => {
    const handler = createPreTokenGenerationHandler({
      resolveClaims: async () => ({ scopesToAdd: ["x"] }),
    });
    const event = v2Event();
    const out = (await handler(event)) as PreTokenGenerationV2Event;
    expect(out.response.claimsAndScopeOverrideDetails?.accessTokenGeneration).toEqual({
      scopesToAdd: ["x"],
    });
    expect(out.response.claimsAndScopeOverrideDetails?.idTokenGeneration).toBeUndefined();
  });
});

describe("createPreTokenGenerationHandler — reserved claim guard", () => {
  // Every reserved entry must be rejected; the loop pins this
  // contract so additions to RESERVED_CLAIMS automatically extend the
  // test surface (the test reads the live constant).
  for (const reserved of RESERVED_CLAIMS) {
    it(`rejects reserved claim "${reserved}" with ReservedClaimError`, async () => {
      const handler = createPreTokenGenerationHandler({
        resolveClaims: async () =>
          ({
            claimsToAddOrOverride: { [reserved]: "evil" },
          }),
      });
      const event = v1Event();
      await expect(handler(event)).rejects.toBeInstanceOf(ReservedClaimError);
      try {
        await handler(event);
      } catch (err) {
        expect(err).toBeInstanceOf(ReservedClaimError);
        expect((err as ReservedClaimError).claimName).toBe(reserved);
      }
    });
  }

  it("rejects cognito:groups in claimsToAddOrOverride (use groupsToOverride instead)", async () => {
    // cognito:groups is reserved — the dedicated groupsToOverride surface
    // must be used instead; putting it in claimsToAddOrOverride is a programming error.
    const handler = createPreTokenGenerationHandler({
      resolveClaims: async () => ({
        claimsToAddOrOverride: { "cognito:groups": '["admins"]' },
      }),
    });
    const event = v1Event();
    await expect(handler(event)).rejects.toBeInstanceOf(ReservedClaimError);
  });
});

describe("createPreTokenGenerationHandler — error handling", () => {
  it("invokes onError before rethrowing on callback throw", async () => {
    const onError = vi.fn();
    const handler = createPreTokenGenerationHandler({
      resolveClaims: async () => {
        throw new Error("callback exploded");
      },
      onError,
    });
    const event = v1Event();

    await expect(handler(event)).rejects.toThrow("callback exploded");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe("callback exploded");
    expect(onError.mock.calls[0]?.[1]).toBe(event);
  });

  it("rethrows the original error even when onError itself throws", async () => {
    const handler = createPreTokenGenerationHandler({
      resolveClaims: async () => {
        throw new Error("original error");
      },
      onError: () => {
        throw new Error("onError handler is buggy");
      },
    });
    await expect(handler(v1Event())).rejects.toThrow("original error");
  });

  it("rethrows ReservedClaimError after invoking onError", async () => {
    const onError = vi.fn();
    const handler = createPreTokenGenerationHandler({
      resolveClaims: async () => ({
        claimsToAddOrOverride: { iss: "forged" },
      }),
      onError,
    });
    await expect(handler(v1Event())).rejects.toBeInstanceOf(ReservedClaimError);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("omits onError when not supplied", async () => {
    const handler = createPreTokenGenerationHandler({
      resolveClaims: async () => {
        throw new Error("no hook configured");
      },
    });
    await expect(handler(v1Event())).rejects.toThrow("no hook configured");
  });
});

describe("createPreTokenGenerationHandler — input normalisation", () => {
  it("derives federated identity from event.request.userAttributes.identities", async () => {
    let captured: ClaimResolverInput | undefined;
    const handler = createPreTokenGenerationHandler({
      resolveClaims: async (input) => {
        captured = input;
        return {};
      },
    });
    const event = v1Event({
      request: {
        userAttributes: {
          email: "a@example.com",
          identities: JSON.stringify([{ providerName: "tenant-acme", providerType: "OIDC" }]),
        },
        groupConfiguration: {},
      },
    });
    await handler(event);
    expect(captured?.identity).toEqual({
      kind: "federated",
      providerName: "tenant-acme",
      providerType: "OIDC",
    });
  });

  it("derives cognito identity when identities attribute is absent", async () => {
    let captured: ClaimResolverInput | undefined;
    const handler = createPreTokenGenerationHandler({
      resolveClaims: async (input) => {
        captured = input;
        return {};
      },
    });
    await handler(v1Event());
    expect(captured?.identity).toEqual({ kind: "cognito" });
  });

  it("plumbs untrustedClientMetadata through with caller-controlled values", async () => {
    let captured: ClaimResolverInput | undefined;
    const handler = createPreTokenGenerationHandler({
      resolveClaims: async (input) => {
        captured = input;
        return {};
      },
    });
    const metadata = { "caller-claim": "untrusted", "x-attempt": "1" };
    const event = v1Event({
      request: {
        userAttributes: {},
        groupConfiguration: {},
        clientMetadata: metadata,
      },
    });
    await handler(event);
    expect(captured?.untrustedClientMetadata).toEqual(metadata);
  });

  it("defaults untrustedClientMetadata to empty object when omitted", async () => {
    let captured: ClaimResolverInput | undefined;
    const handler = createPreTokenGenerationHandler({
      resolveClaims: async (input) => {
        captured = input;
        return {};
      },
    });
    await handler(v1Event());
    expect(captured?.untrustedClientMetadata).toEqual({});
  });

  it("sets isRefresh true for refresh-token trigger source", async () => {
    let captured: ClaimResolverInput | undefined;
    const handler = createPreTokenGenerationHandler({
      resolveClaims: async (input) => {
        captured = input;
        return {};
      },
    });
    await handler(v1Event({ triggerSource: "TokenGeneration_RefreshTokens" }));
    expect(captured?.isRefresh).toBe(true);
  });

  it("parses federatedGroups from custom:idpGroups", async () => {
    let captured: ClaimResolverInput | undefined;
    const handler = createPreTokenGenerationHandler({
      resolveClaims: async (input) => {
        captured = input;
        return {};
      },
    });
    await handler(
      v1Event({
        request: {
          userAttributes: { "custom:idpGroups": "admins, editors" },
          groupConfiguration: {},
        },
      }),
    );
    expect(captured?.federatedGroups).toEqual(["admins", "editors"]);
  });

  it("returns empty federatedGroups for native cognito users", async () => {
    let captured: ClaimResolverInput | undefined;
    const handler = createPreTokenGenerationHandler({
      resolveClaims: async (input) => {
        captured = input;
        return {};
      },
    });
    await handler(v1Event());
    expect(captured?.federatedGroups).toEqual([]);
  });
});
