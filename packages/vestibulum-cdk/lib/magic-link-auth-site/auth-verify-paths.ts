/**
 * Resolves on-disk paths to the pre-built Lambda bundle directories
 * produced by `scripts/build-bundles.ts` (Agent A / B1 of the bundle
 * pipeline). The construct consumes these paths via
 * `lambda.Code.fromAsset(...)`.
 *
 * The lock manifest itself (`packages/vestibulum-cdk/lambda-bundles.lock.json`)
 * is the source of truth for the bundle set. This helper:
 *
 * 1. Loads the manifest at synth time (synchronously, since CDK
 *    constructs synth synchronously).
 * 2. Validates that every required bundle name is present.
 * 3. Returns the resolved on-disk paths.
 *
 * The bundle bytes themselves are NOT validated here — that's the
 * `verify-bundles.ts` script's job, run separately from CI and the
 * publish pipeline. This helper trusts the bundles on disk match the
 * manifest, which is the contract `verify-bundles` enforces.
 *
 * Per S-C5: `aws-jwt-verify` is inlined into the L@E bundle by the
 * bundle pipeline; this helper does not need to know about that.
 * Per S-C6: `drop: ['console']` is applied at build time; same.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The set of Lambda bundle names `MagicLinkAuthSite` consumes. These
 * are the three bundles whose code paths the site construct passes to
 * `lambda.Code.fromAsset()`.
 *
 * `MagicLinkIdentity` consumes its own set (the four CUSTOM_AUTH
 * triggers plus the bounce-handler) — that helper lives next to the
 * Identity construct.
 */
export const AUTH_SITE_BUNDLE_NAMES = [
  "auth-verify",
  "auth-signout",
  "auth-login",
  "check-auth",
  // The deploy-time config baker for the check-auth Lambda@Edge: a regional
  // custom-resource handler that injects concrete Cognito config into the
  // edge bundle's PLACEHOLDER_* seams and republishes the version.
  "check-auth-config-baker",
] as const;

export type AuthSiteBundleName = (typeof AUTH_SITE_BUNDLE_NAMES)[number];

/**
 * Shape of one bundle entry in `lambda-bundles.lock.json`. SHA-256 is
 * informational at synth time (the assets are read raw); the verify
 * script consumes it separately.
 */
export interface BundleLockEntry {
  readonly sha256: string;
  readonly sizeBytes: number;
}

/**
 * Shape of the committed `lambda-bundles.lock.json`. Other fields are
 * tolerated (forward-compat); the helper reads only what it needs.
 */
export interface BundleLockManifest {
  readonly vestibulumVersion: string;
  readonly bundles: Readonly<Record<string, BundleLockEntry>>;
}

/**
 * Thrown when the lock manifest is missing or unreadable. The synth
 * cannot continue without it because the bundle paths are derived
 * from it.
 */
export class BundleManifestMissingError extends Error {
  public override readonly name = "BundleManifestMissingError";
  public constructor(manifestPath: string, cause?: unknown) {
    super(
      `Could not read lambda-bundles.lock.json at ${manifestPath}. ` +
        `Run \`npm run build-bundles --workspace=@de-otio/vestibulum-cdk\` ` +
        `to produce the bundles and manifest before synthesising a ` +
        `consumer stack that uses MagicLinkAuthSite.${
          cause instanceof Error ? ` Underlying cause: ${cause.message}` : ""
        }`,
    );
  }
}

/**
 * Thrown when the lock manifest is well-formed but missing a required
 * bundle entry. Names a specific bundle so the failure is actionable.
 */
export class BundleManifestEntryMissingError extends Error {
  public override readonly name = "BundleManifestEntryMissingError";
  public constructor(bundleName: string, manifestPath: string) {
    super(
      `Bundle '${bundleName}' is not declared in ${manifestPath}. ` +
        `The lambda-bundles.lock.json must declare every bundle that ` +
        `MagicLinkAuthSite or MagicLinkIdentity references.`,
    );
  }
}

/**
 * Thrown when the bundle directory referenced by the manifest does
 * not exist on disk. Distinct from the manifest-missing case because
 * the remediation is different (build the bundles, vs re-publish /
 * re-install the package).
 */
export class BundleAssetMissingError extends Error {
  public override readonly name = "BundleAssetMissingError";
  public constructor(bundleName: string, bundlePath: string) {
    super(
      `Bundle '${bundleName}' is declared in lambda-bundles.lock.json ` +
        `but the asset directory does not exist at ${bundlePath}. ` +
        `If this is a synth in a freshly-cloned repo, run ` +
        `\`npm run build-bundles --workspace=@de-otio/vestibulum-cdk\`. ` +
        `If this is a published-tarball install, the package may be ` +
        `corrupt — reinstall.`,
    );
  }
}

/**
 * Locates and parses the committed `lambda-bundles.lock.json` for
 * `@de-otio/vestibulum-cdk`. The path is resolved relative to this
 * file at build time so it works for both source builds and published
 * tarballs.
 */
export function readBundleLockManifest(packageRoot: string): BundleLockManifest {
  const manifestPath = path.join(packageRoot, "lambda-bundles.lock.json");
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch (cause) {
    throw new BundleManifestMissingError(manifestPath, cause);
  }
  const parsed = JSON.parse(raw) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { bundles?: unknown }).bundles !== "object"
  ) {
    throw new BundleManifestMissingError(manifestPath);
  }
  return parsed as BundleLockManifest;
}

/**
 * Returns the on-disk bundle directory for a given bundle name. The
 * directory MUST exist by the time CDK synth touches the asset; this
 * helper enforces that contract with a clear error message.
 */
export function resolveBundleAssetPath(
  packageRoot: string,
  manifest: BundleLockManifest,
  bundleName: string,
  options: { readonly skipExistenceCheck?: boolean } = {},
): string {
  const manifestPath = path.join(packageRoot, "lambda-bundles.lock.json");
  if (!(bundleName in manifest.bundles)) {
    throw new BundleManifestEntryMissingError(bundleName, manifestPath);
  }
  const bundlePath = path.join(packageRoot, "lambda-bundles", bundleName);
  if (options.skipExistenceCheck !== true && !fs.existsSync(bundlePath)) {
    throw new BundleAssetMissingError(bundleName, bundlePath);
  }
  return bundlePath;
}

/**
 * Resolves all bundle paths needed by `MagicLinkAuthSite`. Returns
 * a strongly-typed record so callers can destructure without
 * stringly-typed indexing.
 */
export function resolveAuthSiteBundlePaths(
  packageRoot: string,
  manifest: BundleLockManifest,
  options: { readonly skipExistenceCheck?: boolean } = {},
): Readonly<Record<AuthSiteBundleName, string>> {
  const out = {} as Record<AuthSiteBundleName, string>;
  for (const name of AUTH_SITE_BUNDLE_NAMES) {
    out[name] = resolveBundleAssetPath(packageRoot, manifest, name, options);
  }
  return out;
}
