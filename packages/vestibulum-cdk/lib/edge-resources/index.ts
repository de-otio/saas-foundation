export {
  EdgeResources,
  EdgeResourcesRegionError,
  type EdgeResourcesProps,
  type ExtraWafManagedRuleGroup,
} from "./edge-resources.js";

export {
  defaultWafRules,
  DEFAULT_AUTH_VERIFY_RATE_LIMIT,
  DEFAULT_LOGIN_RATE_LIMIT,
  type DefaultWafRulesOptions,
} from "./waf-defaults.js";

export {
  CROSS_REGION_REFERENCES_DEPLOY_ROLE_PERMISSIONS,
  renderCrossRegionPermissionGuidance,
} from "./cross-region.js";

export type { IEdgeResources } from "../_internal/edge-handle.js";
