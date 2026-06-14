# Deployment alignment — conformance with the trunk + tags standard

Goal: confirm saas-foundation is consistent with the **de-otio deploy standard**
(trunk-based, tag-gated releases) used by `trellis-web` and `skybber`. Canonical
description: [`trellis-web/doc/deployment.md`](https://github.com/de-otio/trellis-web/blob/main/doc/deployment.md).

## Finding: already conforming (different artifact type)

saas-foundation is **not an account-deployed app** — it is a published **package
library** (`foundation`, `foundation-cdk`, `vestibulum`, `vestibulum-cdk`),
released to npm via **Changesets + Trusted Publishing**. So the
`dev account → prod account` dimension does not apply here (same as the
`trellis` core repo). What *does* apply is the trunk + tag-gated-release
philosophy, and the repo already implements it:

| Standard | How saas-foundation realises it | Status |
| --- | --- | --- |
| Trunk is `main`, PRs into `main` | `ci.yml` runs on PR + push to `main` | ✅ |
| Continuous integration on trunk | gates run on every merge to `main` | ✅ |
| Tag-gated **release** (not a branch merge) | Changesets `changeset tag` cuts version tags + GitHub releases on publish | ✅ |
| Human approval before "prod" | merging the **"Version Packages" PR** is the release gate; publish to npm is "prod" | ✅ |
| Build/publish from an immutable ref | publish runs from the merged `main` commit; tags are immutable | ✅ |
| Rollback | npm version pinning / deprecate-and-rerelease (registry semantics) | ✅ |

**Conclusion: no migration needed for the package-release flow.** The mapping
above is the consistency — it's just realised as *publish a release* rather than
*deploy to an account*.

## Consistency notes (read-alongside the other repos)

- **Tag shape differs by design.** Deploy repos cut a single `v*` tag to trigger
  a prod deploy. Changesets here cuts **per-package** tags
  (`@de-otio/<pkg>@x.y.z`) plus GitHub releases. Both are "the immutable
  release marker for the standard" — don't try to force a single `v*` tag onto a
  multi-package repo.
- **The release gate is the Version PR.** Where deploy repos gate prod behind the
  `production` GitHub Environment's required reviewer, here the equivalent human
  checkpoint is **merging the Version Packages PR**. Treat it with the same care.

## If a deployed reference app is ever added

`examples/shared-distribution` is an *example* (consumer-side), not a deployed
environment. If saas-foundation later ships an actually-deployed reference app,
make it consistent with the deploy repos:

1. **Merge to `main` → deploy the app to the dev account** (continuous), via a
   `deploy-dev.yml` mirroring `trellis-web`.
2. **Release → deploy to the prod account** behind a `production` Environment
   approval.
3. **Reconcile the trigger with Changesets.** Per-package tags won't cleanly
   drive an app deploy — instead trigger the prod app-deploy on the
   **GitHub Release `published` event** (filtered to the app package), or cut a
   dedicated `app-v*` tag. Do **not** repurpose the package tags.

## Action

Document-only: this note records the mapping. No workflow changes are required
today. Revisit only if a deployed app is added (section above).
