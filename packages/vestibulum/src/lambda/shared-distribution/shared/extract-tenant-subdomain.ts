/**
 * Extracts the tenant subdomain label from a Host header value (review fix H1).
 *
 * Returns the label (e.g. "acme") or null if the host is not a valid tenant
 * subdomain under the given parent.
 *
 * Processing steps (in order):
 *  1. Strip port if present (`host:port` → `host`).
 *  2. Lowercase the result.
 *  3. Strip RFC-1035 trailing dot (FQDN absolute form).
 *  4. Normalise parent the same way (strip trailing dot if any).
 *  5. Require the host to end with `.<parent>` exactly.
 *  6. Require the candidate label to be a single DNS label (no dots).
 *  7. Require the candidate to match `pattern` (default: tenant-safe DNS label).
 *
 * Examples (parent = "tenants.example.com"):
 *   "acme.tenants.example.com"         → "acme"
 *   "ACME.TENANTS.EXAMPLE.COM"         → "acme"  (lowercased)
 *   "acme.tenants.example.com:443"     → "acme"  (port stripped)
 *   "acme.tenants.example.com."        → "acme"  (trailing dot stripped)
 *   "acme.tenants.example.com.:443"    → "acme"  (trailing dot + port)
 *   "acme.bob.tenants.example.com"     → null    (multi-level)
 *   "tenants.example.com"              → null    (apex, no subdomain)
 *   ".tenants.example.com"             → null    (empty label)
 *   "1acme.tenants.example.com"        → null    (leading digit, fails pattern)
 *   "acme.evil.com"                    → null    (wrong parent)
 */

/** Default tenant subdomain pattern: alpha-start, lowercase, no trailing dash. */
const DEFAULT_TENANT_PATTERN = /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/;

export function extractTenantSubdomain(
  host: string | undefined,
  parent: string,
  pattern: RegExp = DEFAULT_TENANT_PATTERN,
): string | null {
  if (host === undefined || host === '') return null;

  // 1. Strip port. `split` always returns at least one element so `[0]` is safe.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const hostNoPort = host.split(':')[0]!;

  // 2. Lowercase.
  // 3. Strip RFC-1035 trailing dot.
  const hostNorm = hostNoPort.toLowerCase().replace(/\.$/, '');

  // 4. Normalise parent (strip trailing dot if any).
  const parentNorm = parent.replace(/\.$/, '');

  // 5. Must end with `.<parent>` exactly.
  const suffix = '.' + parentNorm;
  if (!hostNorm.endsWith(suffix)) return null;

  // 6. Candidate is everything before the suffix.
  const candidate = hostNorm.slice(0, hostNorm.length - suffix.length);

  if (candidate.length === 0) return null;

  // Must be a single DNS label (no embedded dots).
  if (candidate.includes('.')) return null;

  // 7. Must match tenant pattern.
  if (!pattern.test(candidate)) return null;

  return candidate;
}
