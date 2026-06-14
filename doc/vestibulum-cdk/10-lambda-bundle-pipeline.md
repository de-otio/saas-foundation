# 10 — Lambda bundle pipeline

`@de-otio/vestibulum-cdk` ships pre-built Lambda code in its
published tarball. The handlers (four `CUSTOM_AUTH` triggers,
bounce-handler, `auth-verify`, `auth-signout`, `check-auth` for
Lambda@Edge, the `pre-token-generation` and `post-confirmation`
hooks, plus the v0.2 shared-distribution `admin` and `reconciler`
handlers — 12 bundle entry points in total) are built at
vestibulum-cdk's publish time by bundling the runtime source from
`@de-otio/vestibulum`. This file pins the build-time pipeline, the
hash manifest, the CI gates, and the CFn asset shape — the
CDK-specific corners that
[`../02-monorepo-layout.md`](../02-monorepo-layout.md) and
[`../05-versioning-and-releases.md`](../05-versioning-and-releases.md)
don't fully cover.

The cross-package prerequisite for this pipeline — moving the
Lambda handler source out of vestibulum-cdk and into the vestibulum
runtime — is captured in
[`../07-vestibulum-migration.md § Lambda handler source move`](../07-vestibulum-migration.md#lambda-handler-source-move--the-cross-package-bundling-prerequisite).
Without that move, the cross-package boundary this pipeline verifies
across does not exist.

## Why bundle, not depend

If `vestibulum-cdk` declared `@de-otio/vestibulum` as a runtime npm
dep, every consumer's CDK synth process would pull Cognito SDK +
foundation into the synth — slow, irrelevant, and a footgun (CDK
constructs accidentally calling Cognito SDK at synth time is a real
failure mode). Bundling once at publish time isolates the runtime
to the deployed Lambda; the consumer's synth process never sees
vestibulum source. See
[`../03-package-relationships.md § The bundling relationship in
detail`](../03-package-relationships.md#the-bundling-relationship-in-detail)
for the cross-package rationale.

## What gets bundled

Each Lambda handler the vestibulum runtime exports is a separate
bundle entry-point. The ten single-tenant handlers are imported from
`@de-otio/vestibulum`'s barrel (see
[`../07-vestibulum-migration.md § Lambda handler source move`](../07-vestibulum-migration.md#lambda-handler-source-move--the-cross-package-bundling-prerequisite));
the two v0.2 shared-distribution handlers (`admin`, `reconciler`) are
imported from the runtime's `src/lambda/shared-distribution/` tree,
which is surfaced through vestibulum's barrel via the `sharedDistribution`
namespace export. vestibulum-cdk imports them all at build time and
produces one bundle per entry.

The canonical entry list lives in `BUNDLE_ENTRIES` in
`scripts/build-bundles.ts`; it has **12** entries.

| Bundle name            | Runtime export / source                                       | Used by construct                |
| ---------------------- | ------------------------------------------------------------- | -------------------------------- |
| `pre-signup`           | `createPreSignupHandler`                                      | `MagicLinkIdentity`              |
| `define-auth`          | `createDefineAuthChallengeHandler`                            | `MagicLinkIdentity`              |
| `create-auth`          | `createCreateAuthChallengeHandler`                            | `MagicLinkIdentity`              |
| `verify-auth`          | `createVerifyAuthChallengeResponseHandler`                    | `MagicLinkIdentity`              |
| `bounce-handler`       | `createBounceHandler`                                         | `MagicLinkIdentity`              |
| `auth-verify`          | `createAuthVerifyHandler`                                     | `MagicLinkAuthSite`              |
| `auth-signout`         | `createAuthSignoutHandler`                                    | `MagicLinkAuthSite`              |
| `check-auth`           | `createEdgeCheckAuthHandler`                                  | `MagicLinkAuthSite` (L@E)        |
| `pre-token-generation` | `createPreTokenGenerationHandler`                             | `MagicLinkIdentity` (opt.)       |
| `post-confirmation`    | `createPostConfirmationHandler`                               | `MagicLinkIdentity` (opt.)       |
| `admin`                | `shared-distribution/admin/index.ts` `handler` (Function URL) | `AdminLambda` (shared-dist v0.2) |
| `reconciler`           | `shared-distribution/admin/reconciler.ts` `handler` (scheduled) | `Reconciler` (shared-dist v0.2)  |

The `pre-token-generation` and `post-confirmation` bundles are
themselves optional inputs to the constructs — they ship as bundled
artifacts in the tarball but are only wired as Cognito triggers when
the consumer doesn't supply their own Lambdas via
`preTokenGeneration` / `postConfirmation` props. The `admin` and
`reconciler` bundles back the v0.2 shared-distribution constructs
(see [`01-package-api.md § v0.2 shared-distribution constructs`](01-package-api.md#v02-shared-distribution-constructs)).

Each entry maps to a small wrapper file under
`packages/vestibulum-cdk/scripts/lambda-entries/` that imports from
`@de-otio/vestibulum` and re-exports a `handler` function:

```typescript
// packages/vestibulum-cdk/scripts/lambda-entries/pre-signup.ts
import { createPreSignupHandler } from "@de-otio/vestibulum";

export const handler = createPreSignupHandler();
```

The wrappers exist so the build script has a stable entry point per
trigger, decoupled from however `@de-otio/vestibulum` chooses to lay
out its exports internally. The ten single-tenant factory functions
are _exported_ from vestibulum's `index.ts` and imported by name. The
two shared-distribution wrappers
(`shared-distribution-admin.ts`, `shared-distribution-reconciler.ts`)
re-export `handler` from the runtime's
`src/lambda/shared-distribution/admin/` tree, surfaced in vestibulum's
barrel via the `sharedDistribution` namespace export.

## Bundler

**esbuild** with deterministic options. The regional bundles and the
L@E bundle have slightly different `external` and `drop` settings:

```typescript
// packages/vestibulum-cdk/scripts/build-bundles.ts

// Regional bundles (everything except check-auth): pre-signup,
// define-auth, create-auth, verify-auth, bounce-handler, auth-verify,
// auth-signout, pre-token-generation, post-confirmation, admin,
// reconciler.
await build({
  entryPoints: [
    /* eleven regional bundles */
  ],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  treeShaking: true,
  external: [
    "@aws-sdk/*", // provided by Lambda runtime
    "aws-jwt-verify", // regional handlers can externalize;
    // AWS SDK v3 ships modern crypto so the
    // verifier resolves transitively
  ],
  outdir: "lambda-bundles",
  outExtension: { ".js": ".mjs" },
  metafile: true,
});

// Lambda@Edge bundle (check-auth) — extra discipline.
await build({
  entryPoints: ["scripts/lambda-entries/check-auth.ts"],
  bundle: true,
  platform: "node",
  target: "node20", // L@E coverage
  format: "esm",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  treeShaking: true,
  drop: ["console"], // mandatory mitigation 1 — see below
  external: [
    "@aws-sdk/*", // provided by Lambda runtime
    // NOT aws-jwt-verify — must inline; see Lambda@Edge specifics
  ],
  outdir: "lambda-bundles",
  outExtension: { ".js": ".mjs" },
  metafile: true,
});
```

Deterministic-output rules:

- **No build timestamps** in the output (esbuild defaults to no
  timestamps in the bytes themselves, but we also pass
  `legalComments: 'none'` to drop the comments that would otherwise
  embed dep versions).
- **Sorted output** — esbuild's default is deterministic given
  identical input + options.
- **Same input commit → same output bytes.** Verified by the
  CI determinism test (two clean builds, hash the outputs, expect
  identical SHA-256s).
- **Pinned esbuild binary.** The exact esbuild version (and its
  platform-specific binary checksum) is pinned in
  `packages/vestibulum-cdk/package.json` with an exact version (no
  `^`) and `package-lock.json` carries the integrity hash. Defends
  against supply-chain substitution: a tampered esbuild binary could
  inject arbitrary code into every bundle without the manifest
  noticing (the manifest hashes the _output_, not the bundler).

### Lambda@Edge specifics

The `check-auth` bundle has three extra constraints:

- **`aws-jwt-verify` must be inlined**, not externalized. Lambda@Edge
  does not provide `aws-jwt-verify` in its execution environment;
  marking it `external` produces a runtime `MODULE_NOT_FOUND` on the
  first cold start of the replicated function. The verifier and its
  transitive deps fit comfortably within the 1 MB compressed cap.
- **`drop: ['console']` enforces Mandatory Mitigation 1 at build
  time.** A bundle that contains no `console.*` call sites cannot
  emit log output even if a future runtime change relaxes the IAM
  `logs:*` denial. The integration test that grep'd the bundle for
  `console.` still runs in CI as defence-in-depth over the bundled
  bytes — `drop: ['console']` and the integration test catch the
  same class of regression by different mechanisms.
- **Code size:** Lambda@Edge has a 1 MB compressed code-package
  limit (vs the regional Lambda 50 MB). With `aws-jwt-verify`
  inlined, current bundle weight is well under the cap; a CI gate
  fails the build when the compressed bundle exceeds **80% of the
  1 MB ceiling** (~800 KB) so dependency creep surfaces before
  deploy time. The budget is configurable in the bundle script;
  bumping it requires a documented justification.
- **Runtime:** `NODEJS_20_X` (Lambda@Edge's coverage). Regional
  handlers use `NODEJS_22_X`.

`aws-jwt-verify` is the only npm dep in the edge bundle. AWS SDK
clients are not in the edge bundle (the edge function does not call
Cognito at runtime — it only verifies the JWT signature against
cached JWKS).

## CloudFormation asset shape

Each bundle is referenced from the construct via
`lambda.Code.fromAsset(...)`:

```typescript
const bundlePath = path.join(__dirname, "../../lambda-bundles/pre-signup");
new lambda.Function(this, "PreSignUpFn", {
  code: lambda.Code.fromAsset(bundlePath),
  handler: "index.handler",
  runtime: lambda.Runtime.NODEJS_22_X,
  // ... environment, IAM, etc.
});
```

CDK hashes the asset directory at synth time and includes the hash
in the CFn stack's asset metadata. Two consequences:

- **CDK asset hash ≠ vestibulum-cdk's manifest hash.** CDK's asset
  hash is a synth-time, consumer-side artifact; vestibulum-cdk's
  manifest hash is a publish-time, package-side artifact. The two
  should both be stable per vestibulum-cdk version but they hash
  different things (CDK adds metadata; vestibulum-cdk hashes raw
  bundle bytes).
- **Cross-stack synth determinism.** Two consumers synthesising the
  same vestibulum-cdk version produce the same CDK asset hashes,
  because the bundle bytes are committed to the published tarball.

### Why not `NodejsFunction` per Lambda?

`NodejsFunction` (CDK's wrapper that runs esbuild at _synth_ time)
is convenient for application code but wrong for vestibulum-cdk's
bundled Lambdas because:

- It runs esbuild in the consumer's synth process — slow on every
  `cdk synth`, even when the consumer hasn't touched vestibulum-cdk.
- The bundle bytes depend on the consumer's node_modules / lockfile
  rather than vestibulum-cdk's, so the hash manifest can't pin them.
- Determinism across consumer environments is harder.
- It also defeats the IAM-grant story for `Code.fromAsset`: an asset
  built at publish time does not require the consumer's deploy role
  to grant any esbuild-related permission at synth (no synth-time
  npm install, no synth-time binary execution outside CDK's own
  asset bundling). `Code.fromAsset` reads pre-built bytes from the
  package; there is nothing to grant.

Every Lambda in `MagicLinkIdentity` and `MagicLinkAuthSite` (regional
and L@E) uses `lambda.Function` (or `cloudfront.experimental.EdgeFunction`
for `check-auth`) plus `lambda.Code.fromAsset(bundlePath)`. The
construct deep-design docs
([`02-magic-link-identity.md`](02-magic-link-identity.md) and
[`04-magic-link-auth-site.md`](04-magic-link-auth-site.md)) reflect
this pattern uniformly.

## Hash manifest

The build script writes a manifest after bundling:

```jsonc
// packages/vestibulum-cdk/lambda-bundles.lock.json
// Keys are sorted; each entry also carries a `filename` field
// ("<name>/index.mjs"), elided here for brevity.
{
  "vestibulumVersion": "0.2.0",
  "bundles": {
    "admin":                 { "sha256": "sha256:...", "sizeBytes": ... },
    "auth-signout":          { "sha256": "sha256:...", "sizeBytes": ... },
    "auth-verify":           { "sha256": "sha256:...", "sizeBytes": ... },
    "bounce-handler":        { "sha256": "sha256:...", "sizeBytes": ... },
    "check-auth":            { "sha256": "sha256:...", "sizeBytes": ... },
    "create-auth":           { "sha256": "sha256:...", "sizeBytes": ... },
    "define-auth":           { "sha256": "sha256:...", "sizeBytes": ... },
    "post-confirmation":     { "sha256": "sha256:...", "sizeBytes": ... },
    "pre-signup":            { "sha256": "sha256:...", "sizeBytes": ... },
    "pre-token-generation":  { "sha256": "sha256:...", "sizeBytes": ... },
    "reconciler":            { "sha256": "sha256:...", "sizeBytes": ... },
    "verify-auth":           { "sha256": "sha256:...", "sizeBytes": ... }
  }
}
```

- **Committed to the repo.** The lock file is the cross-version
  contract — anyone can read it without running the build.
- The `lambda-bundles/` directory itself is **gitignored**. Bundles
  are produced by the build, not stored.
- **Hashed bytes, not files.** SHA-256 over the concatenated bundle
  bytes; size in bytes is informational.

## CI gates

Three gates protect the bundling integrity:

### 1. `build-bundles` runs as part of every PR build

The bundle directory is gitignored, so PRs that change the runtime
source must re-bundle locally; CI re-bundles and compares against
the committed manifest. A PR that bumps the runtime without
updating the manifest fails CI.

### 2. `verify-bundles` runs in CI and as the publish prerequisite

```bash
node packages/vestibulum-cdk/scripts/verify-bundles.ts
```

- Reads the committed `lambda-bundles.lock.json`.
- Runs the build script to produce fresh bundles.
- SHA-256-hashes the fresh bundles, compares to the manifest.
- Fails non-zero on any mismatch.

The publish workflow runs `verify-bundles` immediately before
`npm publish`. A release that ships out-of-sync bundles fails the
workflow before any tarball leaves the build host.

### 3. Determinism check

A separate CI job runs the build twice in clean checkouts and
asserts the resulting bundle bytes are byte-for-byte identical. Any
non-determinism source (build timestamps, source-map randomisation,
sort instability) fails the gate.

## Consumer-side verification

After `npm install`, consumers can verify the shipped bundles match
the published manifest:

```bash
node node_modules/@de-otio/vestibulum-cdk/scripts/verify-bundles.js
```

Output on success:

```
@de-otio/vestibulum-cdk: verified 12 bundle hash(es) OK
```

Any mismatch exits non-zero — investigate before deploying.

Once the monorepo's publish workflow runs from a public repo (see
[`../05-versioning-and-releases.md`](../05-versioning-and-releases.md)
for the public-vs-private posture), `npm publish --provenance`
produces a sigstore attestation tied to a specific GitHub Actions
workflow run and commit; consumers gain a second verification path
via the npm package page.

## Version-bump consequences

A change to the vestibulum runtime can affect vestibulum-cdk in
three ways:

| Runtime change                                             | vestibulum-cdk effect                                                                  | Action                                                  |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Non-Lambda surface (IdP managers, admin HTTP helpers)      | None — no bundle re-build needed                                                       | Bump vestibulum, leave cdk alone                        |
| Lambda handler surface (any of the 12 bundle entry points) | Bundle re-build required; manifest hash changes                                        | Bump cdk, re-bundle, publish                            |
| Frozen-set type (re-exported via vestibulum)               | None at the bundle level (types are erased), but consumers may need to bump foundation | Coordinated bump per `../05-versioning-and-releases.md` |

A consumer who installs `@de-otio/vestibulum@0.3.0` and
`@de-otio/vestibulum-cdk@0.1.5` (the latter bundling
`vestibulum@0.2.4`) is fine, _unless_ they expect their Lambda
triggers to run the 0.3.0 code. They won't — Lambdas run the
bundled-at-publish-time code. The consumer-facing docs make this
explicit; the manifest's `vestibulumVersion` field records the
exact version bundled.

## `files` allow-list

The published tarball includes only what's needed:

```jsonc
// packages/vestibulum-cdk/package.json
{
  "files": [
    "dist",
    "lambda-bundles",
    "lambda-bundles.lock.json",
    "scripts/build-bundles.js",
    "scripts/verify-bundles.js",
    "scripts/lambda-entries",
    "README.md",
    "CHANGELOG.md",
  ],
}
```

Allow-list (not `.npmignore`) so a new file is excluded by default.
Tests, raw sources of the lambda-entries wrappers, `.github/`,
`.changeset/`, `tsconfig.json` — none of these ship.

## What this file doesn't cover

- **Cross-package dep graph** (foundation → vestibulum →
  vestibulum-cdk) — see
  [`../03-package-relationships.md`](../03-package-relationships.md).
- **Workspace build orchestration** (`scripts/build/topo.mjs`,
  topological order) — see
  [`../02-monorepo-layout.md`](../02-monorepo-layout.md).
- **Per-package release tagging and changesets workflow** — see
  [`../05-versioning-and-releases.md`](../05-versioning-and-releases.md).
- **Repository visibility and the sigstore-attestation flip** —
  same.

## Open questions

- **A `vestibulum/lambda/*` subpath export in the runtime package?**
  Today the bundle script names specific runtime entry points
  (`createPreSignupHandler`, etc.). A cleaner shape is for
  vestibulum to declare its own bundle-target exports
  (`@de-otio/vestibulum/lambda/pre-signup`, etc.), so the
  vestibulum-cdk build script just consumes them rather than
  reaching into the runtime's internal layout. Tracked in
  [`../03-package-relationships.md § Open questions`](../03-package-relationships.md#open-questions);
  affects vestibulum's exports map.
- **Reproducible-build attestation** beyond sigstore? Today the
  determinism test catches non-deterministic builds in CI. A
  consumer wanting to reproduce the bundle from source locally
  needs to pin Node, npm, and the workspace dependency tree —
  documented in the release checklist.
- **Per-regional-handler size budgets.** The L@E bundle has a hard
  1 MB compressed cap and the build script enforces an 80% warning
  threshold (see § Lambda@Edge specifics). Regional handlers have
  a 50 MB ceiling that no realistic vestibulum bundle approaches,
  so no per-bundle budget is wired for them today; revisit if a
  regional handler grows beyond ~10 MB compressed.
