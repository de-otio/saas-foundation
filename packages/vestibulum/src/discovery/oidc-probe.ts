/**
 * OIDC issuer probe.
 *
 * Fetches and validates an OIDC issuer's `.well-known/openid-configuration`
 * document. Used by **admin flows** before saving an IdP config; never
 * inside the auth hot path.
 *
 * This is the runtime-package port of Trellis's
 * `apps/api/src/lib/cognito/issuer-probe.ts`, extended to:
 *   - throw `OidcProbeError` (typed reason) instead of returning a
 *     discriminated result object — fits the rest of the
 *     `vestibulum-runtime` error hierarchy;
 *   - check `response_types_supported`, the
 *     `id_token_signing_alg_values_supported` allow-list, and
 *     `token_endpoint_auth_methods_supported` for `client_secret_post`
 *     (Cognito's only supported method);
 *   - normalise the issuer URL before comparing to the response's
 *     `issuer` claim (trailing slash, case-folded host).
 *
 * Security constraints (doc/federation/02-runtime-api.md § Issuer probe):
 *   - URL length cap (2048) enforced before parsing.
 *   - HTTPS only.
 *   - URL credentials (`user:pass@`) rejected.
 *   - DNS-resolve the host; refuse any private / link-local / IMDS / etc.
 *     address (IPv4 + IPv6) — see {@link isPrivateAddress} from
 *     `./private-ip`.
 *   - Pin the connect step to the validated IP via an `undici.Agent`
 *     custom `lookup` — defeats DNS-rebinding TOCTOU.
 *   - `redirect: 'manual'` — any 3xx response refused.
 *   - Stream the body; cap at 1 MiB; never trust `Content-Length`.
 *   - `response_types_supported` must contain `code`.
 *   - `id_token_signing_alg_values_supported` ⊆ permitted RS/ES set.
 *   - `token_endpoint_auth_methods_supported` must contain
 *     `client_secret_post`.
 *
 * Reference implementation: the prior-art file referenced from
 * `doc/federation/02-runtime-api.md § Issuer probe` and
 * `plans/federation-checklist.md § T1.1`.
 *
 * See doc/federation/02-runtime-api.md § Issuer probe.
 */

import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { Agent } from "undici";

import { OidcProbeError } from "../errors.js";
import { isPrivateAddress } from "./private-ip.js";

const PROBE_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ISSUER_URL_LENGTH = 2048;

/**
 * Per the OIDC discovery spec; appended to the (normalised) issuer URL
 * to build the probe URL.
 */
const WELL_KNOWN_PATH = ".well-known/openid-configuration";

/**
 * Signing algorithms accepted by the probe. `none` is rejected per
 * RFC 7518 §3.1 and the Cognito hosted-UI behaviour.
 */
const PERMITTED_ALGS: ReadonlySet<string> = new Set([
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
  "ES512",
]);

/**
 * Cognito's only supported client-authentication method
 * (doc/federation/03-oidc.md § Token-endpoint authentication method).
 */
const REQUIRED_AUTH_METHOD = "client_secret_post";

/**
 * Result of a successful probe — the canonical subset of an
 * RFC 8414 discovery document that the runtime relies on, plus
 * a typed surface for additional fields the consumer may want.
 */
export interface OidcIssuerMetadata {
  /** `issuer` claim, normalised against the probed URL. */
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  userinfoEndpoint?: string;
  scopesSupported?: string[];
  responseTypesSupported: string[];
  idTokenSigningAlgValuesSupported: string[];
  tokenEndpointAuthMethodsSupported: string[];
}

/**
 * Tunable behaviour. All fields default to safe values; tests
 * inject the `dispatcherFactory` to assert the connect step is
 * pinned to the validated IP.
 */
