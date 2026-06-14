export {
  MagicLinkAuthSite,
  type AuthLambdaConcurrencyProps,
  type AuthSiteMetricsNamespace,
  type MagicLinkAuthSiteProps,
} from "./magic-link-auth-site.js";

export {
  type BucketLifecycleProps,
  defaultImmutableAssetLifecycleRules,
  defaultGeneralBucketLifecycleRules,
  resolveLifecycleRules,
} from "../_internal/s3-lifecycle.js";

export {
  validateSenderAgainstZone,
  extractSenderDomain,
  SesSenderDomainMismatchError,
  SesSenderShapeError,
} from "./ses-validation.js";

export {
  AUTH_SITE_BUNDLE_NAMES,
  BundleAssetMissingError,
  BundleManifestEntryMissingError,
  BundleManifestMissingError,
  readBundleLockManifest,
  resolveAuthSiteBundlePaths,
  resolveBundleAssetPath,
  type AuthSiteBundleName,
  type BundleLockEntry,
  type BundleLockManifest,
} from "./auth-verify-paths.js";

export type { IMagicLinkIdentity } from "../_internal/identity-handle.js";
