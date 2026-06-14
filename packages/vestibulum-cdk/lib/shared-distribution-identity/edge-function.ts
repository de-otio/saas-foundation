/**
 * Lambda@Edge `check-auth` construct + synth-time bundle generator.
 *
 * **Review fix B4 (load-bearing):** Lambda@Edge does NOT support
 * environment variables
 * ([AWS docs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-at-edge-function-restrictions.html)).
 * Config that varies per deployment (tenant parent domain, Cognito
 * issuer URL, JWKS URL, JWKS TTL) MUST be baked into the bundle
 * source at synth time. This module is the bundle generator.
 *
 * Sequence at synth:
 *
 *   1. Compute the synth-time values from
 *      {@link EdgeFunctionProps} (tenant parent, pool issuer URL,
 *      JWKS URL derived from issuer, TTL).
 *   2. Resolve a write location for the generated `edge-config.ts`
 *      module the edge bundle imports. We write it into a hash-
 *      stable subdirectory of the CDK app's outdir (`cdk.out/`)
 *      so the file participates in the bundle hash but does not
 *      mutate the source tree.
 *   3. esbuild the edge handler (which imports the generated
 *      `edge-config.ts`) into a single ESM bundle. The bundle is
 *      what `EdgeFunction` deploys.
 *   4. Compute the SHA-256 of the bundle's bytes and expose it via
 *      `bundleSha256` so P3's `lambda-bundles.lock.json` writer can
 *      verify the bundle is reproducible across runs.
 *
 * The `cloudfront.experimental.EdgeFunction` construct:
 *
 *   - Provisions the function in us-east-1 regardless of the
 *     consumer stack's region (it creates a sibling stack as needed).
 *   - Cross-region version replication is built in.
 *   - **Rejects environment variables at synth time** — passing
 *     `environment: {...}` throws. We verify this with a test
 *     (B4 invariant).
 *
 * MCP C3 confirmed (2026-05-24): the `experimental.EdgeFunction`
 * construct is the recommended pattern for CDK Lambda@Edge in v2;
 * the codebase already uses it in `magic-link-auth-site.ts`.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Duration,
  Stack,
  aws_cloudfront as cloudfront,
  aws_cognito as cognito,
  aws_lambda as lambda,
  aws_logs as logs,
} from "aws-cdk-lib";
import { Construct } from "constructs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Construct props for {@link EdgeFunction}.
 *
 * `tenantSubdomainParent` must be the apex under which tenant
 * subdomains live, without trailing dot (the bundle generator strips
 * one defensively).
 *
 * `tenantSubdomainPattern` is the regex valid tenant subdomain
 * labels must match — bound at synth time and serialised into the
 * generated config.
 *
 * `userPool` provides the issuer URL. The issuer is derived as
 * `https://cognito-idp.${stack.region}.amazonaws.com/${userPool.userPoolId}`;
 * the JWKS URL is `${issuer}/.well-known/jwks.json`.
 *
 * `jwksTtl` defaults to 15 minutes per
 * `04-multi-aud-edge-check.md` § JWT verification posture.
 */
export interface EdgeFunctionProps {
  /** Tenant parent FQDN, e.g. `tenants.example.com` — no trailing dot. */
  readonly tenantSubdomainParent: string;
  /** Regex tenant subdomain labels must match. Bound into the bundle. */
  readonly tenantSubdomainPattern: RegExp;
  /** Cognito User Pool — supplies the issuer URL. */
  readonly userPool: cognito.IUserPool;
  /** JWKS cache TTL. Default 15 min. */
  readonly jwksTtl?: Duration;
  /**
   * Override the on-disk path to the `@de-otio/vestibulum` runtime
   * package root (the parent of `src/lambda/shared-distribution/edge/`).
   * Test-only.
   *
   * @internal
   */
  readonly _vestibulumPackageRoot?: string;
  /**
   * Override the directory the bundle generator writes into.
   * Test-only — production consumers leave this unset; the
   * default writes under the CDK app outdir.
   *
   * @internal
   */
  readonly _bundleOutDirOverride?: string;
  /**
   * Skip the esbuild step. Test-only: when set, the construct does
   * not run esbuild but still writes the generated config module
   * and returns a deterministic placeholder bundle hash. Used by
   * synth tests that exercise the generator without paying the
   * esbuild cost.
   *
   * @internal
   */
  readonly _skipBundle?: boolean;
}

/**
 * The four (well, five) values baked into the generated config.
 *
 * Exported for tests that want to verify the synth-time computation
 * without parsing the on-disk file.
 */
