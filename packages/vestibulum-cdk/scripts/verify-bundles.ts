#!/usr/bin/env node
/**
 * `verify-bundles.ts` — the CI gate that defends bundle integrity.
 *
 * 1. Reads the committed `lambda-bundles.lock.json`.
 * 2. Re-runs the build in a temp directory (does not touch the
 *    committed `lambda-bundles/`).
 * 3. SHA-256-hashes each produced bundle.
 * 4. Compares to the manifest.
 * 5. Exits non-zero on any drift.
 *
 * The publish workflow runs this immediately before `npm publish`.
 *
 * See `doc/vestibulum-cdk/10-lambda-bundle-pipeline.md § CI gates`.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
// Note: when running this script directly via `node --experimental-strip-types`,
// the relative import resolves to the .ts file at runtime. When compiled to
// JS via tsc, the `.js` extension matches the emitted file. Both modes work
// because tsc rewrites the import on emit and the runtime accepts the
// imported file by content type.
import { BUNDLE_ENTRIES, buildAllBundles, type BundleLockManifest } from "./build-bundles.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PACKAGE_ROOT = path.resolve(__dirname, "..");
const LOCK_PATH = path.join(PACKAGE_ROOT, "lambda-bundles.lock.json");

/**
 * Read the lock manifest from disk. Throws on missing/malformed file —
 * the CI gate treats either as a failure.
 */
export async function readLockManifest(lockPath = LOCK_PATH): Promise<BundleLockManifest> {
  const text = await readFile(lockPath, "utf8");
  return JSON.parse(text) as BundleLockManifest;
}

/**
 * Compare two manifests; return a list of drift messages (empty on match).
 *
 * The comparison is order-independent and tolerant of extra keys in either
 * direction — we report any difference but do not throw on them.
 */
export function diffManifests(expected: BundleLockManifest, actual: BundleLockManifest): string[] {
  const drift: string[] = [];

  if (expected.vestibulumVersion !== actual.vestibulumVersion) {
    drift.push(
      `vestibulumVersion drift: lock=${expected.vestibulumVersion} actual=${actual.vestibulumVersion}`,
    );
  }

  const expectedKeys = new Set(Object.keys(expected.bundles));
  const actualKeys = new Set(Object.keys(actual.bundles));

  for (const key of expectedKeys) {
    const e = expected.bundles[key];
    // Placeholder entries are not yet built; skip hash comparison.
    if (e?.placeholder === true) {
      continue;
    }
    if (!actualKeys.has(key)) {
      drift.push(`missing bundle '${key}' in fresh build`);
      continue;
    }
    const a = actual.bundles[key];
    if (e === undefined || a === undefined) {
      // already covered by the missing/extra branches above; defensive.
      continue;
    }
    if (e.sha256 !== a.sha256) {
      drift.push(`hash drift on '${key}': lock=${e.sha256} actual=${a.sha256}`);
    }
  }
  for (const key of actualKeys) {
    if (!expectedKeys.has(key)) {
      drift.push(`unexpected bundle '${key}' in fresh build (missing from lock)`);
    }
  }
  return drift;
}

/**
 * Top-level verify routine. Returns `{ ok: true }` on match,
 * `{ ok: false, drift: [...] }` on mismatch.
 *
 * @param lockPath — override for tests; defaults to the committed lock file.
 */
export async function verifyBundles(
  lockPath = LOCK_PATH,
): Promise<{ ok: true } | { ok: false; drift: string[] }> {
  const expected = await readLockManifest(lockPath);

  const tmpRoot = await mkdtemp(path.join(tmpdir(), "vestibulum-cdk-verify-"));
  try {
    const actual = await buildAllBundles(tmpRoot);
    const drift = diffManifests(expected, actual);
    if (drift.length > 0) {
      return { ok: false, drift };
    }
    return { ok: true };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

/**
 * CLI entry point.
 */
async function main(): Promise<void> {
  const result = await verifyBundles();
  if (result.ok) {
    // eslint-disable-next-line no-console
    console.log(`@de-otio/vestibulum-cdk: verified ${BUNDLE_ENTRIES.length} bundle hash(es) OK`);
    return;
  }
  // eslint-disable-next-line no-console
  console.error(`@de-otio/vestibulum-cdk: bundle drift detected:\n  ${result.drift.join("\n  ")}`);
  process.exit(1);
}

const argv1 = process.argv[1] ?? "";
if (
  import.meta.url === `file://${argv1}` ||
  argv1.endsWith("/verify-bundles.ts") ||
  argv1.endsWith("\\verify-bundles.ts")
) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
