# 07 — Folding vestibulum into the saas-foundation monorepo

## Status

COMPLETE — vestibulum was folded into this monorepo, jest→vitest port done, all four packages published. Retained as the historical migration record.

## Why now

Vestibulum is not shipped. Its three planned consumers are internal and not
yet integrated. The contact surface between vestibulum's runtime
(`IdpSecretsClient`, IdP managers, JWT verifier) and saas-foundation's
runtime (SSM secrets loader, tenant context, logger, audit) is real:
duplicating a small shared vocabulary across two release pipelines forever
is the cost of staying separate. Folding now is mechanical; folding after
v0.1 ships to even one external consumer requires a deprecation cycle.

The redesign budget is open: package names, repo layout, and the runtime
API in `vestibulum/doc/federation/02-runtime-api.md` can all change as
part of this move.

## Target shape

Workspaces, under saas-foundation root:

```
saas-foundation/
├── packages/
│   ├── foundation/         # @de-otio/saas-foundation — runtime core
│   ├── vestibulum/         # @de-otio/vestibulum — identity runtime
│   └── vestibulum-cdk/     # @de-otio/vestibulum-cdk — CDK constructs
├── doc/                    # cross-cutting + per-package designs
├── examples/               # end-to-end consumer examples
└── package.json            # workspace root
```

Four published npm packages, each independently versioned:

| Package                        | Source (today)                             | Peer deps                     |
| ------------------------------ | ------------------------------------------ | ----------------------------- |
| `@de-otio/saas-foundation`     | extracted from `trellis/apps/api/src/lib/` | (none beyond AWS SDK clients) |
| `@de-otio/vestibulum`          | `vestibulum/runtime/src/`                  | `@de-otio/saas-foundation`    |
| `@de-otio/saas-foundation-cdk` | `trellis-platform/infra/lib/constructs/`   | `aws-cdk-lib`, `constructs`   |
| `@de-otio/vestibulum-cdk`      | `vestibulum/lib/`                          | `aws-cdk-lib`, `constructs`   |

`@de-otio/vestibulum-cdk` bundles `@de-otio/vestibulum` Lambda code at build
time (via the existing `esbuild` script). Runtime dependence is internal to
the bundle; consumers do not need to install `vestibulum` separately when
they install `vestibulum-cdk`.

## What moves where

### Source code

| From (`/Users/rmyers/repos/dot/vestibulum/`)                    | To (`/Users/rmyers/repos/dot/saas-foundation/`)                   |
| --------------------------------------------------------------- | ----------------------------------------------------------------- |
| `lib/constructs/`                                               | `packages/vestibulum-cdk/lib/constructs/`                         |
| `lib/aspects/`, `lib/cdk-nag-rules/`, `lib/waf/`, `lib/shared/` | `packages/vestibulum-cdk/lib/{aspects,cdk-nag-rules,waf,shared}/` |
| `lib/lambda-handlers/`                                          | **`packages/vestibulum/src/lambda/handlers/`** (see below)        |
| `lib/lambda-edge/`                                              | **`packages/vestibulum/src/lambda/edge/`** (see below)            |
| `lib/login-pages/`                                              | `packages/vestibulum-cdk/login-pages/`                            |
| `runtime/src/`                                                  | `packages/vestibulum/src/` (merged with new `lambda/` dir)        |
| `runtime/test/`                                                 | `packages/vestibulum/test/`                                       |
| `test/`                                                         | `packages/vestibulum-cdk/test/`                                   |
| `scripts/` (CDK bundle/verify scripts)                          | `packages/vestibulum-cdk/scripts/`                                |
| `examples/`                                                     | `examples/vestibulum-magic-link/` (root-level)                    |
| `RoPA.md`                                                       | `packages/vestibulum-cdk/RoPA.md`                                 |
| `CHANGELOG.md`                                                  | `packages/vestibulum-cdk/CHANGELOG.md`                            |
| `runtime/CHANGELOG.md`                                          | `packages/vestibulum/CHANGELOG.md`                                |

### Lambda handler source move — the cross-package bundling prerequisite

