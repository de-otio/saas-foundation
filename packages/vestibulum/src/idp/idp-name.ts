/**
 * Cognito IdP-name normalisation.
 *
 * Cognito's `ProviderName` field is constrained by the regex
 * `[^_\p{Z}][\p{L}\p{M}\p{S}\p{N}\p{P}][^_\p{Z}]+` with a
 * 32-character maximum (CreateIdentityProvider API ref). The
 * constraints we exercise:
 *   - no leading underscore;
 *   - no leading whitespace / Unicode space-class character;
 *   - 3+ characters in practice (the first/last/middle character
 *     classes require at least three positions to be filled).
 *
 * To produce a deterministic, Cognito-safe name from an arbitrary
 * consumer `tenantId`, this module:
 *
 *   1. Lowercases the input.
 *   2. Replaces any character outside `[a-z0-9-]` with `-`.
 *   3. Collapses runs of `-` to a single `-`.
 *   4. Strips leading/trailing `-`.
 *   5. If the result is empty (e.g. emoji-only input), substitutes
 *      a stable per-input hash so two different all-emoji tenant
 *      IDs do not collide — see the collision-detection clause
 *      below.
 *   6. Truncates to 25 characters (leaving 7 chars for the
 *      `tenant-` prefix to stay under the 32-char cap).
 *   7. Prepends `tenant-`.
 *
 * **Uniqueness guard.** Normalisation is lossy (two tenant IDs
 * sharing the first 25 normalised chars produce the same Cognito
 * name). The caller (`OidcIdpManager` / `SamlIdpManager`) passes
 * the consumer's database `{tenantId → cognitoIdpName}` mapping.
 * If a second tenant would collide with an existing record, the
 * function throws `IdpManagerError(reason: 'name_collision')` and
 * the admin UI must surface the conflict. A tenant that has
 * already been registered (i.e. its own `tenantId` is in the map
 * and maps to the same derived name) is **not** treated as a
 * collision — that's an idempotent re-upsert.
 *
 * See doc/federation/02-runtime-api.md § idp-name.ts normalisation.
 */

import { IdpManagerError } from "../errors.js";

/**
 * The fixed prefix prepended to every derived name. Reserves 7
 * characters of the 32-char Cognito limit, leaving 25 for the
 * normalised tenant slug.
 */
const PREFIX = "tenant-";

/**
 * Per spec: 32-char Cognito limit minus the 7-char prefix = 25.
 */
const MAX_SLUG = 25;

/**
 * Cognito's ProviderName limit. Asserted at the function tail as
 * a sanity check; the algorithm above already guarantees this.
 */
const MAX_TOTAL = 32;

/**
 * Derive a Cognito-safe `ProviderName` from a consumer `tenantId`.
 *
 * @param tenantId        - arbitrary consumer string (UUID, slug,
 *                          email, free text). Lossy normalisation
 *                          may produce the same name for different
 *                          inputs; see the collision clause.
 * @param existingNames   - `{tenantId → currentCognitoName}` mapping
 *                          from the consumer's database. Used to
 *                          detect collisions with previously-stored
 *                          IdPs. Pass an empty Map for a brand-new
 *                          consumer.
 *
 * @throws {IdpManagerError} with `reason: 'name_collision'` if the
 *   derived name matches a stored name belonging to a different
 *   tenant.
 *
 * The returned name always matches the Cognito regex and is ≤32
 * characters.
 */
export function normaliseIdpName(
  tenantId: string,
  existingNames: ReadonlyMap<string, string>,
): string {
  let slug = tenantId
    .toLowerCase()
    // Replace anything outside [a-z0-9-] with -. Note this also
    // catches multi-byte characters because the underlying buffer
    // is UTF-16 and each non-ASCII code unit is "outside [a-z0-9-]".
    .replace(/[^a-z0-9-]+/g, "-")
    // Collapse runs of -.
    .replace(/-+/g, "-")
    // Strip leading/trailing -.
    .replace(/^-+|-+$/g, "");

  if (slug.length === 0) {
    // Input was empty, whitespace-only, or contained no ASCII
    // alphanumerics (e.g. emoji-only, Cyrillic-only with no
    // transliteration). Substitute a stable hash so two such
    // inputs do not collide on the empty string. The hash is
    // truncated to fit MAX_SLUG.
    slug = `x${hashSlug(tenantId)}`.slice(0, MAX_SLUG);
  }

  // Truncate, then re-strip in case the truncation point lands on
  // a `-` (which would put a `-` immediately before the suffix
  // boundary, technically valid for Cognito but uglier).
  slug = slug.slice(0, MAX_SLUG).replace(/-+$/g, "");

  // Re-handle the edge case where stripping the trailing `-`
  // removed the only content (shouldn't happen because of the
  // earlier collapse-and-strip, but kept as belt-and-braces).
  /* istanbul ignore next — defensive; the earlier strip already
   * empties the slug, and the empty-input branch above
   * substituted the hash, so this is unreachable for any input. */
  if (slug.length === 0) {
    slug = `x${hashSlug(tenantId)}`.slice(0, MAX_SLUG);
  }

  const candidate = `${PREFIX}${slug}`;

  /* istanbul ignore next — defensive; MAX_SLUG + PREFIX.length is
   * exactly MAX_TOTAL by construction, so this branch is
   * unreachable. The check is kept so future refactors that move
   * either constant trip the test suite. */
  if (candidate.length > MAX_TOTAL) {
    throw new IdpManagerError(
      "name_too_long",
      `Derived ProviderName "${candidate}" exceeds Cognito's 32-character limit`,
    );
  }

  // Collision detection: scan the mapping for any other tenant
  // whose stored name equals our candidate.
  for (const [otherTenantId, storedName] of existingNames) {
    if (otherTenantId === tenantId) {
      // Same tenant re-registering — idempotent.
      continue;
    }
    if (storedName === candidate) {
      throw new IdpManagerError(
        "name_collision",
        `Derived ProviderName "${candidate}" collides with the IdP already registered for tenant "${otherTenantId}". ` +
          `The first 25 normalised characters of the two tenant IDs are identical; ` +
          `pick a more distinctive tenant identifier or rename the existing one.`,
      );
    }
  }

  return candidate;
}

/**
 * Tiny stable hash for the empty-slug fallback. Not cryptographic
 * — it only needs to map equal strings to equal slugs and
 * distinguish different strings most of the time. FNV-1a (32-bit)
 * is sufficient and dependency-free.
 *
 * Returns a lowercase hex string ≤8 characters.
 */
function hashSlug(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Force unsigned 32-bit before hex-encoding.
  return (hash >>> 0).toString(16);
}
