/**
 * Magic-link email construction + delivery via SES.
 *
 * Two non-negotiables baked into this file:
 *
 *   1. The URL puts the token in the URL **fragment** (`#token=...`), never
 *      the query string. Browsers send query strings in `Referer` headers
 *      and link scanners follow query-string links (consuming single-use
 *      tokens); fragments avoid both. See doc/01 § Mitigation 3.
 *
 *   2. The plain-text body and the HTML body both use the fragment URL.
 *      No "click here" anchor uses a different URL.
 */

import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

export interface MagicLinkEmailOptions {
  readonly sesClient: SESClient;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly domain: string;
  /** base64url-encoded random token. */
  readonly token: string;
  /** Subject line override. Defaults to "Your sign-in link". */
  readonly subject?: string;
  /** TTL in minutes (for the body copy). Defaults to 15. */
  readonly ttlMinutes?: number;
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
 * Both the plain-text and HTML bodies contain the fragment URL. Failures
 * propagate — the caller maps any send failure to the generic
 * `Error("Authentication failed")` so the consumer sees enumeration parity.
 */
export async function sendMagicLinkEmail(opts: MagicLinkEmailOptions): Promise<void> {
  const url = buildMagicLinkUrl(opts.domain, opts.token);
  const ttl = opts.ttlMinutes ?? 15;
  const subject = opts.subject ?? "Your sign-in link";

  const textBody = [
    "Sign in by opening this link in the same browser you started in.",
    "",
    url,
    "",
    `This link expires in ${ttl} minutes and can be used only once.`,
    "If you did not request this, you can ignore this message.",
  ].join("\n");

  const htmlBody = [
    "<!doctype html>",
    '<html><body style="font-family: system-ui, sans-serif;">',
    "<p>Sign in by opening this link in the same browser you started in.</p>",
    `<p><a href="${url}">${url}</a></p>`,
    `<p>This link expires in ${ttl} minutes and can be used only once.</p>`,
    "<p>If you did not request this, you can ignore this message.</p>",
    "</body></html>",
  ].join("\n");

  await opts.sesClient.send(
    new SendEmailCommand({
      Source: opts.fromAddress,
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
