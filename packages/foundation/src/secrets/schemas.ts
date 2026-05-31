/**
 * Boundary validation schemas for the secrets module.
 *
 * The frozen `SecretRefSchema` is the canonical Zod schema for
 * `SecretRef`; it lives in the frozen-types directory and is
 * re-exported here for ergonomic consumer imports.
 *
 * Per doc/foundation/01-package-api.md § Conventions, "Zod schemas
 * live next to the types they validate." The frozen type's schema
 * stays in the frozen directory (single source of truth for the CI
 * fanout gate); this file re-exports it for callers who want
 * `import { SecretRefSchema } from '@de-otio/saas-foundation/secrets'`.
 */

export { SecretRefSchema } from "../types/frozen/schemas.js";
