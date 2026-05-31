/**
 * Compatibility re-export. The authoritative WAF default-rules
 * implementation lives next to `EdgeResources` in
 * `lib/edge-resources/waf-defaults.ts`; this module keeps the
 * `lib/waf/` import path working for any code that still references
 * it.
 *
 * New code should import from `lib/edge-resources/` or the package
 * barrel directly.
 */
export {
  defaultWafRules,
  DEFAULT_AUTH_VERIFY_RATE_LIMIT,
  DEFAULT_LOGIN_RATE_LIMIT,
  type DefaultWafRulesOptions,
} from "../edge-resources/waf-defaults.js";
