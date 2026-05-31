/**
 * RequestContext — frozen-set ALS carrier shape.
 *
 * See doc/04-shared-vocabulary.md § RequestContext for the canonical spec.
 *
 * Carried via AsyncLocalStorage (foundation's request-context module
 * owns the lifecycle, landing in P3). The shape is frozen so deep
 * helpers (logger, audit-event-builder) can rely on its fields
 * existing.
 *
 * The interface is intentionally OPEN to TS declaration merging:
 * consumers extend `RequestContext` with custom fields via
 *   declare module '@de-otio/saas-foundation' { interface RequestContext { ... } }
 * The frozen-set guarantees apply only to the fields defined here.
 *
 * Replacement-vs-mutation semantics (per B-L of the initial review,
 * already reconciled in 04-shared-vocabulary.md):
 *   - The runtime object is `Object.freeze`d before being set on the ALS.
 *   - Mid-request mutation is forbidden.
 *   - Replacement with a fresh frozen object via `setRequestContext` is
 *     permitted only during the early-request phase (after tenant
 *     resolution + auth verification, before handler dispatch). The
 *     guard mechanics live in foundation's request-context module.
 */

import type { TenantId } from "./tenant.js";

/** Closed: the three kinds exhaust meaningful authentication states. */
export type Principal =
  | {
      readonly kind: "user";
      readonly userSub: string;
      readonly sessionId: string;
    }
  | { readonly kind: "service"; readonly serviceName: string }
  | { readonly kind: "anonymous" };

export interface RequestContext {
  /** Generated per request; non-empty string. */
  readonly requestId: string;
  /** Epoch ms at request entry. */
  readonly startedAt: number;
  /** Absent for pre-tenant operations (sign-up, login, IdP discovery). */
  readonly tenantId?: TenantId;
  /** Absent if the request is anonymous or pre-auth. */
  readonly principal?: Principal;
  /** Distributed tracing identifier. */
  readonly traceId?: string;
  /** AWS region serving the request. */
  readonly region?: string;
  /** Where this tenant's data lives, if different from the serving region. */
  readonly residencyRegion?: string;
  /** Trusted-proxy-resolved client IP. */
  readonly clientIp?: string;
}
