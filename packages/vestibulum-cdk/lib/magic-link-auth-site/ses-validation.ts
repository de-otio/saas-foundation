/**
 * Synth-time validation of an SES sender address against a Route53 hosted
 * zone name. Per the integrated security review (S-C11): a sender domain
 * that does not match the zone is a deploy-time DKIM / SPF failure, but
 * by the time DKIM records fail to publish the consumer has already
 * deployed the construct. Failing fast at synth keeps the feedback loop
 * tight.
 *
 * This helper is independent of any CDK construct so it can be reused
 * from both `MagicLinkIdentity` (where the sender lives) and from any
 * future Site-scoped sender configuration.
 */

/**
 * Thrown when the SES sender address is malformed (no `@`, no domain
 * part, or empty local part). The message is deliberately specific so
 * the consumer can find the offending prop quickly.
 */
export class SesSenderShapeError extends Error {
  public override readonly name = "SesSenderShapeError";
  public constructor(sender: string) {
    super(
      `sesIdentitySender must be a fully-qualified email address ` +
        `(e.g. 'noreply@example.com'); got: ${JSON.stringify(sender)}.`,
    );
  }
}

/**
 * Thrown when the SES sender's domain part is not covered by the
 * supplied hosted zone. The construct cannot publish DKIM / SPF records
 * for a domain outside the zone, so DKIM verification would fail at
 * deploy time. Fail at synth instead.
 */
export class SesSenderDomainMismatchError extends Error {
  public override readonly name = "SesSenderDomainMismatchError";
  public constructor(senderDomain: string, zoneName: string) {
    super(
      `SES sender domain '${senderDomain}' is not covered by the ` +
        `Route53 hosted zone '${zoneName}'. Vestibulum publishes DKIM ` +
        `CNAME records into the supplied hosted zone, so the sender ` +
        `domain MUST equal the zone name or be a subdomain of it. ` +
        `Either change 'sesIdentitySender' to match the zone, or pass ` +
        `a different 'hostedZone' that covers the sender domain.`,
    );
  }
}

/**
 * Returns the domain portion of an email address.
 *
 * @throws SesSenderShapeError when the address has no `@` or no
 *   domain part.
 */
export function extractSenderDomain(sender: string): string {
  // Cheap shape guard; full RFC 5321 validation is out of scope.
  const at = sender.indexOf("@");
  if (at < 1 || at === sender.length - 1) {
    throw new SesSenderShapeError(sender);
  }
  const local = sender.slice(0, at);
  const domain = sender.slice(at + 1);
  if (local.length === 0 || domain.length === 0 || domain.includes("@")) {
    throw new SesSenderShapeError(sender);
  }
  return domain.toLowerCase();
}

/**
 * Asserts that the sender's domain matches (or is a subdomain of) the
 * supplied hosted zone name. Zone-name comparison is case-insensitive
 * and tolerant of a trailing dot.
 *
 * Both arguments may be CDK tokens at synth time (the hosted zone may
 * be resolved from a Route53 lookup that doesn't run until synth). The
 * helper short-circuits the comparison when either looks like a token,
 * since the comparison can't be meaningfully done before the values
 * resolve.
 *
 * @throws SesSenderShapeError | SesSenderDomainMismatchError
 */
export function validateSenderAgainstZone(sender: string, zoneName: string): void {
  if (looksLikeToken(sender) || looksLikeToken(zoneName)) {
    // Defer to deploy-time validation; synth-time comparison would be
    // a false positive against the token string.
    return;
  }
  const senderDomain = extractSenderDomain(sender);
  const zone = stripTrailingDot(zoneName.toLowerCase());
  if (senderDomain === zone) {
    return;
  }
  if (senderDomain.endsWith(`.${zone}`)) {
    return;
  }
  throw new SesSenderDomainMismatchError(senderDomain, zone);
}

function stripTrailingDot(value: string): string {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

function looksLikeToken(value: string): boolean {
  // CDK tokens render as `${Token[...]}` strings; conservative check.
  return value.includes("${Token[") || /^\$\{[A-Za-z0-9_.-]+\}$/.test(value);
}
