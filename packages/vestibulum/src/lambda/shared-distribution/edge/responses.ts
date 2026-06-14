/**
 * Helpers for the shared-distribution edge `check-auth` handler:
 *
 * - `refuse(req, reason)` — emit a 403 with no body, log a structured
 *   metric line via stdout, return a synthesized response object.
 * - `loginRedirect(req, subdomain)` — emit a 302 to the tenant's
 *   `/login` path, preserving the originally-requested URI as a `next`
 *   parameter (best-effort).
 * - `extractTokenFromCookies(cookieHeader)` — parse the `Cookie`
 *   header(s) and pull out the ID-token value (`vestibulum_id_token`).
 *
 * The metric emission is a stdout-JSON line that downstream observability
 * subscribers parse. Lambda@Edge cannot use the CloudWatch SDK directly
 * (no `@aws-sdk/*` in the bundle), so a structured log line is the
 * canonical emission point.
 */

import type {
  CloudFrontHeaders,
  CloudFrontRequest,
  CloudFrontResultResponse,
} from './cloudfront-types.js';

/** ID-token cookie name. Same as single-tenant prototype. */
export const ID_TOKEN_COOKIE = 'vestibulum_id_token';

/**
 * Reasons that the handler can refuse a request. Used as a metric
 * dimension and asserted on by unit tests.
 */
export type RefuseReason =
  | 'no-host'
  | 'host-not-tenant-shape'
  | 'tenant-mismatch'
  | 'no-tenant-claim'
  | 'wrong-iss'
  | 'wrong-token-use'
  | 'bad-signature'
  | 'expired'
  | 'no-aud';

/**
 * Build a 403 Forbidden response with no body.
 *
 * The handler emits a structured log line that downstream observability
 * subscribers (Firehose → metric filter, or third-party log forwarders)
 * convert into the `Vestibulum/SharedDistribution/EdgeCheckRefused`
 * CloudWatch metric.
 *
 * `req` is accepted for symmetry / future extension (logging the URI
 * if needed), even though the current implementation only uses the
 * reason.
 */
export function refuse(
  _req: CloudFrontRequest,
  reason: RefuseReason,
): CloudFrontResultResponse {
  emitRefuseMetric(reason);
  return {
    status: '403',
    statusDescription: 'Forbidden',
    headers: {
      'cache-control': [{ key: 'Cache-Control', value: 'no-store, max-age=0' }],
      'content-type': [{ key: 'Content-Type', value: 'text/plain; charset=utf-8' }],
    },
    body: 'Forbidden',
  };
}

/**
 * Build a 302 redirect to the tenant's `/login` page.
 *
 * The location is `https://<subdomain>.<parent>/login`. The handler
 * doesn't know `TENANT_PARENT` here, so the helper takes the subdomain
 * and trusts the originating Host — but for tenant-shape hosts we have
 * the original Host from the request; we use the actual host (already
 * validated) for the redirect.
 *
 * We also include a structured log line for observability (no metric
 * for redirects, but a log line helps debugging).
 */
export function loginRedirect(
  req: CloudFrontRequest,
  subdomain: string,
): CloudFrontResultResponse {
  // Use the request's host header for the redirect — it's already been
  // validated as a tenant-shape host by the caller, and using it
  // preserves any port the viewer included.
  const hostEntries = req.headers?.['host'];
  const host =
    hostEntries && hostEntries[0] !== undefined
      ? hostEntries[0].value
      : `${subdomain}.unknown`;

  emitRedirectLog(subdomain);

  return {
    status: '302',
    statusDescription: 'Found',
    headers: {
      location: [
        { key: 'Location', value: `https://${host}/login` },
      ],
      'cache-control': [
        { key: 'Cache-Control', value: 'no-store, max-age=0' },
      ],
    },
  };
}

/**
 * Extract the `vestibulum_id_token` value from one or more `Cookie`
 * headers in the CloudFront viewer-request shape.
 *
 * CloudFront represents the `Cookie` header as an array of
 * `{ key, value }`; the value of each entry is a `;`-separated list of
 * `name=value` pairs. We walk every entry, splitting on `;` and trimming.
 *
 * Returns `undefined` if absent or malformed.
 */
export function extractTokenFromCookies(
  cookieHeader: CloudFrontHeaders['cookie'] | undefined,
): string | undefined {
  if (cookieHeader === undefined) return undefined;
  for (const entry of cookieHeader) {
    if (entry === undefined || entry === null) continue;
    const raw = entry.value;
    if (typeof raw !== 'string' || raw === '') continue;
    for (const rawSegment of raw.split(';')) {
      const segment = rawSegment.trim();
      if (segment === '') continue;
      const eq = segment.indexOf('=');
      if (eq <= 0) continue;
      const k = segment.slice(0, eq).trim();
      if (k !== ID_TOKEN_COOKIE) continue;
      const v = segment.slice(eq + 1).trim();
      if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
        return v.slice(1, -1);
      }
      return v;
    }
  }
  return undefined;
}

/**
 * Emit a structured JSON log line describing a refuse outcome. Downstream
 * observability extracts the `metric` and `reason` fields and converts to
 * a CloudWatch metric dimension.
 */
function emitRefuseMetric(reason: RefuseReason): void {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      metric: 'Vestibulum/SharedDistribution/EdgeCheckRefused',
      reason,
    }),
  );
}

/**
 * Emit a structured log line for an unauthenticated redirect. No metric;
 * useful for debugging viewer-side issues.
 */
function emitRedirectLog(subdomain: string): void {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      event: 'Vestibulum/SharedDistribution/EdgeLoginRedirect',
      subdomain,
    }),
  );
}
