/**
 * Shared-distribution `auth-signout` Function URL handler.
 *
 * Host-aware cookie clear. Reads the `Host` header to identify the tenant
 * and scopes the clearing cookie to the exact tenant subdomain (no leading dot).
 *
 * Direct `.on.aws` invocations (not via CloudFront) → 400.
 *
 * After clearing cookies, redirects to `tenantConfig.siteBaseUrl/`.
 */

import { extractTenantSubdomain } from '../shared/extract-tenant-subdomain.js';
import { loadClientConfigBySubdomain } from '../shared/client-config-loader.js';
import { parseCookies, buildSetCookie } from '../../handlers/auth-verify/cookie.js';

export interface FunctionUrlEvent {
  readonly headers?: Record<string, string | undefined>;
  readonly body?: string | null;
}

export interface FunctionUrlResult {
  statusCode: number;
  headers?: Record<string, string>;
  /**
   * Set-Cookie values. Lambda Function URLs (payload format 2.0) emit cookies
   * ONLY via this top-level `cookies` array — `multiValueHeaders`/`Set-Cookie`
   * headers are silently dropped on a Function URL. See AWS docs: "Invoking
   * Lambda function URLs" § Cookies.
   */
  cookies?: string[];
  body?: string;
}

export interface AuthSignoutDeps {
  readonly tenantParent?: string;
}

export function createAuthSignoutHandler(deps: AuthSignoutDeps = {}) {
  return async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
    const headers = event.headers ?? {};

    // ------------------------------------------------------------------
    // 1. Host check — must be a valid tenant subdomain.
    // ------------------------------------------------------------------
    const tenantParent =
      deps.tenantParent ?? process.env['VESTIBULUM_TENANT_PARENT'];
    if (tenantParent == null || tenantParent === '') {
      console.error('auth-signout: VESTIBULUM_TENANT_PARENT not set');
      return { statusCode: 500 };
    }

    const host = headers['host'];
    const subdomain = extractTenantSubdomain(host, tenantParent);
    if (subdomain == null || subdomain === '') {
      return { statusCode: 400, body: JSON.stringify({ error: 'invalid host' }) };
    }

    // ------------------------------------------------------------------
    // 2. Load ClientConfig to get siteBaseUrl for the redirect target.
    // ------------------------------------------------------------------
    const tenantConfig = await loadClientConfigBySubdomain(subdomain).catch((err) => {
      console.error('auth-signout: DDB error loading client config', err);
      throw err; // fail-closed: propagate
    });
    if (!tenantConfig) {
      return { statusCode: 404, body: JSON.stringify({ error: 'tenant not found' }) };
    }

    // ------------------------------------------------------------------
    // 3. Clear cookies — exact-host Domain (no leading dot).
    //    Per 06 § auth-signout: Domain=<subdomain>.<parent>
    // ------------------------------------------------------------------
    const exactDomain = `${subdomain}.${tenantParent}`;

    const clearCookies = [
      buildSetCookie('id-token', '', {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/',
        domain: exactDomain,
        maxAge: 0,
      }),
      buildSetCookie('refresh-token', '', {
        httpOnly: true,
        secure: true,
        sameSite: 'Strict',
        path: '/auth-verify',
        domain: exactDomain,
        maxAge: 0,
      }),
    ];

    // ------------------------------------------------------------------
    // 4. Redirect to tenant's home page.
    // ------------------------------------------------------------------
    return {
      statusCode: 303,
      headers: {
        location: `${tenantConfig.siteBaseUrl}/`,
      },
      cookies: clearCookies,
    };
  };
}

/** Default exported handler. */
export const handler = createAuthSignoutHandler();

// Re-export parseCookies for use in tests without separate import.
export { parseCookies };
