import { describe, it, expect, vi } from "vitest";
import {
  createPostConfirmationHandler,
  type PostConfirmationHandler,
} from "../../src/lambda/post-confirmation.js";
import type { PostConfirmationEvent } from "../../src/lambda/cognito-events.js";
import type { Provisioner, ProvisionerInput } from "../../src/callbacks/types.js";

function postConfEvent(overrides: Partial<PostConfirmationEvent> = {}): PostConfirmationEvent {
  return {
    version: "1",
    region: "eu-central-1",
    userPoolId: "eu-central-1_test",
    triggerSource: "PostConfirmation_ConfirmSignUp",
    userName: "sub-1",
    callerContext: { awsSdkVersion: "1.0", clientId: "client-1" },
    request: {
      userAttributes: { email: "a@example.com" },
    },
    response: {},
    ...overrides,
  };
}

describe("createPostConfirmationHandler — success path", () => {
  it("returns the event unmodified after the provisioner succeeds", async () => {
    const provision: Provisioner = async () => {
      /* no-op */
    };
    const handler: PostConfirmationHandler = createPostConfirmationHandler({
      provision,
    });
    const event = postConfEvent();
    const out = await handler(event);
    expect(out).toBe(event);
    // Response is the original empty object -- Cognito ignores it on
    // post-confirmation, but the handler MUST NOT mutate it.
    expect(out.response).toEqual({});
  });

  it("passes a normalised ProvisionerInput to the callback", async () => {
    let captured: ProvisionerInput | undefined;
    const handler = createPostConfirmationHandler({
      provision: async (input) => {
        captured = input;
      },
    });
    const event = postConfEvent({
      request: {
        userAttributes: {
          email: "a@example.com",
          identities: JSON.stringify([{ providerName: "tenant-acme", providerType: "SAML" }]),
        },
        clientMetadata: { x: "untrusted" },
      },
    });
    await handler(event);
    expect(captured?.userSub).toBe("sub-1");
    expect(captured?.clientId).toBe("client-1");
    expect(captured?.userAttributes).toBe(event.request.userAttributes);
    expect(captured?.triggerSource).toBe("PostConfirmation_ConfirmSignUp");
    expect(captured?.identity).toEqual({
      kind: "federated",
      providerName: "tenant-acme",
      providerType: "SAML",
    });
    expect(captured?.untrustedClientMetadata).toEqual({ x: "untrusted" });
  });

  it("defaults clientMetadata to an empty object when absent", async () => {
    let captured: ProvisionerInput | undefined;
    const handler = createPostConfirmationHandler({
      provision: async (input) => {
        captured = input;
      },
    });
    await handler(postConfEvent());
    expect(captured?.untrustedClientMetadata).toEqual({});
  });

  it("returns identity=cognito for native confirmations", async () => {
    let captured: ProvisionerInput | undefined;
    const handler = createPostConfirmationHandler({
      provision: async (input) => {
        captured = input;
      },
    });
    await handler(postConfEvent());
    expect(captured?.identity).toEqual({ kind: "cognito" });
  });
});

describe("createPostConfirmationHandler — triggerSource open union", () => {
  it.each([
    "PostConfirmation_ConfirmSignUp",
    "PostConfirmation_ConfirmForgotPassword",
    // Future-proofing: open string union accepts arbitrary values
    "SCIM_Create",
    "SCIM_Update",
    "SCIM_Deactivate",
    "CustomProvisioning_HookFiredFromInfraSomeday",
  ])("forwards triggerSource %s to the callback", async (triggerSource) => {
    let captured: ProvisionerInput | undefined;
    const handler = createPostConfirmationHandler({
      provision: async (input) => {
        captured = input;
      },
    });
    await handler(postConfEvent({ triggerSource }));
    expect(captured?.triggerSource).toBe(triggerSource);
  });
});

describe("createPostConfirmationHandler — error handling", () => {
  it("rethrows callback errors so Cognito rolls back the confirmation", async () => {
    const handler = createPostConfirmationHandler({
      provision: async () => {
        throw new Error("database down");
      },
    });
    await expect(handler(postConfEvent())).rejects.toThrow("database down");
  });

  it("invokes onError before rethrowing", async () => {
    const onError = vi.fn();
    const handler = createPostConfirmationHandler({
      provision: async () => {
        throw new Error("fail");
      },
      onError,
    });
    const event = postConfEvent();
    await expect(handler(event)).rejects.toThrow("fail");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0]?.[1]).toBe(event);
  });

  it("rethrows original error even when onError throws", async () => {
    const handler = createPostConfirmationHandler({
      provision: async () => {
        throw new Error("original");
      },
      onError: () => {
        throw new Error("hook error");
      },
    });
    await expect(handler(postConfEvent())).rejects.toThrow("original");
  });

  it("omits onError when not supplied", async () => {
    const handler = createPostConfirmationHandler({
      provision: async () => {
        throw new Error("boom");
      },
    });
    await expect(handler(postConfEvent())).rejects.toThrow("boom");
  });
});
