/**
 * Magic-link email construction + delivery via SES.
 *
 * Non-negotiables baked into this file:
 *
 *   1. The URL puts the token in the URL **fragment** (`#token=...`), never
 *      the query string. Browsers send query strings in `Referer` headers
 *      and link scanners follow query-string links (consuming single-use
 *      tokens); fragments avoid both. See doc/01 § Mitigation 3.
 *
 *   2. The plain-text body and the HTML body both use the fragment URL.
 *      No "click here" anchor uses a different URL.
 *
 *   3. The link stays primary. The 8-digit code is the fallback for a link
 *      opened in another browser or on another device
 *      (`signin_link_bound_to_requesting_browser`): it is typed into the
 *      browser that asked.
 */

import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

export interface MagicLinkEmailOptions {
  readonly sesClient: SESClient;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly domain: string;
  /** base64url-encoded random token. */
  readonly token: string;
  /** The 8-digit typed fallback for the same sign-in. */
  readonly code: string;
  /** Subject line override. Defaults to "Your sign-in link". */
  readonly subject?: string;
  /** TTL in minutes (for the body copy). Defaults to 10. */
  readonly ttlMinutes?: number;
  /**
   * SES configuration set. Its event destination publishes bounces and
   * complaints to the bounce topic; without it SES never reports them.
   */
  readonly configurationSetName?: string;
}

/**
 * Returns the magic-link URL for a given domain and token.
 *
 * Always fragment-based (`#token=...`). The `/login/callback` page reads the
 * fragment, calls `history.replaceState` to scrub it, then POSTs the token
 * to `/auth-verify`.
 */
export function buildMagicLinkUrl(domain: string, token: string): string {
  return `https://${domain}/login/callback#token=${token}`;
}

/**
 * Sends a magic-link email via SES.
 *
 * Both the plain-text and HTML bodies contain the fragment URL and the code.
 * Failures propagate — the caller maps any send failure to the unanswerable
 * challenge so the consumer sees enumeration parity.
 */
export async function sendMagicLinkEmail(opts: MagicLinkEmailOptions): Promise<void> {
  const url = buildMagicLinkUrl(opts.domain, opts.token);
  const ttl = opts.ttlMinutes ?? 10;
  const subject = opts.subject ?? "Your sign-in link";

  const textBody = [
    "Sign in by opening this link in the same browser you started in.",
    "",
    url,
    "",
    "Opened it somewhere else? Go back to the browser where you asked for this " +
      "link and enter this code there instead:",
    "",
    opts.code,
    "",
    "Never share this code with anyone. Nobody from us will ever ask you for it.",
    "",
    `This link expires in ${ttl} minutes and can be used only once. The code expires with it.`,
    "If you did not request this, you can ignore this message.",
  ].join("\n");

  const htmlBody = [
    "<!doctype html>",
    '<html><body style="font-family: system-ui, sans-serif;">',
    "<p>Sign in by opening this link in the same browser you started in.</p>",
    `<p><a href="${url}">${url}</a></p>`,
    "<p>Opened it somewhere else? Go back to the browser where you asked for this " +
      "link and enter this code there instead:</p>",
    `<p style="font-size: 1.5em; letter-spacing: 0.15em;"><strong>${opts.code}</strong></p>`,
    "<p>Never share this code with anyone. Nobody from us will ever ask you for it.</p>",
    `<p>This link expires in ${ttl} minutes and can be used only once. The code expires with it.</p>`,
    "<p>If you did not request this, you can ignore this message.</p>",
    "</body></html>",
  ].join("\n");

  await opts.sesClient.send(
    new SendEmailCommand({
      Source: opts.fromAddress,
      ...(opts.configurationSetName !== undefined && opts.configurationSetName !== ""
        ? { ConfigurationSetName: opts.configurationSetName }
        : {}),
      Destination: { ToAddresses: [opts.toAddress] },
      Message: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: textBody, Charset: "UTF-8" },
          Html: { Data: htmlBody, Charset: "UTF-8" },
        },
      },
    }),
  );
}