export interface ResolvedEdgeConfig {
  readonly TENANT_PARENT: string;
  readonly TENANT_PATTERN: RegExp;
  readonly POOL_ISSUER: string;
  readonly JWKS_URL: string;
  readonly JWKS_TTL_MS: number;
}

/**
 * Default JWKS TTL: 15 minutes. Matches
 * `04-multi-aud-edge-check.md` § JWT verification posture.
 */
export const DEFAULT_JWKS_TTL = Duration.minutes(15);

/**
 * Compute the resolved edge config from props. Pure function so tests
 * can assert on it without a synth.
 */
export function resolveEdgeConfig(
  props: EdgeFunctionProps,
  region: string,
): ResolvedEdgeConfig {
  const parent = props.tenantSubdomainParent.replace(/\.$/, "");
  const poolIssuer = `https://cognito-idp.${region}.amazonaws.com/${props.userPool.userPoolId}`;
  const jwksUrl = `${poolIssuer}/.well-known/jwks.json`;
  const jwksTtlMs = (props.jwksTtl ?? DEFAULT_JWKS_TTL).toMilliseconds();
  return {
    TENANT_PARENT: parent,
    TENANT_PATTERN: props.tenantSubdomainPattern,
    POOL_ISSUER: poolIssuer,
    JWKS_URL: jwksUrl,
    JWKS_TTL_MS: jwksTtlMs,
  };
}

/**
 * Serialise a {@link ResolvedEdgeConfig} as the TypeScript module body
 * the edge handler imports. The output is byte-stable across two
 * synths with the same input (the determinism property the bundle
 * SHA-256 test guards).
 */
export function renderEdgeConfigModule(cfg: ResolvedEdgeConfig): string {
  // Serialise the regex with its flags so reconstitution is round-trippable.
  const patternSrc = cfg.TENANT_PATTERN.source;
  const patternFlags = cfg.TENANT_PATTERN.flags;
  const lines = [
    "// AUTO-GENERATED at synth time by @de-otio/vestibulum-cdk's EdgeFunction.",
    "// DO NOT EDIT BY HAND — regenerated on every `cdk synth`.",
    "// Lambda@Edge does not support env vars; config is baked here (review B4).",
    "",
    `export const TENANT_PARENT = ${JSON.stringify(cfg.TENANT_PARENT)};`,
    `export const TENANT_PATTERN = new RegExp(${JSON.stringify(patternSrc)}, ${JSON.stringify(patternFlags)});`,
    `export const POOL_ISSUER = ${JSON.stringify(cfg.POOL_ISSUER)};`,
    `export const JWKS_URL = ${JSON.stringify(cfg.JWKS_URL)};`,
    `export const JWKS_TTL_MS = ${cfg.JWKS_TTL_MS};`,
    "",
  ];
  return lines.join("\n");
}

/**
 * Construct the Lambda@Edge `check-auth` function.
 *
 * Exposes:
 *  - `version`: the `lambda.IVersion` the consumer wires into a
 *    CloudFront distribution as an edge lambda.
 *  - `edgeFunction`: the underlying `experimental.EdgeFunction`,
 *    escape-hatch for advanced consumer wiring.
 *  - `logGroups`: per-region edge log groups. Empty by default —
 *    edge log groups are auto-created in each PoP region at first
 *    invocation; consumers wishing to subscribe them ahead of time
 *    populate this list. (See
 *    `04-multi-aud-edge-check.md` § Edge logging.)
 *  - `bundleSha256`: SHA-256 of the produced bundle bytes (for the
 *    P3 lock manifest).
 *  - `resolvedConfig`: the values baked into the bundle (test-visible).
 */
export class EdgeFunction extends Construct {
  /** The deployed function version — wire into CloudFront's edgeLambdas. */
  public readonly version: lambda.IVersion;
  /** Underlying experimental.EdgeFunction for advanced wiring. */
  public readonly edgeFunction: cloudfront.experimental.EdgeFunction;
  /** Per-region edge log groups (populated lazily by consumer code). */
  public readonly logGroups: logs.ILogGroup[];
  /** SHA-256 hex of the bundle bytes (`sha256:...`). Stable across re-synths. */
  public readonly bundleSha256: string;
  /** The config values baked into the bundle. */
  public readonly resolvedConfig: ResolvedEdgeConfig;
  /** Absolute path to the directory holding the bundled artifacts. */
  public readonly bundlePath: string;

