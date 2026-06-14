/**
 * `CompositeTenantResolver`
 *
 * Strategy: try a list of resolvers in order, returning the first
 * non-null result. Errors short-circuit — they do NOT fall through to
 * the next resolver. The verified-source-first ordering means an
 * early error is meaningful (e.g., the subdomain DNS resolver is
 * down) and should be surfaced rather than silently retried against a
 * less-trusted source.
 *
 * SECURITY MODEL: composes the trust models of its constituent
 * resolvers. **Order resolvers verified-source-first.**
 *
 * The bundled v0.1 resolvers (`SubdomainTenantResolver`,
 * `CustomDomainTenantResolver`) are both server-trust-anchored, so a
 * composite of those two is safe in either order on trust grounds —
 * order is then a fallback-chain choice, not a security choice.
 *
 * The moment an untrusted-source strategy ships (header, JWT claim,
 * path prefix), mixed-trust composition becomes the dangerous case.
 * The doc-level guidance is: do NOT mix trusted and untrusted
 * strategies in a single composite. This class enforces a runtime
 * guard:
 *
 *   - Each resolver may declare its trust class via a
 *     `__trustClass` symbol on the instance. Bundled trusted
 *     strategies (`Subdomain`, `CustomDomain`) set this to
 *     `"server-trust-anchored"`. Future untrusted strategies that
 *     ship would set `"untrusted"`.
 *   - If a composite contains both classes, the constructor throws.
 *
 * The guard is best-effort: it catches the case where a consumer
 * explicitly mixes trust classes, not the case where the consumer
 * supplies a hand-rolled resolver that lies about its trust class.
 * Foundation cannot detect a dishonest implementation.
 *
 * Pure-by-construction except for delegation to constituent resolvers.
 */

import type { TenantId } from "../../types/frozen/tenant.js";
import type { TenantResolver, TenantResolverInput } from "../resolver.js";

/**
 * Trust-class marker. Bundled trusted strategies set this on their
 * instances; untrusted strategies would set the contrasting value.
 * The marker is a symbol-keyed property so it does not appear in the
 * resolver's public interface.
 */
export const TRUST_CLASS_KEY: unique symbol = Symbol.for("foundation.tenant.trustClass");

export type TenantResolverTrustClass = "server-trust-anchored" | "untrusted";

/** Type guard for inspecting an unknown resolver's declared trust class. */
export function getResolverTrustClass(
  resolver: TenantResolver,
): TenantResolverTrustClass | undefined {
  const value = (resolver as unknown as Record<symbol, unknown>)[TRUST_CLASS_KEY];
  if (value === "server-trust-anchored" || value === "untrusted") {
    return value;
  }
  return undefined;
}

export class CompositeTenantResolver implements TenantResolver {
  private readonly resolvers: ReadonlyArray<TenantResolver>;

  public constructor(resolvers: ReadonlyArray<TenantResolver>) {
    if (resolvers.length === 0) {
      throw new Error("CompositeTenantResolver: at least one resolver is required");
    }

    // Mixed-trust guard. Only fires when at least one resolver
    // declares an explicit trust class AND the set contains both
    // "server-trust-anchored" and "untrusted".
    const classes = new Set<TenantResolverTrustClass>();
    for (const r of resolvers) {
      const cls = getResolverTrustClass(r);
      if (cls !== undefined) classes.add(cls);
    }
    if (classes.has("server-trust-anchored") && classes.has("untrusted")) {
      throw new Error(
        "CompositeTenantResolver: refusing to mix server-trust-anchored and untrusted resolvers. " +
          "Mixed-trust composition lets an untrusted strategy override a verified one when the trusted strategy " +
          "returns null. Build separate composites per trust class.",
      );
    }

    this.resolvers = resolvers;
  }

  public async resolve(input: TenantResolverInput): Promise<TenantId | null> {
    for (const r of this.resolvers) {
      // Errors short-circuit by design — see file header.
      const result = await r.resolve(input);
      if (result !== null) {
        return result;
      }
    }
    return null;
  }
}
