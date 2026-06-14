#!/usr/bin/env node
/**
 * Build the ten Lambda bundles shipped in `@de-otio/vestibulum-cdk`.
 *
 * Reads the entry wrappers from `scripts/lambda-entries/`, runs esbuild
 * with deterministic options, hashes each output, and writes the lock
 * manifest `lambda-bundles.lock.json`. The output directory
 * `lambda-bundles/<name>/index.mjs` is gitignored; the lock file is
 * committed (it is the cross-version contract).
 *
 * See `doc/vestibulum-cdk/10-lambda-bundle-pipeline.md` for the full
 * design rationale (deterministic-output rules, L@E specifics,
 * `verify-bundles` gate).
 *
 * Usage:
 *   node --experimental-strip-types packages/vestibulum-cdk/scripts/build-bundles.ts
 *   # OR
 *   npx tsx packages/vestibulum-cdk/scripts/build-bundles.ts
 */

import { build, type BuildOptions } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile, readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Repo-relative path to the vestibulum-cdk package root. */
const PACKAGE_ROOT = path.resolve(__dirname, "..");

/** Where the entry wrappers live. */
const ENTRIES_DIR = path.join(__dirname, "lambda-entries");

/** Where the bundles are written (gitignored). */
const OUTPUT_DIR = path.join(PACKAGE_ROOT, "lambda-bundles");

/** The committed lock manifest. */
const LOCK_PATH = path.join(PACKAGE_ROOT, "lambda-bundles.lock.json");

/** The bundle name → entry filename mapping. Determines build order. */
export const BUNDLE_ENTRIES: ReadonlyArray<{
  readonly name: string;
  readonly entry: string;
  /** Lambda@Edge entries get extra discipline (`drop: ['console']`, inline `aws-jwt-verify`). */
  readonly edge: boolean;
}> = [
  { name: "pre-signup", entry: "pre-signup.ts", edge: false },
  { name: "define-auth", entry: "define-auth.ts", edge: false },
  { name: "create-auth", entry: "create-auth.ts", edge: false },
  { name: "verify-auth", entry: "verify-auth.ts", edge: false },
  { name: "bounce-handler", entry: "bounce-handler.ts", edge: false },
  { name: "auth-verify", entry: "auth-verify.ts", edge: false },
  { name: "auth-signout", entry: "auth-signout.ts", edge: false },
  { name: "pre-token-generation", entry: "pre-token-generation.ts", edge: false },
  { name: "post-confirmation", entry: "post-confirmation.ts", edge: false },
  { name: "check-auth", entry: "check-auth.ts", edge: true },
  // v0.2 shared-distribution bundles
  { name: "admin", entry: "shared-distribution-admin.ts", edge: false },
  { name: "reconciler", entry: "shared-distribution-reconciler.ts", edge: false },
];

/** Lock manifest shape — written to `lambda-bundles.lock.json`. */
export interface BundleLockManifest {
  readonly vestibulumVersion: string;
  readonly bundles: Record<string, BundleLockEntry>;
}

export interface BundleLockEntry {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly filename: string;
  /**
   * When `true`, this entry is a placeholder awaiting a real build.
   * The `verify-bundles` gate skips hash-comparison for placeholder entries.
   * Remove this field once `npm run build-bundles` is run for real.
   */
  readonly placeholder?: true;
}

/**
 * Build options shared by all bundles. Determinism rules per
 * `10-lambda-bundle-pipeline.md`:
 *
 * - `minify: true` — stable across runs given identical input.
 * - `legalComments: 'none'` — drops the version-stamping comments
 *   that would otherwise embed dep versions.
 * - `sourcemap: false` — keeps output bytes free of file paths.
 * - `metafile: true` — for size + dep tracking; not written to disk
 *   in production builds.
 */
const COMMON_BUILD_OPTIONS: BuildOptions = {
  bundle: true,
  platform: "node",
  format: "esm",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  treeShaking: true,
  metafile: true,
  outExtension: { ".js": ".mjs" },
  // esbuild emits a sentinel `__name` and similar helpers when
  // bundling ESM; keep the helper layout stable across runs.
  keepNames: false,
};

/** Regional bundles (nine of ten) externalise AWS SDK v3 + aws-jwt-verify. */
const REGIONAL_EXTERNAL: ReadonlyArray<string> = ["@aws-sdk/*", "aws-jwt-verify"];

/** L@E bundle externalises ONLY AWS SDK v3 — `aws-jwt-verify` must be inlined. */
const EDGE_EXTERNAL: ReadonlyArray<string> = ["@aws-sdk/*"];

/**
 * Build one bundle.
 *
 * @returns the path to the produced `index.mjs` file.
 */
export async function buildBundle(
  spec: (typeof BUNDLE_ENTRIES)[number],
  outDir: string,
): Promise<string> {
  const entryPath = path.join(ENTRIES_DIR, spec.entry);
  const bundleDir = path.join(outDir, spec.name);
  await mkdir(bundleDir, { recursive: true });

  const outFile = path.join(bundleDir, "index.mjs");

  const options: BuildOptions = {
    ...COMMON_BUILD_OPTIONS,
    entryPoints: [entryPath],
    outfile: outFile,
    target: spec.edge ? "node20" : "node22",
    external: [...(spec.edge ? EDGE_EXTERNAL : REGIONAL_EXTERNAL)],
    ...(spec.edge ? { drop: ["console"] as ("console" | "debugger")[] } : {}),
    // The wrappers import `@de-otio/vestibulum`; esbuild resolves that
    // via the workspace `node_modules` link.
    absWorkingDir: PACKAGE_ROOT,
  };

  await build(options);
  return outFile;
}