  public constructor(scope: Construct, id: string, props: EdgeFunctionProps) {
    super(scope, id);

    const stack = Stack.of(this);
    const region = stack.region;
    this.resolvedConfig = resolveEdgeConfig(props, region);

    const moduleSource = renderEdgeConfigModule(this.resolvedConfig);

    // -----------------------------------------------------------------
    // Pick a stable, app-outdir-rooted location for the bundle so re-
    // synths regenerate idempotently. CDK app's outdir is the only
    // directory we can write to without polluting the source tree.
    // -----------------------------------------------------------------
    // `aws:cdk:outdir` is set by CDK at synth time; fall back to
    // `cdk.out`. Resolve to an absolute path so esbuild's entryPoints
    // can locate the staged source regardless of the process CWD.
    const rawOutdir: unknown = stack.node.tryGetContext("aws:cdk:outdir") as unknown ?? "cdk.out";
    const appOutdir = path.resolve(
      typeof rawOutdir === "string" ? rawOutdir : "cdk.out",
    );
    const defaultOutDir = path.join(
      appOutdir,
      ".vestibulum-edge-bundles",
      this.node.addr,
    );
    const bundleOutDir = props._bundleOutDirOverride ?? defaultOutDir;

    // Stage 1: write the generated config + a stub handler so the
    // EdgeFunction's `Code.fromAsset` sees a non-empty directory.
    // The real bundle (Stage 2) is built into the same directory,
    // overwriting the stub if needed.
    fs.mkdirSync(bundleOutDir, { recursive: true });
    fs.writeFileSync(path.join(bundleOutDir, "edge-config.ts"), moduleSource);

    if (props._skipBundle === true) {
      // Test-only: skip the esbuild call and emit a deterministic stub
      // bundle. The SHA-256 is computed over the generated config
      // module bytes so the determinism property still applies.
      const stub = `// stub bundle for tests\nexport const handler = async () => ({});\n`;
      fs.writeFileSync(path.join(bundleOutDir, "index.mjs"), stub);
      this.bundleSha256 =
        "sha256:" +
        createHash("sha256")
          .update(moduleSource + stub)
          .digest("hex");
    } else {
      // Stage 2: build the real bundle. We do this synchronously via
      // `esbuild.buildSync` so the construct's constructor returns a
      // fully-constructed asset directory; CDK then `Code.fromAsset`s
      // it without further async work.
      this.bundleSha256 = buildEdgeBundleSync({
        bundleOutDir,
        generatedConfigModule: moduleSource,
        vestibulumPackageRoot:
          props._vestibulumPackageRoot ?? defaultVestibulumPackageRoot(),
      });
    }

    this.bundlePath = bundleOutDir;

    this.edgeFunction = new cloudfront.experimental.EdgeFunction(this, "Fn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(bundleOutDir),
      // Intentionally NO `environment`. Lambda@Edge rejects env vars.
      // The bundle is self-configured via the generated `edge-config.ts`.
    });

    this.version = this.edgeFunction;
    this.logGroups = [];
  }
}

/**
 * Locate the on-disk root of the `@de-otio/vestibulum` package. Used
 * to resolve the edge handler source for the esbuild call.
 *
 * Walks upward from this module's location, matching the two layouts
 * the publish pipeline produces (workspace symlink + tarball install).
 */
export function defaultVestibulumPackageRoot(): string {
  // From `<cdk-pkg>/dist/shared-distribution-identity/edge-function.js`
  // (or `<cdk-pkg>/lib/shared-distribution-identity/edge-function.ts`)
  // try the monorepo sibling and the published node_modules path.
  const candidates = [
    path.resolve(__dirname, "..", "..", "..", "vestibulum"),
    path.resolve(__dirname, "..", "..", "node_modules", "@de-otio", "vestibulum"),
    path.resolve(__dirname, "..", "..", "..", "node_modules", "@de-otio", "vestibulum"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "src", "lambda", "shared-distribution", "edge"))) {
      return c;
    }
  }
  throw new Error(
    "EdgeFunction: could not locate @de-otio/vestibulum's source tree. " +
      "Tried: " +
      candidates.join(", "),
  );
}

interface BuildEdgeBundleArgs {
  readonly bundleOutDir: string;
  readonly generatedConfigModule: string;
  readonly vestibulumPackageRoot: string;
}

/**
 * Build the edge bundle synchronously into `bundleOutDir/index.mjs`.
 * Returns the SHA-256 of the produced bundle bytes.
 *
 * Synchronous because CDK constructors are synchronous. esbuild
 * provides `buildSync` for exactly this purpose; the cost is a
 * one-time ~50ms per synth which is acceptable.
 *
 * Determinism: the build options mirror the ones in
 * `scripts/build-bundles.ts` (`minify: true`, `legalComments: 'none'`,
 * `sourcemap: false`, `keepNames: false`, `target: node20`,
 * `drop: ['console']`). The `aws-jwt-verify` package is INLINED (not
 * externalised) — L@E does not provide it.
 */