export interface OidcProbeOptions {
  /** Timeout in milliseconds. Default 5000. */
  timeoutMs?: number;
  /** Inject a custom `fetch` (test stubbing). */
  fetchImpl?: typeof fetch;
  /** Inject a custom DNS resolver (test stubbing). */
  resolveHostname?: (hostname: string) => Promise<string[]>;
  /**
   * Inject the dispatcher factory. Production binds this to a
   * private helper that returns an `undici.Agent` whose
   * `connect.lookup` returns the validated IP — preventing
   * DNS-rebinding TOCTOU between the private-IP check and the
   * actual TCP connect. Tests use this hook to assert the IP
   * passed to the agent equals the IP returned by the resolver.
   */
  dispatcherFactory?: (validatedIp: string, family: 4 | 6) => Agent;
}

/**
 * Probe an OIDC issuer's discovery document. Throws
 * {@link OidcProbeError} with a typed `reason` on any failure.
 *
 * IAM: this function makes outbound HTTPS calls to the issuer
 * URL only. No AWS SDK calls are made.
 */
export async function probeOidcIssuer(
  issuerUrl: string,
  options: OidcProbeOptions = {},
): Promise<OidcIssuerMetadata> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  if (issuerUrl.length > MAX_ISSUER_URL_LENGTH) {
    throw new OidcProbeError(
      "url_too_long",
      `issuerUrl exceeds maximum length of ${MAX_ISSUER_URL_LENGTH} characters`,
    );
  }

  let url: URL;
  try {
    url = new URL(issuerUrl);
  } catch {
    throw new OidcProbeError("unreachable", "issuerUrl is not a valid absolute URL");
  }

  if (url.protocol !== "https:") {
    throw new OidcProbeError("not_https", "issuerUrl must use https://");
  }

  if (url.username || url.password) {
    throw new OidcProbeError(
      "url_has_credentials",
      "issuerUrl must not include user:pass@ credentials",
    );
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const resolve = options.resolveHostname ?? defaultResolve;

  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    throw new OidcProbeError("unreachable", `Could not resolve issuerUrl hostname "${hostname}"`);
  }
  if (addresses.length === 0) {
    throw new OidcProbeError("unreachable", `Could not resolve issuerUrl hostname "${hostname}"`);
  }
  for (const addr of addresses) {
    if (isPrivateAddress(addr)) {
      throw new OidcProbeError(
        "ssrf_blocked_destination",
        `issuerUrl resolves to a non-public address (${addr})`,
      );
    }
  }

  // Pin the connect step to the IP we just validated. Without this,
  // Node's fetch performs its own DNS lookup at request time, which
  // lets a TTL=0 attacker swap the public IP for a private one between
  // validate and connect (DNS-rebinding TOCTOU).
  const validatedIp = addresses[0] ?? "";
  if (!validatedIp) {
    throw new OidcProbeError("unreachable", "DNS resolution returned no addresses");
  }
  const validatedFamily = isIP(validatedIp);
  /* istanbul ignore next — defensive; isPrivateAddress fails
   * closed on anything that isn't a valid IP literal, so this
   * branch is unreachable for the well-formed `validatedIp` that
   * the resolver could ever return alongside an SSRF pass. */
  if (validatedFamily !== 4 && validatedFamily !== 6) {
    throw new OidcProbeError("unreachable", `Resolver returned a non-IP address for "${hostname}"`);
  }

  const baseHref = url.toString().endsWith("/") ? url.toString() : `${url.toString()}/`;
  const probeUrl = baseHref + WELL_KNOWN_PATH;

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const factory = options.dispatcherFactory ?? defaultPinnedDispatcher;
  const pinnedDispatcher = factory(validatedIp, validatedFamily);

  try {
    return await runProbe(baseHref, probeUrl, fetchImpl, controller, timer, pinnedDispatcher);
  } finally {
    // Best-effort dispatcher cleanup; swallow any close error since
    // the request has already completed (or thrown) by this point.
    // istanbul ignore next — the catch handler only fires if
    // undici's Agent.close() rejects, which the library does not do
    // under any documented condition.
    await pinnedDispatcher.close().catch(() => undefined);
  }
}

