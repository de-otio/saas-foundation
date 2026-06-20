/**
 * Test-only mock of `lambda-bundles.lock.json`. Used by
 * MagicLinkAuthSite tests so they synth without depending on Agent A's
 * bundle pipeline outputs being on disk.
 *
 * Pair with `_skipBundleAssetCheck: true` so the construct does not
 * stat the (absent) bundle directories. CDK still hashes the
 * `lambda-bundles/<name>/` paths via `Code.fromAsset`, but the synth
 * tests run against a `Template.fromStack` which does not require the
 * physical assets to exist (CDK only stats assets at full `cdk synth`
 * write-time).
 *
 * NOTE: when the bundle paths are passed to `Code.fromAsset`, CDK
 * tries to stat them during synth. To keep tests hermetic, the
 * test stack creates the bundle directories under a tmp dir and
 * points `_packageRoot` at it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { BundleLockManifest } from "../../lib/magic-link-auth-site/auth-verify-paths.js";

export const MOCK_BUNDLE_MANIFEST: BundleLockManifest = {
  vestibulumVersion: "0.0.0-test",
  bundles: {
    "pre-signup": { sha256: "0".repeat(64), sizeBytes: 1 },
    "define-auth": { sha256: "0".repeat(64), sizeBytes: 1 },
    "create-auth": { sha256: "0".repeat(64), sizeBytes: 1 },
    "verify-auth": { sha256: "0".repeat(64), sizeBytes: 1 },
    "bounce-handler": { sha256: "0".repeat(64), sizeBytes: 1 },
    "auth-verify": { sha256: "0".repeat(64), sizeBytes: 1 },
    "auth-signout": { sha256: "0".repeat(64), sizeBytes: 1 },
    "auth-login": { sha256: "0".repeat(64), sizeBytes: 1 },
    "check-auth": { sha256: "0".repeat(64), sizeBytes: 1 },
    "pre-token-generation": { sha256: "0".repeat(64), sizeBytes: 1 },
    "post-confirmation": { sha256: "0".repeat(64), sizeBytes: 1 },
  },
};

/**
 * Creates a tmp package root with:
 *  - `lambda-bundles.lock.json` containing the mock manifest;
 *  - empty `lambda-bundles/<name>/index.js` files for each manifest
 *    entry (CDK's `Code.fromAsset` is happy with any directory that
 *    contains at least one file);
 *  - the `login-pages/` directory mirrored from the real package so
 *    `BucketDeployment.Source.asset(...)` works.
 *
 * Returns the absolute tmp root. Cleanup is the caller's responsibility
 * (use `afterAll(() => fs.rmSync(root, { recursive: true, force: true }))`).
 */
export function makeMockPackageRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vestibulum-cdk-test-"));
  fs.writeFileSync(
    path.join(root, "lambda-bundles.lock.json"),
    JSON.stringify(MOCK_BUNDLE_MANIFEST, null, 2),
  );
  const bundlesDir = path.join(root, "lambda-bundles");
  fs.mkdirSync(bundlesDir, { recursive: true });
  for (const name of Object.keys(MOCK_BUNDLE_MANIFEST.bundles)) {
    const dir = path.join(bundlesDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "index.js"),
      `// Mock bundle for ${name}\nexports.handler = async () => ({});\n`,
    );
  }
  const loginPagesDir = path.join(root, "login-pages");
  fs.mkdirSync(loginPagesDir, { recursive: true });
  fs.writeFileSync(path.join(loginPagesDir, "login.html"), "<!doctype html><title>Mock</title>");
  return root;
}
