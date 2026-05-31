/**
 * `@de-otio/saas-foundation/net` barrel.
 *
 * Exports:
 * - `trustedClientIp(request, config)` — client IP derivation
 * - `isIpShape(s)` — IPv4/IPv6 shape validator
 * - `isReservedIp(s)` — RFC 6890 reserved block check
 * - `IpAnonymizer` — per-level IP anonymization
 * - `anonymizeIpPartial(ip)` — convenience partial anonymizer
 * - `RFC6890_IPV4_RESERVED`, `RFC6890_IPV6_RESERVED`, `RFC6890_ALL_RESERVED`
 * - Named errors
 */

export {
  trustedClientIp,
  isIpShape,
  isReservedIp,
  IpAnonymizer,
  anonymizeIpPartial,
} from "./derive.js";
export type {
  TrustedProxyMode,
  TrustedClientIpConfig,
  IpAnonymizationLevel,
  IpAnonymizerOptions,
} from "./derive.js";
export { RFC6890_IPV4_RESERVED, RFC6890_IPV6_RESERVED, RFC6890_ALL_RESERVED } from "./rfc6890.js";
export type { ReservedBlock } from "./rfc6890.js";
export { InvalidIpError, TrustedProxyError } from "./errors.js";
export { isIPv4InCidr, isIPv6InCidr, parseIPv4, parseIPv6 } from "./cidr.js";