function buildEdgeBundleSync(args: BuildEdgeBundleArgs): string {
  // The handler lives at:
  //   <vestibulum>/src/lambda/shared-distribution/edge/check-auth.ts
  // and imports its config from `./generated/edge-config.js` (relative
  // to itself).
  const handlerDir = path.join(
    args.vestibulumPackageRoot,
    "src",
    "lambda",
    "shared-distribution",
    "edge",
  );
  const handlerSource = path.join(handlerDir, "check-auth.ts");

  if (!fs.existsSync(handlerSource)) {
    throw new Error(
      `EdgeFunction: handler source not found at ${handlerSource}. ` +
        `Check that @de-otio/vestibulum is installed and that 'src/' ships.`,
    );
  }

  // -----------------------------------------------------------------
  // Strategy: copy the entire vestibulum edge handler tree into a
  // staging directory inside bundleOutDir, overwrite
  // `generated/edge-config.ts` with the synth-time config, and run
  // esbuild against the copy. This is the cleanest sync-safe approach
  // (esbuild's `alias` rejects absolute paths; plugins require the
  // async API).
  //
  // The copy is shallow on directory layout but reads every .ts/.mjs
  // file we care about. The total source is ~20 KB so the cost is
  // negligible vs. the esbuild work itself.
  // -----------------------------------------------------------------
  const stagingDir = path.join(args.bundleOutDir, "_staging");
  fs.mkdirSync(stagingDir, { recursive: true });
  copyDirRecursive(handlerDir, stagingDir);
  // Overwrite the placeholder with the synth-time config.
  const generatedDir = path.join(stagingDir, "generated");
  fs.mkdirSync(generatedDir, { recursive: true });
  fs.writeFileSync(
    path.join(generatedDir, "edge-config.ts"),
    args.generatedConfigModule,
  );

  // Also drop the shared dep (extractTenantSubdomain) — the handler
  // imports from `../shared/extract-tenant-subdomain.js`. Copy the
  // sibling `shared/` directory too.
  const sharedSource = path.join(
    args.vestibulumPackageRoot,
    "src",
    "lambda",
    "shared-distribution",
    "shared",
  );
  if (fs.existsSync(sharedSource)) {
    const sharedDest = path.join(stagingDir, "..", "shared");
    fs.mkdirSync(sharedDest, { recursive: true });
    copyDirRecursive(sharedSource, sharedDest);
  }

  // esbuild is a peer-of-dev dependency of vestibulum-cdk. Load it
  // synchronously via `createRequire` so the construct's constructor
  // remains synchronous (CDK constructors cannot `await import`).
  const requireFn = createRequire(import.meta.url);
  const esbuild = requireFn("esbuild") as typeof import("esbuild");

  const stagedHandler = path.join(stagingDir, "check-auth.ts");
  const outFile = path.join(args.bundleOutDir, "index.mjs");
  esbuild.buildSync({
    entryPoints: [stagedHandler],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    minify: true,
    sourcemap: false,
    legalComments: "none",
    treeShaking: true,
    keepNames: false,
    outExtension: { ".js": ".mjs" },
    drop: ["console"],
    // Resolve node_modules from the vestibulum package root so
    // `aws-jwt-verify` and friends are findable even when the
    // handler source has been copied into a tmpdir.
    absWorkingDir: args.vestibulumPackageRoot,
    nodePaths: [
      path.join(args.vestibulumPackageRoot, "node_modules"),
      path.join(args.vestibulumPackageRoot, "..", "..", "node_modules"),
    ],
    // Externalise AWS SDK v3 (L@E provides it); inline everything else
    // including aws-jwt-verify.
    external: ["@aws-sdk/*"],
  });

  const bytes = fs.readFileSync(outFile);
  const sha = createHash("sha256").update(bytes).digest("hex");

  // Tidy up staging — only the final bundle should remain in the asset
  // directory so CDK's asset hash is just the bundle.
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.rmSync(path.join(args.bundleOutDir, "..", "shared"), {
    recursive: true,
    force: true,
  });
  if (fs.existsSync(path.join(args.bundleOutDir, "edge-config.ts"))) {
    fs.unlinkSync(path.join(args.bundleOutDir, "edge-config.ts"));
  }

  return `sha256:${sha}`;
}

/**
 * Synchronously copy a directory tree. Used by the bundle generator
 * to stage the vestibulum edge handler source for esbuild.
 */
function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const e of entries) {
    const srcPath = path.join(src, e.name);
    const destPath = path.join(dest, e.name);
    if (e.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (e.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
