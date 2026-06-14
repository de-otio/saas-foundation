/**
 * `TenantResolver` interface and the `resolveTenant` entry point.
 *
 * Tenant resolution is a load-bearing authorization input: every
 * downstream "does this user have access to this tenant?" check
 * implicitly trusts the resolved `TenantId`. The trust model of HOW
 * that ID was obtained matters and is documented per-strategy in the
 * strategies/ directory.
 *
 * Resolution happens BEFORE the `RequestContext` is constructed so the
 * `tenantId` can be included in the initial (then frozen) context object.
 *
 * Pure interface. Implementations are impure when they hit DNS or a DB.
 */

import type { TenantId } from "../types/frozen/tenant.js";

/**
 * Input passed to a `TenantResolver.resolve` call.
 *
 * All fields are pre-extracted by the consumer's middleware so the
 * resolver does not need to re-parse the raw request. `claims`, when
 * present, MUST have been signature-verified by an earlier middleware
 * step — foundation has no way to detect an unverified payload.
 */
export interface TenantResolverInput {
  readonly request: Request;
  /** The lower-cased hostname (already-parsed convenience). */
  readonly hostname: string;
  /** Lowered header names. Read-only by interface contract. */
  readonly headers: ReadonlyMap<string, string>;
  /**
   * Pre-extracted JWT claims, if the consumer's auth layer has run.
   * Trust is verifier-dependent — passing unverified claims breaks the
   * authorization model.
   */
  readonly claims?: Readonly<Record<string, unknown>>;
}

/**
 * A `TenantResolver` returns:
 * - `TenantId` — resolution succeeded.
 * - `null` — resolution failed NON-fatally (e.g., a route with no
 *   tenant context). The consumer's middleware proceeds with
 *   `tenantId` unset on the `RequestContext`.
 *
 * Throw `TenantResolverError` for fatal infrastructure failures
 * (DNS outage, custom-domain DB unreachable). Throw
 * `TenantNotFoundError` for "this hostname was expected to map to a
 * tenant but did not" if your strategy treats that as fatal.
 */
export interface TenantResolver {
  resolve(input: TenantResolverInput): Promise<TenantId | null>;
}

/**
 * Thin entry point that the consumer's middleware calls. Exists as a
 * function (rather than direct `.resolve()` on the resolver instance)
 * so the call site reads naturally and so we have a single place to
 * add cross-cutting concerns (telemetry, error normalisation) if
 * required later.
 *
 * Impure: delegates to the resolver, which may perform I/O.
 */
export async function resolveTenant(
  resolver: TenantResolver,
  input: TenantResolverInput,
): Promise<TenantId | null> {
  return resolver.resolve(input);
}
