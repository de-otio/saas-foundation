/**
 * The mail — signin_secret_in_fragment_only (I5): the token is in the URL
 * fragment, never in the path or query string, in both the text and HTML parts.
 */

import { describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

import {
  buildMagicLinkUrl,
  sendMagicLinkEmail,
} from "../../../../src/lambda/handlers/create-auth-challenge/magic-link-email.js";

const TOKEN = "Tk".repeat(21) + "x"; // 43 chars, base64url-shaped

describe("buildMagicLinkUrl", () => {
  it("puts the token in the fragment only", () => {
    const url = new URL(buildMagicLinkUrl("app.example.com", TOKEN));
    expect(url.origin).toBe("https://app.example.com");
    expect(url.pathname).toBe("/login/callback");
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#token=${TOKEN}`);
    expect(url.pathname).not.toContain(TOKEN);
  });
});

describe("sendMagicLinkEmail", () => {
  const ses = mockClient(SESClient);

  async function send(extra: { configurationSetName?: string; ttlMinutes?: number } = {}) {
    ses.reset();
    ses.on(SendEmailCommand).resolves({});
    await sendMagicLinkEmail({
      sesClient: ses as unknown as SESClient,
      fromAddress: "login@example.com",
      toAddress: "person@example.com",
      domain: "app.example.com",
      token: TOKEN,
      ...extra,
    });
    return ses.commandCalls(SendEmailCommand)[0]!.args[0].input;
  }

  it("both parts carry the fragment link and neither carries the token in a query string", async () => {
    const input = await send();
    for (const body of [input.Message?.Body?.Text?.Data, input.Message?.Body?.Html?.Data]) {
      expect(body).toContain(`https://app.example.com/login/callback#token=${TOKEN}`);
      expect(body).not.toMatch(/[?&]token=/);
    }
  });

  it("states a 10 minute lifetime by default", async () => {
    const input = await send();
    expect(input.Message?.Body?.Text?.Data).toContain("expires in 10 minutes");
  });

  it("sets ConfigurationSetName only when given", async () => {
    expect(await send({ configurationSetName: "cs" })).toMatchObject({ ConfigurationSetName: "cs" });
    expect(await send()).not.toHaveProperty("ConfigurationSetName");
    expect(await send({ configurationSetName: "" })).not.toHaveProperty("ConfigurationSetName");
  });
});