/**
 * Default DNS resolver: `dns.lookup` with `all: true, verbatim: true`,
 * mapped to plain string addresses.
 */
function defaultResolve(hostname: string): Promise<string[]> {
  return dns
    .lookup(hostname, { all: true, verbatim: true })
    .then((addrs) => addrs.map((a) => a.address));
}

/**
 * Build the pinned-lookup callback installed on the default
 * `undici.Agent`. Returns a function that, regardless of the
 * hostname undici asks about, calls back with the validated IP
 * and address family.
 *
 * Exported (but not re-exported from index.ts) so the test suite
 * can invoke it directly to assert the pin behaviour without
 * relying on a real network dial. Treat as package-internal.
 *
 * @internal
 */
export function buildPinnedLookup(
  validatedIp: string,
  family: 4 | 6,
): (
  hostname: string,
  opts: unknown,
  cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
) => void {
  return (_hostname, _opts, cb) => cb(null, validatedIp, family);
}

/**
 * Default dispatcher factory: `undici.Agent` with a custom
 * `connect.lookup` that returns the validated IP unconditionally.
 *
 * Tests inject their own factory to assert the IP is the one the
 * resolver returned (DNS-rebinding pin test).
 */
function defaultPinnedDispatcher(validatedIp: string, family: 4 | 6): Agent {
  return new Agent({
    connect: {
      lookup: buildPinnedLookup(validatedIp, family),
    },
  });
}

/**
 * Run the actual fetch + body-streaming + validation. Split out so
 * the top-level wrapper can `finally`-close the dispatcher.
 */
