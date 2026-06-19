/**
 * Unit tests for the `verify-bundles` gate.
 *
 * Tests the pure helpers (`diffManifests`, `readLockManifest`) — the
 * full end-to-end run that calls esbuild is exercised by
 * `npm run verify-bundles` in CI; running it inside the unit-test
 * harness would slow tests by minutes per shell.
 */

import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { diffManifests, readLockManifest } from "../../scripts/verify-bundles.ts";
import type { BundleLockManifest } from "../../scripts/build-bundles.ts";

describe("diffManifests", () => {
  const baseManifest: BundleLockManifest = {
    vestibulumVersion: "0.1.0",
    bundles: {
      "pre-signup": {
        sha256: "sha256:aaaa",
        sizeBytes: 100,
        filename: "pre-signup/index.mjs",
      },
      "define-auth": {
        sha256: "sha256:bbbb",
        sizeBytes: 200,
        filename: "define-auth/index.mjs",
      },
    },
  };

  it("returns no drift when manifests match", () => {
    const result = diffManifests(baseManifest, baseManifest);
    expect(result).toEqual([]);
  });

  it("returns a drift entry for a hash mismatch", () => {
    const drifted: BundleLockManifest = {
      ...baseManifest,
      bundles: {
        ...baseManifest.bundles,
        "pre-signup": {
          sha256: "sha256:cccc",
          sizeBytes: 100,
          filename: "pre-signup/index.mjs",
        },
      },
    };
    const result = diffManifests(baseManifest, drifted);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/hash drift on 'pre-signup'/);
  });

  it("flags a vestibulumVersion mismatch", () => {
    const result = diffManifests(baseManifest, {
      ...baseManifest,
      vestibulumVersion: "0.2.0",
    });
    expect(result.some((r) => r.includes("vestibulumVersion drift"))).toBe(true);
  });

  it("flags a missing bundle in the fresh build", () => {
    const partial: BundleLockManifest = {
      vestibulumVersion: baseManifest.vestibulumVersion,
      bundles: { "pre-signup": baseManifest.bundles["pre-signup"]! },
    };
    const result = diffManifests(baseManifest, partial);
    expect(result.some((r) => r.includes("missing bundle 'define-auth'"))).toBe(true);
  });

  it("flags an extra bundle in the fresh build (unlocked)", () => {
    const extra: BundleLockManifest = {
      vestibulumVersion: baseManifest.vestibulumVersion,
      bundles: {
        ...baseManifest.bundles,
        unexpected: {
          sha256: "sha256:dddd",
          sizeBytes: 50,
          filename: "unexpected/index.mjs",
        },
      },
    };
    const result = diffManifests(baseManifest, extra);
    expect(result.some((r) => r.includes("unexpected bundle 'unexpected'"))).toBe(true);
  });

  it("skips hash comparison for placeholder entries", () => {
    const withPlaceholder: BundleLockManifest = {
      ...baseManifest,
      bundles: {
        ...baseManifest.bundles,
        "pending-bundle": {
          sha256: "sha256:placeholder",
          sizeBytes: 0,
          filename: "pending-bundle/index.mjs",
          placeholder: true,
        },
      },
    };
    // Fresh build does not include the placeholder bundle — should not flag it.
    const result = diffManifests(withPlaceholder, baseManifest);
    expect(result.every((r) => !r.includes("pending-bundle"))).toBe(true);
  });
});

describe("readLockManifest", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "verify-bundles-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("reads a valid manifest file from disk", async () => {
    const lockPath = path.join(tmpDir, "lambda-bundles.lock.json");
    const sample: BundleLockManifest = {
      vestibulumVersion: "0.3.1",
      bundles: {
        "pre-signup": {
          sha256: "sha256:xxx",
          sizeBytes: 1,
          filename: "pre-signup/index.mjs",
        },
      },
    };
    await writeFile(lockPath, JSON.stringify(sample), "utf8");

    const result = await readLockManifest(lockPath);
    expect(result).toEqual(sample);
  });

  it("throws when the lock file is missing", async () => {
    await expect(readLockManifest(path.join(tmpDir, "does-not-exist.json"))).rejects.toThrow();
  });

  it("throws when the lock file is malformed JSON", async () => {
    const lockPath = path.join(tmpDir, "bad.json");
    await writeFile(lockPath, "not json", "utf8");
    await expect(readLockManifest(lockPath)).rejects.toThrow();
  });
});

describe("committed lock manifest", () => {
  it("can be read and has the expected 14 bundle entries", async () => {
    const repoRoot = path.resolve(import.meta.dirname ?? __dirname, "..", "..");
    const lockPath = path.join(repoRoot, "lambda-bundles.lock.json");
    const manifest = await readLockManifest(lockPath);
    expect(Object.keys(manifest.bundles).sort()).toEqual([
      "admin",
      "auth-signout",
      "auth-verify",
      "bounce-handler",
      "check-auth",
      "create-auth",
      "define-auth",
      "post-confirmation",
      "pre-signup",
      "pre-token-generation",
      "reconciler",
      "shared-auth-signout",
      "shared-auth-verify",
      "verify-auth",
    ]);
  });
});