The standalone vestibulum repo colocates Lambda handler source with
its CDK constructs (`lib/lambda-handlers/`, `lib/lambda-edge/`). In
the monorepo, those files move into the **vestibulum runtime
package** (`packages/vestibulum/src/lambda/`), where they belong:
the runtime is what runs at request time, and the CDK package only
bundles those handlers at build time. Without this move, the
"vestibulum-cdk bundles from vestibulum" story in
[`02-monorepo-layout.md`](02-monorepo-layout.md#bundling-vestibulum-lambda-code-into-vestibulum-cdk)
and [`03-package-relationships.md`](03-package-relationships.md#the-bundling-relationship-in-detail)
collapses to "vestibulum-cdk bundles itself" and the cross-package
hash-verify CI gate has no actual cross-package boundary to verify
across.

The vestibulum runtime adds the following factory exports to its
`index.ts` (alongside `createPreTokenGenerationHandler` and
`createPostConfirmationHandler` already in the runtime API design):

- `createPreSignupHandler` — pre-signup trigger (federation / sign-up gating)
- `createDefineAuthChallengeHandler` — `CUSTOM_AUTH` state machine
- `createCreateAuthChallengeHandler` — magic-link code issuance
- `createVerifyAuthChallengeResponseHandler` — magic-link code verification
- `createBounceHandler` — SES bounce/complaint processor
- `createAuthVerifyHandler` — Function URL `/auth-verify` (magic-link redemption)
- `createAuthSignoutHandler` — Function URL `/auth-signout`
- `createEdgeCheckAuthHandler` — Lambda@Edge JWT verification

Total: 10 Lambda handler factories exported from `@de-otio/vestibulum`.
vestibulum-cdk's bundle pipeline reads these factories at build time;
no factory is invoked at synth time
([`02-monorepo-layout.md`](02-monorepo-layout.md#bundling-vestibulum-lambda-code-into-vestibulum-cdk)).

### Docs

| From                                     | To                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| `doc/README.md`                          | merged into `doc/vestibulum-cdk/README.md`                                      |
| `doc/01-package-design.md`               | `doc/vestibulum-cdk/01-package-api.md` (adapt scope)                            |
| `doc/02-packaging-and-distribution.md`   | merged into root `doc/05-versioning-and-releases.md`                            |
| `doc/03-trigger-hooks.md`                | `doc/vestibulum-cdk/06-trigger-hooks.md`                                        |
| `doc/04-app-clients.md`                  | `doc/vestibulum-cdk/05-app-clients.md`                                          |
| `doc/05-metrics.md`                      | `doc/vestibulum-cdk/` (TBD: keep as `08-metrics.md`)                            |
| `doc/06-operational-notes.md`            | merged into root `doc/06-deployment-topology.md`                                |
| `doc/federation/README.md`               | `doc/vestibulum/README.md`                                                      |
| `doc/federation/01-architecture.md`      | merged into root `doc/03-package-relationships.md` + `doc/vestibulum/README.md` |
| `doc/federation/02-runtime-api.md`       | `doc/vestibulum/01-package-api.md`                                              |
| `doc/federation/03-oidc.md`              | `doc/vestibulum/02-oidc-flows.md`                                               |
| `doc/federation/04-saml.md`              | `doc/vestibulum/03-saml-flows.md`                                               |
| `doc/federation/05-cdk-changes.md`       | `doc/vestibulum-cdk/07-cdk-changes-from-trellis.md`                             |
| `doc/federation/06-trellis-migration.md` | merged into root `doc/08-trellis-migration.md`                                  |
| `doc/federation/07-pool-topology.md`     | `doc/vestibulum/06-pool-topology.md`                                            |

Anything not listed above (SCIM-related notes, future-slot designs) goes
into the relevant per-package sub-dir.

### Tooling

- Root `package.json` declares the workspace: `"workspaces":
["packages/*"]`.
- Root `tsconfig.json` becomes a project-references aggregator;
  per-package `tsconfig.json` files extend a shared
  `tsconfig.base.json` at root.
- ESLint config lifts to root (`.eslintrc.json` + per-package overrides
  where divergent).
- Vitest: each package has its own `vitest.config.ts`; root
  `vitest.workspace.ts` composes them (allows `npm test` at root to
  fan out). No jest config — the repo uses vitest throughout.
- CI: vestibulum's existing GitHub Actions workflow merges into a
  saas-foundation workflow that builds packages in topological order
  (`foundation` → `vestibulum` → `vestibulum-cdk`).

### Imports inside vestibulum runtime

Targeted improvements, do **not** have to land in the same PR as the
move:

- `IdpSecretsClient` delegates Secrets Manager I/O to
  `@de-otio/saas-foundation/secrets`.
- IdP managers' logging goes through
  `@de-otio/saas-foundation/logger`.
- `TenantId` type imported from `@de-otio/saas-foundation/tenant`
  (replaces the current open `string` type in
  `OidcIdpInput.tenantId`).
- Audit-event emission (currently absent) wires to
  `@de-otio/saas-foundation/audit` on IdP create / update / delete.

Until these land, vestibulum runtime keeps its in-tree implementations
of those concerns. The migration is move-then-refactor, not refactor-
then-move.

## Git history

Vestibulum's history mixes `lib/` (CDK) and `runtime/src/` (runtime) as
siblings. The clean way to split them into two top-level workspace
packages while preserving blame:

1. Two `git filter-repo` runs on a throwaway clone of `vestibulum`,
   one extracting `lib/` (rewritten to `packages/vestibulum-cdk/lib/`),
   one extracting `runtime/` (rewritten to `packages/vestibulum/`).
2. Two `git subtree add --prefix=…` invocations into the
   saas-foundation repo, one per filtered branch.

Alternative — accept history loss:

- A single "import vestibulum sources" commit that copies the files
  verbatim. Simpler, faster, but `git blame` on any moved file loses
  attribution. Defensible since vestibulum has < 6 months of history
  and one author.

Recommend the filter-repo approach unless schedule pressure makes
attribution-loss acceptable. Either way: confidentiality check before
the import, since the orphaned vestibulum repo will have an
"Archived — see saas-foundation" notice that should not reference
internal consumer names.

## Phasing

1. **Skeleton.** Root `package.json` with workspaces, `tsconfig.base.json`,
   ESLint config, empty `packages/foundation/`,
   `packages/vestibulum/`, `packages/vestibulum-cdk/` directories with
   stub `package.json` files.
2. **Subtree import.** Vestibulum source → `packages/vestibulum-cdk/`
   and `packages/vestibulum/`. History preserved per the choice above.
3. **Adapt package metadata.** Rename in `package.json`s, fix
   `tsconfig.json` references, update import paths inside the moved
   trees (only where mechanically necessary; semantic refactors come
   later).
4. **Build green.** `npm run build` at root builds all packages
   in topological order. `npm test` runs all suites. `npm run lint`
   passes.
5. **CI cutover.** Saas-foundation's workflow runs the full check.
   Vestibulum's old CI workflow is removed from its repo.
6. **Doc migration.** Move and adapt vestibulum's `doc/` per the table
   above. Cross-references updated.
7. **Archive standalone vestibulum.** `README.md` redirects to the new
   home, repo marked archived on GitHub. Don't delete — keeps tag
   history navigable and any external links alive.
8. **First foundation module.** Probably secrets (lowest dependency
   surface, highest leverage). Vestibulum's `IdpSecretsClient` becomes
   the first internal consumer.

Phases 1–5 are mechanical and can land in a single PR. Phase 6 is doc
work, can land asynchronously. Phase 7 is an admin action. Phase 8 is
real engineering and gates on the foundation design being settled.

## Risks

- **Naming.** `vestibulum` (runtime) is Cognito-shaped. If non-Cognito
  IdP backends arrive later (WorkOS, Auth0 cloud-side), the name still
  fits (the entrance hall doesn't care who built the door) but the
  package surface would need a generalisation pass. Out of scope for
  v0.x.
- **`@de-otio/vestibulum-cdk` is opinionated.** Magic-link + CloudFront
  - EU residency is one deployment shape, not the universal one.
    Keeping it a separate publishable package means consumers who want
    `foundation` for an EKS service or a Lambda API don't get dragged
    through `aws-cdk-lib`.
- **Subtree import collisions.** The filter-repo'd vestibulum branch
  may carry root files (`.eslintrc`, `tsconfig.json`) that conflict
  with the saas-foundation skeleton. Pre-import: delete those from
  the filtered branch so the merge doesn't overwrite. Captured in
  the phase-1 skeleton checklist.
- **Lost `vestibulum` (unscoped) name.** The new package is
  `@de-otio/vestibulum`; the unscoped name on npm stays unclaimed and
  may be squatted. Acceptable given all three consumers are
  controlled internally; an external user finding "vestibulum" on npm
  and seeing it's not us is a minor nuisance, not a security issue.
- **Identity-federation design docs are mid-flight.** The
  `vestibulum/doc/federation/` set is recent and unstable. Moving it
  while it's still being written is fine but means the saas-foundation
  doc folder gains in-flight content immediately, not just settled
  designs. Counter: leaving the design in the old repo means readers
  of saas-foundation can't find it. Move it.

## Open questions

- **Versioning strategy.** Independent per-package (changesets-style)
  vs. shared root version (lerna-style). Lean toward independent —
  `vestibulum-cdk`'s CDK API churn shouldn't bump `foundation`'s
  version. Decide in [`05-versioning-and-releases.md`](05-versioning-and-releases.md).
- **`vestibulum-cdk` Lambda bundling.** Today `runtime/scripts/
verify-bundles.js` enforces that the CDK package's bundled Lambda
  output matches the runtime source. After the split, this check
  becomes a cross-package CI gate. Where does the script live —
  shared `scripts/`, or duplicated per package?
- **Examples placement.** Single root `examples/` directory
  (recommended; lets one example consume multiple packages) vs.
  per-package `examples/` (mirrors current vestibulum layout).
- **Public visibility.** Vestibulum is public (Apache-2.0);
  saas-foundation is private today. Decide before the import — a
  history merge from public into private is fine; the reverse later
  is more painful.