async function runProbe(
  baseHref: string,
  probeUrl: string,
  fetchImpl: typeof fetch,
  controller: AbortController,
  timer: NodeJS.Timeout,
  pinnedDispatcher: Agent,
): Promise<OidcIssuerMetadata> {
  let response: Response;
  try {
    const init: RequestInit & { dispatcher?: unknown } = {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: controller.signal,
      dispatcher: pinnedDispatcher,
    };
    response = await fetchImpl(probeUrl, init);
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === "AbortError") {
      throw new OidcProbeError("timeout", `Probe timed out after ${PROBE_TIMEOUT_MS}ms`);
    }
    throw new OidcProbeError(
      "unreachable",
      `Could not reach issuer (${(err as Error).message ?? "unknown error"})`,
    );
  }
  clearTimeout(timer);

  if (response.status >= 300 && response.status < 400) {
    throw new OidcProbeError(
      "redirect_blocked",
      `Issuer returned HTTP ${response.status}; redirects are not followed`,
    );
  }
  if (!response.ok) {
    throw new OidcProbeError("unreachable", `Issuer returned HTTP ${response.status}`);
  }

  // Stream body; cap at MAX_BODY_BYTES. Do not trust Content-Length:
  // a hostile server could claim a small size and send unbounded data.
  const reader = response.body?.getReader();
  if (!reader) {
    throw new OidcProbeError("unreachable", "Issuer returned an empty response body");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        total += value.length;
        if (total > MAX_BODY_BYTES) {
          // istanbul ignore next — the catch handler only fires if
          // ReadableStream.cancel() rejects, which the spec'd web
          // streams API does not do for an already-reading stream.
          await reader.cancel().catch(() => undefined);
          throw new OidcProbeError("too_large", `Issuer response exceeded ${MAX_BODY_BYTES} bytes`);
        }
        chunks.push(value);
      }
    }
  } catch (err) {
    if (err instanceof OidcProbeError) {
      throw err;
    }
    throw new OidcProbeError(
      "unreachable",
      `Failed reading issuer response: ${(err as Error).message ?? "unknown error"}`,
    );
  }

  const body = new TextDecoder("utf-8").decode(concat(chunks));
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new OidcProbeError("invalid_json", "Issuer response was not valid JSON");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new OidcProbeError("invalid_json", "Issuer response was not a JSON object");
  }

  const conf = json as Record<string, unknown>;
  const issuer = typeof conf.issuer === "string" ? conf.issuer : "";
  const authorizationEndpoint =
    typeof conf.authorization_endpoint === "string" ? conf.authorization_endpoint : "";
  const tokenEndpoint = typeof conf.token_endpoint === "string" ? conf.token_endpoint : "";
  const jwksUri = typeof conf.jwks_uri === "string" ? conf.jwks_uri : "";
  const userinfoEndpoint =
    typeof conf.userinfo_endpoint === "string" ? conf.userinfo_endpoint : undefined;

  if (!issuer || !authorizationEndpoint || !tokenEndpoint || !jwksUri) {
    throw new OidcProbeError(
      "invalid_json",
      "Issuer well-known is missing one of: issuer, authorization_endpoint, token_endpoint, jwks_uri",
    );
  }

  // Issuer URL match: normalise both to a canonical form (trailing
  // slash trimmed, host lower-cased).
  if (normaliseIssuer(issuer) !== normaliseIssuer(baseHref)) {
    throw new OidcProbeError(
      "issuer_mismatch",
      `Response issuer "${issuer}" does not match requested URL "${baseHref}"`,
    );
  }

  const responseTypesSupported = readStringArray(conf.response_types_supported);
  if (!responseTypesSupported.some((rt) => splitWhitespace(rt).includes("code"))) {
    throw new OidcProbeError(
      "unsupported_alg",
      'Issuer does not advertise the "code" response type',
    );
  }

  const algsSupported = readStringArray(conf.id_token_signing_alg_values_supported);
  if (algsSupported.length === 0) {
    throw new OidcProbeError(
      "unsupported_alg",
      "Issuer does not advertise id_token_signing_alg_values_supported",
    );
  }
  for (const alg of algsSupported) {
    if (!PERMITTED_ALGS.has(alg)) {
      throw new OidcProbeError(
        "unsupported_alg",
        `Issuer advertises unsupported signing algorithm "${alg}"`,
      );
    }
  }

  const authMethods = readStringArray(conf.token_endpoint_auth_methods_supported);
  // Per OIDC discovery: omitted defaults to [client_secret_basic],
  // which Cognito does NOT support. Therefore an omitted array fails
  // the check just like an array without client_secret_post.
  if (!authMethods.includes(REQUIRED_AUTH_METHOD)) {
    throw new OidcProbeError(
      "unsupported_auth_method",
      `Issuer does not list "${REQUIRED_AUTH_METHOD}" in token_endpoint_auth_methods_supported`,
    );
  }

  const scopesSupported = Array.isArray(conf.scopes_supported)
    ? readStringArray(conf.scopes_supported)
    : undefined;

  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    jwksUri,
    ...(userinfoEndpoint !== undefined && userinfoEndpoint !== "" ? { userinfoEndpoint } : {}),
    ...(scopesSupported !== undefined ? { scopesSupported } : {}),
    responseTypesSupported,
    idTokenSigningAlgValuesSupported: algsSupported,
    tokenEndpointAuthMethodsSupported: authMethods,
  };
}

/**
 * Normalise an issuer URL for the cross-check: ensures trailing
 * slash, lower-cases the host, leaves the path case-sensitive.
 */
function normaliseIssuer(href: string): string {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    /* istanbul ignore next — defensive; both call sites pass a
     * URL we already parsed via `new URL(issuerUrl)` upstream, so
     * this catch is unreachable. */
    return href.toLowerCase();
  }
  u.hostname = u.hostname.toLowerCase();
  const s = u.toString();
  return s.endsWith("/") ? s : `${s}/`;
}

function readStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string") out.push(item);
  }
  return out;
}

/**
 * RFC 6749 response_type values can be space-separated tokens
 * (e.g. "code id_token"). Split into the constituent tokens.
 */
function splitWhitespace(s: string): string[] {
  return s.trim().split(/\s+/);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
