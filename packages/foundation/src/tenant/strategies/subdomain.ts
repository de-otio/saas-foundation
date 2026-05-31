/**
 * `SubdomainTenantResolver`
 *
 * Strategy: extract the tenant slug from the hostname's leftmost label
 * relative to a configured `baseDomain`.
 *
 *   baseDomain = "myapp.com"
 *   "acme.myapp.com"  -> "acme"
 *   "www.myapp.com"   -> null  (well-known reserved label)
 *   "myapp.com"       -> null  (bare apex; no tenant scope)
 *   "evil.com"        -> null  (hostname does not end in baseDomain)
 *
 * SECURITY MODEL: server-controlled via DNS.
 *
 * The hostname is whatever the client typed into the address bar, but
 * the MEANING of "acme.myapp.com -> acme" is encoded in the server's
 * `baseDomain` config — the value never crosses the wire as a
 * client-controlled string. Provided the server holds DNS authority
 * for `baseDomain` (it controls the zone and decides which subdomains
 * are routed to this application), the parsed tenant slug inherits
 * that trust.
 *
 * Known caveats:
 *
 * - **Subdomain takeover.** If a stale CNAME at `acme.myapp.com`
 *   points to a deprovisioned third-party endpoint (S3 bucket, Heroku
 *   app, ...), an attacker may register the dangling endpoint and
 *   serve content from the subdomain. Mitigation: periodic DNS
 *   hygiene sweep. Not a resolver-level concern.
 *
 * - **Multi-level subdomains** (`a.b.myapp.com`). Resolution returns
 *   `a.b` (the full prefix), letting the consumer's validator reject
 *   slugs with dots if their tenant naming policy disallows them.
 *
 * - **www-stripping.** `www` is treated as a non-tenant label (returns
 *   `null`) to match the common "myapp.com and www.myapp.com both
 *   land on the marketing site" pattern. Consumers needing a literal
 *   tenant named "www" must use a different strategy.
 *
 * Pure-by-construction except for `tenantId(...)` validation, which is
 * pure but may throw.
 */

import { tenantId as makeTenantId, TenantIdValidationError } from "../../types/frozen/tenant.js";
import type { TenantId } from "../../types/frozen/tenant.js";
import type { TenantResolver, TenantResolverInput } from "../resolver.js";
import { TRUST_CLASS_KEY } from "./composite.js";

export interface SubdomainTenantResolverOptions {
  /**
   * The application's base domain (e.g., "myapp.com"). Hostnames not
   * ending in `.${baseDomain}` (or equal to `baseDomain` itself)
   * resolve to `null`. Compared case-insensitively.
   */
  readonly baseDomain: string;

  /**
   * Labels that, when they appear as the leftmost subdomain, resolve
   * to `null` rather than being treated as a tenant slug. Defaults to
   * `["www"]`. Compared case-insensitively. Consumers extend this for
   * their own reserved labels (e.g., `["www", "api", "admin"]`) at
   * the resolver layer; the foundation does not ship a list because
   * reserved-name policy is consumer-domain.
   */
  readonly reservedLabels?: ReadonlyArray<string>;
}

const DEFAULT_RESERVED_LABELS: ReadonlyArray<string> = ["www"];

export class SubdomainTenantResolver implements TenantResolver {
  /** Trust-class marker consumed by `CompositeTenantResolver`. */
  public readonly [TRUST_CLASS_KEY] = "server-trust-anchored" as const;

  private readonly baseDomain: string;
  private readonly reservedLabels: ReadonlySet<string>;

  public constructor(options: SubdomainTenantResolverOptions) {
    if (options.baseDomain.length === 0) {
      throw new Error("SubdomainTenantResolver: baseDomain must be non-empty");
    }
    this.baseDomain = options.baseDomain.toLowerCase();
    const reserved =
      options.reservedLabels !== undefined ? options.reservedLabels : DEFAULT_RESERVED_LABELS;
    this.reservedLabels = new Set(reserved.map((label) => label.toLowerCase()));
  }

  public resolve(input: TenantResolverInput): Promise<TenantId | null> {
    return Promise.resolve(this.resolveSync(input));
  }

  private resolveSync(input: TenantResolverInput): TenantId | null {
    const host = input.hostname.toLowerCase();

    // Strip any trailing dot (fully-qualified DNS form) and an optional port.
    const normalized = host.replace(/\.$/, "").replace(/:\d+$/, "");

    // Bare apex — no tenant scope.
    if (normalized === this.baseDomain) {
      return null;
    }

    const suffix = `.${this.baseDomain}`;
    if (!normalized.endsWith(suffix)) {
      return null;
    }

    const candidate = normalized.slice(0, normalized.length - suffix.length);
    if (candidate.length === 0) {
      return null;
    }

    // The leftmost label is what we check against the reserved set;
    // multi-level prefixes ("a.b") are returned whole and the
    // consumer's slug validator decides their fate.
    const leftmost = candidate.split(".")[0] ?? "";
    if (this.reservedLabels.has(leftmost)) {
      return null;
    }

    try {
      return makeTenantId(candidate);
    } catch (err) {
      if (err instanceof TenantIdValidationError) {
        return null;
      }
      throw err;
    }
  }
}
