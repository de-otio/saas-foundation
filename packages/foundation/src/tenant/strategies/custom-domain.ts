/**
 * `CustomDomainTenantResolver`
 *
 * Strategy: look up the request's full hostname in a consumer-supplied
 * mapping from hostname -> tenant. The lookup function typically hits
 * a custom-domains table the consumer maintains.
 *
 *   "app.acme.com"     -> lookup("app.acme.com") -> "acme"
 *   "unknown.host.io"  -> lookup(...) -> null    (no mapping)
 *
 * SECURITY MODEL: server-controlled via the consumer's DB.
 *
 * The hostname is the lookup key; the value comes from a table the
 * foundation does not write. The trust property reduces to "the
 * consumer's `lookup` function only returns a `TenantId` for
 * hostnames the tenant has demonstrated control over." The typical
 * demonstration is:
 *
 *   - DNS TXT challenge during onboarding
 *   - ACME HTTP-01 / DNS-01 verification (also confirms control)
 *   - Manual operator verification for high-value tenants
 *
 * Provided that gate is honest, this is the most trustworthy bundled
 * strategy: the entire authorization chain runs through state the
 * server controls (the DB) keyed on a value the server controls (the
 * Host header reaching the load balancer, which the ALB / API Gateway
 * validates against its certificate SNI). A client that lies about
 * Host either gets a TLS mismatch or hits a hostname with no DB
 * mapping.
 *
 * Known caveats:
 *
 * - **Cache cost.** Looking up `hostname -> tenantId` on every request
 *   is expensive at scale. The foundation does NOT cache; the
 *   consumer wraps `lookup` with their own cache (in-memory LRU is
 *   usually enough). Documented at the resolver-doc level
 *   (`doc/foundation/05-tenant-context.md`).
 *
 * - **Case sensitivity.** Hostnames are case-insensitive by RFC.
 *   The resolver lowercases the incoming hostname before calling
 *   `lookup`; the consumer should store keys in lower case.
 *
 * - **Trailing dot / port stripping.** The resolver normalises both
 *   before calling `lookup`, matching subdomain-resolver behaviour.
 *
 * Impure: delegates to a consumer-supplied lookup function (typically
 * a DB call).
 */

import {
  tenantId as makeTenantId,
  TenantIdValidationError,
  isTenantId,
} from "../../types/frozen/tenant.js";
import type { TenantId } from "../../types/frozen/tenant.js";
import type { TenantResolver, TenantResolverInput } from "../resolver.js";
import { TenantResolverError } from "../errors.js";
import { TRUST_CLASS_KEY } from "./composite.js";

export interface CustomDomainTenantResolverOptions {
  /**
   * The lookup function. Receives a normalised lowercased hostname
   * and returns the mapped `TenantId` or `null` for an unknown host.
   *
   * The function should NEVER return a `TenantId` for a hostname the
   * tenant has not verified control over. This is the trust gate; the
   * resolver assumes it has been honoured.
   *
   * The function may return either a branded `TenantId` (preferred,
   * the type system reminds you to validate at the boundary) or a
   * plain string (re-validated by the resolver against the foundation
   * `TenantId` constraints; an invalid candidate is treated as
   * `null`).
   */
  readonly lookup: (hostname: string) => Promise<TenantId | string | null>;
}

export class CustomDomainTenantResolver implements TenantResolver {
  /** Trust-class marker consumed by `CompositeTenantResolver`. */
  public readonly [TRUST_CLASS_KEY] = "server-trust-anchored" as const;

  private readonly lookup: (hostname: string) => Promise<TenantId | string | null>;

  public constructor(options: CustomDomainTenantResolverOptions) {
    this.lookup = options.lookup;
  }

  public async resolve(input: TenantResolverInput): Promise<TenantId | null> {
    const host = input.hostname.toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
    if (host.length === 0) return null;

    let result: TenantId | string | null;
    try {
      result = await this.lookup(host);
    } catch (err) {
      throw new TenantResolverError(`custom-domain lookup failed for ${host}`, {
        hostname: host,
        cause: err,
      });
    }

    if (result === null || result === undefined) return null;

    // Already branded? Trust the caller's type assertion.
    if (typeof result === "string" && isTenantId(result)) {
      return result;
    }

    // Plain string — re-validate at the boundary.
    try {
      return makeTenantId(result);
    } catch (err) {
      if (err instanceof TenantIdValidationError) {
        return null;
      }
      throw err;
    }
  }
}
