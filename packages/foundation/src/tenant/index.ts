/**
 * `@de-otio/saas-foundation/tenant` barrel.
 *
 * Tenant resolution and the `AsyncLocalStorage` carrier that
 * propagates a resolved `TenantId` through a request scope.
 *
 * Primary exports:
 * - `TenantId` (re-export from frozen vocabulary), `tenantId`, `isTenantId`
 * - `TenantResolver`, `TenantResolverInput`, `resolveTenant`
 * - Bundled v0.1 strategies: `SubdomainTenantResolver`,
 *   `CustomDomainTenantResolver`, `CompositeTenantResolver`
 * - ALS carrier: `runWithTenantContext`, `getCurrentTenantId`
 * - Named errors: `TenantNotFoundError`, `TenantResolverError`,
 *   `TenantAuthorizationError`
 *
 * Per `doc/foundation/05-tenant-context.md`: `Header`, `JwtClaim`,
 * `PathPrefix` strategies are listed as candidate-only (see the doc's
 * § Candidate strategies); they do not ship in v0.1 because no
 * current consumer requires them and each has a non-trivial trust
 * model that benefits from a focused review at first use.
 */

// Frozen vocabulary
export type { TenantId, TenantIdConstraints } from "../types/frozen/tenant.js";
export {
  TENANT_ID_CONSTRAINTS,
  TenantIdValidationError,
  tenantId,
  isTenantId,
} from "../types/frozen/tenant.js";

// Resolver interface + entry point
export type { TenantResolver, TenantResolverInput } from "./resolver.js";
export { resolveTenant } from "./resolver.js";

// Bundled strategies
export type { SubdomainTenantResolverOptions } from "./strategies/subdomain.js";
export { SubdomainTenantResolver } from "./strategies/subdomain.js";

export type { CustomDomainTenantResolverOptions } from "./strategies/custom-domain.js";
export { CustomDomainTenantResolver } from "./strategies/custom-domain.js";

export type { TenantResolverTrustClass } from "./strategies/composite.js";
export {
  CompositeTenantResolver,
  TRUST_CLASS_KEY,
  getResolverTrustClass,
} from "./strategies/composite.js";

// ALS carrier
export { tenantStorage, runWithTenantContext, getCurrentTenantId } from "./als.js";

// Named errors
export { TenantResolverError, TenantNotFoundError, TenantAuthorizationError } from "./errors.js";
