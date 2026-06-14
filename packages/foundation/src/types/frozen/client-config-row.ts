/**
 * ClientConfigRow — frozen-set persisted row shape for the ClientConfig table.
 *
 * See doc/vestibulum/shared-distribution/03-tenant-onboarding.md for the
 * canonical spec. This row is keyed on `clientId` (the Cognito app client ID)
 * and is written by the admin Lambda on tenant creation.
 *
 * The shape is frozen because changing a field here forces a migration of
 * every prior row in the ClientConfig DDB table.
 */

import type { TenantId } from "./tenant.js";
import type { TenantSubdomain } from "./tenant-subdomain.js";

export type { TenantSubdomain };

/**
 * The persisted ClientConfig row shape. Frozen because changing a field
 * here forces a migration of every prior row.
 */
export interface ClientConfigRow {
  /** Cognito app client ID. Opaque; no brand needed. Primary key. */
  readonly clientId: string;
  /** The tenant's DNS label, e.g. `acme` in `acme.tenants.example.com`. */
  readonly subdomain: TenantSubdomain;
  /** The tenant's logical identity. Immutable post-creation. */
  readonly tenantId: TenantId;
  /**
   * Full base URL for this tenant, e.g. `https://acme.tenants.example.com`.
   * Used by trigger handlers for cookie-domain validation and redirect checks.
   */
  readonly siteBaseUrl: string;
  /**
   * Email domains whose users are permitted to sign up.
   * Empty array means no domain restriction.
   */
  readonly allowedEmailDomains: readonly string[];
  /** ISO-8601 UTC datetime; set at row creation. */
  readonly createdAt: string;
  /**
   * ISO-8601 UTC datetime; set when the row is updated via `updateTenant`.
   * Absent until the first update.
   */
  readonly updatedAt?: string;
}
