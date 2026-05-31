# 05 — Versioning and releases

## TL;DR

Independent per-package versioning via [changesets](https://github.com/changesets/changesets).
A single workflow (`.github/workflows/publish.yml`) both opens the
"Version Packages" PR and, on its merge, runs `changeset publish` via
npm Trusted Publishing (OIDC). Publishing creates four scoped git tags
in the changesets default `<package-name>@<version>` form —
`@de-otio/saas-foundation@<x.y.z>`, `@de-otio/vestibulum@<x.y.z>`,
`@de-otio/saas-foundation-cdk@<x.y.z>`,
`@de-otio/vestibulum-cdk@<x.y.z>` — plus the matching GitHub releases.
Pre-1.0 semver convention: `0.MINOR.PATCH`
where MINOR may be breaking. Changes to the frozen cross-package type
set (defined in
[`01-scope-and-philosophy.md`](01-scope-and-philosophy.md#stability-levels))
require an RFC and a coordinated bump of every package that imports
them.

## Independent vs locked versioning

Three viable models, evaluated against this repo's actual churn shape:

| Model                | What it means                               | Verdict |
| -------------------- | ------------------------------------------- | ------- |
| Locked (lerna-fixed) | All packages share one version number       | No      |
| Linked               | A named subset of packages bump together    | No      |
| Independent          | Each package versions on its own changesets | Yes     |

`vestibulum-cdk` will churn most (CDK API turnover); `vestibulum`
moderate; `foundation` least. Locked versioning forces foundation to
publish phantom-release-after-phantom-release whose only diff is the
version field, creating noise in consumer changelogs and burning the
PATCH segment for no real change. Linked has the same problem in
miniature — once you start linking, the temptation is to link
everything, and you arrive at locked-by-stealth.

Independent is correct. The cost — needing to track compatible
combinations of `(foundation@x, vestibulum@y, vestibulum-cdk@z)` — is
real but small at three packages, and the cross-package contract is
already narrow by design (the frozen set in
[`01-scope-and-philosophy.md`](01-scope-and-philosophy.md#stability-levels)).

## Cross-package compatibility

The awkward part of independent versioning at 0.x is npm's
caret-on-0.x rule: `^0.1.0` accepts `0.1.x` but **not** `0.2.0`.
Specifying foundation as `"^0.1.0"` inside vestibulum means a
breaking foundation release at 0.2.0 will not be picked up by `npm
install` until vestibulum's package.json is bumped to `"^0.2.0"`.

This is correct semver behaviour and we keep it. The discipline:

- **Inside this monorepo**, peer-dep ranges use caret on 0.x.
  Foundation breaking → vestibulum + vestibulum-cdk get coordinated
  bumps in the same changeset PR. CI enforces it (see below).
- **Foundation never publishes a frozen-type change as a PATCH.** A
  bump from `0.1.5` → `0.1.6` is by definition non-breaking. If a
  frozen-set field changes, it is at minimum a MINOR pre-1.0.
- **Vestibulum and vestibulum-cdk declare a `peerDependency` on
  foundation**, not a regular `dependency`. Consumers install
  foundation explicitly; we don't ship two copies via transitive
  trees.

Trellis's existing release checklist (CLAUDE.md, "Release Checklist")
already encodes the equivalent rule for `@de-otio/trellis` ↔
`@de-otio/trellis-extension-api`. Same shape, three packages
instead of two.

## Semver policy

### Pre-1.0

`0.MINOR.PATCH`, where MINOR is the breaking-change segment. This
matches the convention vestibulum's existing `v0.1.0` set and
trellis already use.

What counts as a breaking change (→ MINOR bump):

- Removed or renamed package export.
- Function signature change (added required parameter, changed
  parameter type, changed return type).
- Type-shape change in any frozen-set type
  ([`01-scope-and-philosophy.md`](01-scope-and-philosophy.md#stability-levels)).
- CDK construct prop renamed or made required.
- CDK construct default value change that alters deployed
  resources.
- Behavioural change that an existing consumer's tests would catch
  (e.g., session crypto switching cipher, audit event field
  renamed in the persisted shape).

What is **not** breaking (→ PATCH):

- New package export.
- New optional field on an interface.
- New CDK construct prop that defaults to current behaviour.
- Internal refactor with identical public surface.
- Performance fix, bug fix, type-narrowing improvement.

### Post-1.0

Standard semver. MAJOR for breaking, MINOR for additive, PATCH for
fixes. Path to 1.0 is gated on the three planned vestibulum
consumers and trellis having integrated and exercised each
package's surface (see
[`07-vestibulum-migration.md`](07-vestibulum-migration.md) and
[`08-trellis-migration.md`](08-trellis-migration.md)).

## Tooling: changesets

Why changesets and not lerna / nx / manual `npm version`:

- Per-package versioning is first-class, not bolted on.
- The contributor is forced to write a _changelog line_ at PR time
  ("changeset file"), so the CHANGELOG is real authorial intent,
  not auto-generated commit-message noise.
- Aggregates pending changesets into a single "version PR" that
  bumps all packages and updates all CHANGELOGs at once — easy to
  review.
- Native GitHub Action support; `changesets/action@v1` drives both
  the version PR and the OIDC publish from one workflow.

### Workflow

1. Author makes a change. Runs `npx changeset`. Picks affected
   packages, semver level, writes a one-line summary. Commits the
   resulting `.changeset/<name>.md`.
2. PR review checks the changeset description matches the actual
   change (this is the only spot where authorial intent is captured
   for the CHANGELOG).
3. PR merges to `main`. The changesets GH Action (`publish.yml`)
   notices unreleased changesets and opens (or updates) a "Version
   Packages" PR that bumps package versions, updates CHANGELOGs, and
   deletes the consumed changeset files.
4. Maintainer reviews and merges the version PR.
5. The merge re-runs `publish.yml` with no changesets present, so the
   action runs `changeset publish`: each package whose version is not
   yet on npm is published via OIDC Trusted Publishing, then tagged
   (e.g., `@de-otio/saas-foundation@0.2.0`,
   `@de-otio/vestibulum@0.2.0`) with a matching GitHub release.

There is no second workflow: versioning and publishing are the two
branches of the same `publish.yml`, selected by whether unreleased
changesets exist. This keeps OIDC publishing inside one workflow file
(npm's Trusted Publisher is bound to it) and avoids the GitHub-Actions
rule that a tag pushed by the default `GITHUB_TOKEN` does not trigger
another workflow.

### Config

Root `.changeset/config.json` declares:

- `baseBranch: "main"`
- `access: "public"` (or `"restricted"` while saas-foundation is
  private; the per-package `package.json` `publishConfig.access`
  overrides this anyway)
- `commit: false` (the Action commits the version PR)
- `linked: []` (independent versioning)
- `ignore: []` (no packages excluded from versioning)

## Tag scheme

`changeset publish` creates one tag per published package in the
changesets default `<package-name>@<version>` form. The names are
**scoped** — that is the changesets default for scoped packages, not a
stripped short form:

- `@de-otio/saas-foundation@<x.y.z>`
- `@de-otio/vestibulum@<x.y.z>`
- `@de-otio/saas-foundation-cdk@<x.y.z>`
- `@de-otio/vestibulum-cdk@<x.y.z>`

These tags (and their GitHub releases) are a side effect of
`changeset publish` in `publish.yml`; nothing is _triggered by_ them.
A tag therefore records what was published — it is not the publish
trigger. (An earlier design used a separate tag-triggered publish
workflow; it was dropped because a tag pushed by the default
`GITHUB_TOKEN` does not start another workflow run, and because it
duplicated credentials the OIDC switch was meant to remove.)

## Publish workflow

One workflow, `publish.yml`, on push to `main`. A single
`changesets/action@v1` step decides between two paths by whether
unreleased changesets exist:

- **Changesets present** → open / refresh the "Version Packages" PR
  (`version: npm run version`, which runs `changeset version` then
  `npm install --package-lock-only` so the bumped workspace versions
  stay in sync in `package-lock.json` — otherwise the next run's
  `npm ci` would fail on a lockfile mismatch). No publish.
- **No changesets** (Version PR merged) → `publish: npm run release`
  (`changeset publish`): publish every package whose version is not
  yet on npm, then tag + create GitHub releases.

The job:

1. Checks out with `fetch-depth: 0` (full history + tags so
   `changeset publish` dedupes already-released versions).
2. Uses **Node 24** (per CLAUDE.md gotcha — npm Trusted Publishing
   needs `npm >= 11.5.1`, which ships in Node 24; Node 22's npm 10
   fails with a misleading 404 after provenance signing).
3. Configures `setup-node` with `registry-url:
https://registry.npmjs.org` and **no `NODE_AUTH_TOKEN`** (per
   CLAUDE.md gotcha — setting NODE_AUTH_TOKEN silently disables
   OIDC Trusted Publishing).
4. Runs `npm ci`, `npm run build` (topological), then
   `build-bundles` + `verify-bundles` for vestibulum-cdk (its
   gitignored Lambda bundles ship in the tarball and must exist
   before `changeset publish` packs it).
5. Grants `id-token: write` so `changeset publish` authenticates via
   npm Trusted Publishing (OIDC) — no NPM_TOKEN, no manually-managed
   credentials.

The Trusted Publisher must be configured once per package on
npmjs.com, pointing at repo `de-otio/saas-foundation` + workflow
`.github/workflows/publish.yml`. For the first publish (package does
not yet exist on npm) use npm's pending / granular trusted-publisher
setup. Until that is done, `changeset publish` fails with `ENEEDAUTH`.

### `--provenance` toggle

saas-foundation is private today. A step computes repo visibility and
sets `NPM_CONFIG_PROVENANCE=true` only when the repo is public, so
`changeset publish` ships provenance on public releases and skips it
on private ones (private repos cannot mint sigstore provenance — npm
422s). If/when saas-foundation goes public, no workflow change is
needed — the next release just starts shipping provenance.

## CHANGELOG format

Per-package `CHANGELOG.md`, [Keep a Changelog](https://keepachangelog.com)
shape, generated by changesets. One file per published package; no
root `CHANGELOG.md` aggregating all four (that's what the GitHub
Releases page is for).

Hand-edits to a generated CHANGELOG are acceptable for clarifying
breaking-change migration notes, but never to rewrite history.
Removed entries reappear next time changesets reads the file.

## RFC process for frozen types

A change to any frozen-set type (`TenantId`, `TenantSubdomain`,
`ClientConfigRow`, `AuditEvent`, `RequestContext`, `SecretRef`,
`ClaimResolverInput`, `ClaimResolverOutput`, `ProvisionerInput` — see
[`01-scope-and-philosophy.md`](01-scope-and-philosophy.md#stability-levels))
follows a lightweight RFC:

1. Open `doc/rfc/NNNN-<slug>.md` with the standard shape:
   **Motivation**, **Proposed change**, **Migration**, **Open
   questions**, **Status**. (See first RFC for the template.)
2. PR the RFC alone first (no code). Iterate on the design.
3. Once accepted (single-author project: a "Accepted on
   YYYY-MM-DD" line in the Status section is sufficient; if
   external contributors arrive, replace with named approvers),
   open a follow-up PR with the code change _and_ changesets for
   every affected package.
4. The follow-up PR is the breaking-change carrier — it bumps the
   MINOR segment of foundation and any dependent package
   simultaneously.

RFC numbering: zero-padded four-digit sequence. The first RFC is
`0001-`. RFCs are never deleted, even if rejected — rejected RFCs
have `Status: rejected` and a one-line reason, which prevents the
same idea being re-proposed without engaging the prior rejection.

## CI gates

The CI pipeline enforces three rules that catch the
sharp-edges-of-independent-versioning:

1. **Changesets required.** A PR that modifies any `packages/*/src/`
   file but contains no `.changeset/*.md` fails CI. Bypass via the
   `[skip changeset]` marker in the PR title is allowed only for
   pure refactors with no observable behaviour change.
2. **Frozen-type diff requires fanout.** If a PR changes any file
   under `packages/foundation/src/types/frozen/` or
   `packages/vestibulum/src/types/frozen/`, the changeset manifest
   must touch every package that imports from there
   (`vestibulum`, `vestibulum-cdk` for foundation-owned changes;
   `vestibulum-cdk` for vestibulum-owned changes). Missing fanout
   fails CI with a pointer to this doc and the RFC process.
3. **Peer-dep range sanity.** If `packages/foundation/package.json`
   `version` is bumped MINOR, `packages/vestibulum/package.json`
   and `packages/vestibulum-cdk/package.json` peer-dep ranges must
   be widened to accept it (`^0.MINOR.0`).

Implementation: a script under `scripts/ci/` reads the diff and
fails with a specific error. Not a github-app, not a heavy
plugin — a Node script the workflow runs.

## Pre-release / `next` dist-tag

Not used for v0.x. The friction of consumers having to remember
`npm install @de-otio/vestibulum@next` is not worth it at this scale.
If a high-risk change wants validation before going to `latest`, the
release-candidate path is:

1. Create a pre-release changeset (`changeset pre enter next`), let
   the Version PR produce `0.x.0-rc.N`, and merge it. `changeset
   publish` publishes to the `next` dist-tag automatically while in
   pre mode — no `latest` movement. (`publish.yml` has no manual
   dispatch for this today; add a `workflow_dispatch` trigger if the
   RC path is ever actually exercised.)
2. Validate with at least one internal consumer.
3. `changeset pre exit` and re-publish without the `-rc` suffix once
   approved.

## Release checklist per package

Adapts trellis's existing checklist
(`/Users/rmyers/repos/dot/trellis/CLAUDE.md` § Release Checklist):

- [ ] All tests pass on the version PR.
- [ ] The version-PR diff includes the expected CHANGELOG entries
      and version bumps; no unintended packages bumped.
- [ ] If any frozen-set type changed: the accepting RFC is merged
      and linked in the version PR description.
- [ ] If foundation bumped MINOR: vestibulum and vestibulum-cdk
      peer-dep ranges accept the new version.
- [ ] `package-lock.json` is updated and matches the bumped
      versions.

After the version-PR merge, watch the publish workflow run and
confirm versions on npm with `npm view <pkg> versions --json
--registry=https://registry.npmjs.org`.

## Open questions

- **Workspace-root tags for cross-cutting milestones?** E.g., a
  `meta-v1.0.0` tag when all four packages cross 1.0 together.
  Probably no — GitHub Releases at the per-package tags carry the
  same information, and a meta-tag introduces ambiguity ("which
  package's 1.0 is this referring to?"). Decide after first major
  release.
- **Security-patch fast track for frozen types.** A CVE in a
  frozen-type-encoded field (say, an `AuditEvent` field that
  surfaces a sensitive identifier) needs a same-day patch, but the
  RFC process is multi-day. Proposed: a "security-fast-track" RFC
  shape — opened, accepted, and code-merged in one PR, with a
  retrospective documenting the urgency. Codify before it's needed,
  not during.
- **Pin Node 24 across the workspace?** `engines` field at root.
  Yes — but follow the npm OIDC gotcha. Spelled out in
  [`02-monorepo-layout.md`](02-monorepo-layout.md) when that doc
  lands.