/**
 * SHA-256-hash a file's contents (the produced bundle bytes).
 */
async function hashFile(filePath: string): Promise<{ sha256: string; sizeBytes: number }> {
  const buf = await readFile(filePath);
  const hash = createHash("sha256").update(buf).digest("hex");
  return { sha256: `sha256:${hash}`, sizeBytes: buf.byteLength };
}

/**
 * Read the vestibulum runtime version from its package.json.
 *
 * Recorded in the lock manifest so consumers can see what code is
 * actually inside the bundles. Reads the file directly (vestibulum's
 * package.json `exports` map doesn't list a `./package.json` subpath,
 * so `require.resolve` would fail under ESM strict resolution).
 */
async function readVestibulumVersion(): Promise<string> {
  // vestibulum's package.json `exports` map doesn't list `./package.json`,
  // so `require.resolve('@de-otio/vestibulum/package.json')` fails. Fall
  // back to a filesystem-based walk: from this script's location, look
  // for `<repo-root>/node_modules/@de-otio/vestibulum/package.json` (and
  // also check `<repo-root>/packages/vestibulum/package.json` for the
  // monorepo case where the workspace symlink is direct).
  const candidates = [
    path.resolve(
      __dirname,
      "..",
      "..",
      "..",
      "node_modules",
      "@de-otio",
      "vestibulum",
      "package.json",
    ),
    path.resolve(__dirname, "..", "..", "vestibulum", "package.json"),
    path.resolve(__dirname, "..", "node_modules", "@de-otio", "vestibulum", "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const text = await readFile(candidate, "utf8");
      const json = JSON.parse(text) as { name?: string; version?: string };
      if (json.name === "@de-otio/vestibulum" && json.version !== undefined) {
        return json.version;
      }
    } catch {
      // not here — try next candidate.
    }
  }
  throw new Error(
    `Could not locate @de-otio/vestibulum's package.json. Tried: ` + candidates.join(", "),
  );
}

/**
 * Public entry-point: build all ten bundles, hash each, write the lock
 * manifest. Returns the manifest object for callers that want to compare
 * against an existing manifest (the `verify-bundles.ts` gate uses this).
 *
 * @param outDirOverride — for tests / verify-bundles; defaults to `OUTPUT_DIR`.
 */
export async function buildAllBundles(outDirOverride?: string): Promise<BundleLockManifest> {
  const outDir = outDirOverride ?? OUTPUT_DIR;
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const vestibulumVersion = await readVestibulumVersion();

  const bundles: Record<string, BundleLockEntry> = {};
  for (const spec of BUNDLE_ENTRIES) {
    const outFile = await buildBundle(spec, outDir);
    const { sha256, sizeBytes } = await hashFile(outFile);
    bundles[spec.name] = {
      sha256,
      sizeBytes,
      filename: `${spec.name}/index.mjs`,
    };
  }

  return { vestibulumVersion, bundles };
}

/**
 * CLI entry point: build all bundles and write the lock manifest.
 */
async function main(): Promise<void> {
  const manifest = await buildAllBundles();
  // Determinism: sort the bundles map by key so the JSON output is
  // byte-stable across runs (object insertion order varies across Node
  // versions in theory; sorting fixes it in practice).
  const sortedBundles: Record<string, BundleLockEntry> = {};
  for (const k of Object.keys(manifest.bundles).sort()) {
    const entry = manifest.bundles[k];
    if (entry === undefined) {
      throw new Error(`internal: bundle key '${k}' from Object.keys missing`);
    }
    sortedBundles[k] = entry;
  }
  const sortedManifest: BundleLockManifest = {
    vestibulumVersion: manifest.vestibulumVersion,
    bundles: sortedBundles,
  };
  await writeFile(LOCK_PATH, JSON.stringify(sortedManifest, null, 2) + "\n", "utf8");
  // eslint-disable-next-line no-console
  console.log(`@de-otio/vestibulum-cdk: built ${Object.keys(sortedBundles).length} bundles`);
}

/**
 * List the directory contents of `lambda-bundles/` — exported for tests
 * that want to assert the produced layout.
 */
export async function listBundles(outDir: string): Promise<string[]> {
  try {
    const entries = await readdir(outDir);
    const out: string[] = [];
    for (const e of entries) {
      const s = await stat(path.join(outDir, e));
      if (s.isDirectory()) {
        out.push(e);
      }
    }
    return out.sort();
  } catch {
    return [];
  }
}

// Run when invoked as CLI; remain importable for tests.
const argv1 = process.argv[1] ?? "";
if (
  import.meta.url === `file://${argv1}` ||
  argv1.endsWith("/build-bundles.ts") ||
  argv1.endsWith("\\build-bundles.ts")
) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
