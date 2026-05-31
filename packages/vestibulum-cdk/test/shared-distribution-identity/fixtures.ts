/**
 * Test fixtures for `shared-distribution-identity/` P2b tests.
 *
 * Provides:
 *   - `makeTestStack`: a stack with `crossRegionReferences: true` so
 *     the experimental `EdgeFunction` (which spawns a us-east-1
 *     stack) works in test mode.
 *   - `makeUserPool`: a CDK `UserPool` for the construct under test.
 *   - `tmpRoots` registry + `cleanupTmpRoots()` for tests that
 *     `_bundleOutDirOverride` into a tmpdir.
 *   - `makeMockPackageRoot` mirroring the real package's `login-pages/`
 *     so `CloudFrontDistribution`'s BucketDeployment finds the assets.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";

export const TEST_ENV = { account: "123456789012", region: "eu-central-1" };
export const TEST_ENV_US = { account: "123456789012", region: "us-east-1" };

const tmpRoots: string[] = [];

export function makeTmpDir(prefix = "vestibulum-cdk-p2b-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

export function cleanupTmpRoots(): void {
  for (const r of tmpRoots) {
    fs.rmSync(r, { recursive: true, force: true });
  }
  tmpRoots.length = 0;
}

export function makeTestStack(
  id = "TestStack",
  env: typeof TEST_ENV = TEST_ENV,
): { app: cdk.App; stack: cdk.Stack } {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, id, {
    env,
    crossRegionReferences: true,
  });
  return { app, stack };
}

export function makeUserPool(scope: cdk.Stack, id = "TestUserPool"): cognito.IUserPool {
  return new cognito.UserPool(scope, id, {
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
}

/**
 * Create a mock vestibulum-cdk package root with `login-pages/`
 * mirrored from the real package (so `BucketDeployment.Source.asset`
 * finds files).
 */
export function makeMockCdkPackageRoot(): string {
  const root = makeTmpDir("vestibulum-cdk-p2b-pkg-");
  const loginPages = path.join(root, "login-pages");
  fs.mkdirSync(loginPages, { recursive: true });
  fs.writeFileSync(path.join(loginPages, "login.html"), "<!doctype html><title>Mock</title>");
  return root;
}
