# 12 — Status and remaining work

Latest published versions on npm (as of 2026-05-31):

```
@de-otio/saas-foundation        0.2.5
@de-otio/vestibulum             0.2.0
@de-otio/saas-foundation-cdk    0.3.0
@de-otio/vestibulum-cdk         0.3.0
```

(`v0.2.0` of all four shipped 2026-05-27; `saas-foundation` 0.2.1–0.2.5
and the two `-cdk` 0.3.0 minors followed — see § "Done" below. The two
most recent foundation patches: `0.2.4` added the `MemorySecretStore`
test double; `0.2.5` exported the pure token-bucket core from the
rate-limit barrel.)

Tags `@de-otio/<pkg>@0.2.0` are on the remote, pointing at the
[`ci: consolidate release into a single OIDC publish workflow`](https://github.com/de-otio/saas-foundation/commit/51cb82c)
commit. npm Trusted Publishing is configured for every package
against `.github/workflows/publish.yml`, so every release after this
one is automated — push the version-PR merge, the workflow
authenticates via OIDC, publishes, tags, and creates GitHub
releases.

This doc tracks the gap between `0.2.0` and `1.0.0`.

## Done — `0.2.0` release punch-list

- Four packages compose, build (`tsc -b`), and pass typecheck across the project-reference graph.
- Test suite green (138 files, 2202 tests); lint clean; 80%+ coverage on new files; frozen-set brand checkers at 100%.
- v0.2 shared-distribution topology shipped (`SharedDistributionIdentity`, multi-tenant CloudFront + wildcard cert, multi-`aud` edge function).
- `examples/shared-distribution/` runnable CDK app committed; CI synthesises it every PR.
- Lambda bundles pinned by SHA-256 lock; `verify-bundles` runs in CI and pre-publish.
- cdk-nag snapshots pass; documented intentional violations.
- Findings from the three design-review passes integrated into source.
- Publish pipeline consolidated: single `publish.yml` (version PR + OIDC publish), no NPM_TOKEN, conditional `--provenance`.
- Per-package READMEs in place.
- `repository.url` normalised in all four `package.json` files (silences the npm publish warning).
- GitHub Actions runner pinned to Node 24 for JavaScript actions (`FORCE_JAVASCRIPT_ACTIONS_TO_NODE24`).

## Remaining work toward `1.0.0`

### 1. Trellis migration — ✅ COMPLETE (2026-05-30)

The plan was in
[`08-trellis-migration.md`](08-trellis-migration.md); the per-phase
completion ledger (with commit hashes) is
[`plans/trellis-migration/REMAINING.md`](../plans/trellis-migration/REMAINING.md).
All three streams landed:

- **Stream 1** — ~12 generic modules extracted from `trellis/apps/api/src/lib/`
  into `@de-otio/saas-foundation` (phases 1.A → 1.D), each published as a
  minor; trellis cut over at `0.2.x`.
- **Stream 2** — trellis's in-house reimplementations retired: router → Hono
  (all 64 route files; legacy router deleted), circuit-breaker → cockatiel
  (wired live), `id-generator` deleted (was dead — no ulid adopted),
  helmet + `@hono/zod-openapi` adopted.
- **Stream 3** — domain code switched imports as 1 and 2 landed.

A handful of trigger-based follow-ups are carried in
[`plans/trellis-migration/follow-ups.md`](../plans/trellis-migration/follow-ups.md)
(rate-limiter consolidation, `MultiAuditStore`, full zod-openapi) — each
deferred until a concrete need arises. The two deploy prerequisites (a
DynamoDB rate-limit table; runtime secret ARNs) are AWS-write items for
the consuming environment, not code changes.

### 1b. Multi-tenant data isolation (the current live workstream)

Scoped and largely de-risked in [`14-multi-tenancy/`](14-multi-tenancy/)
(the [`deep-dive/`](14-multi-tenancy/deep-dive/) is the source of truth:
pool model + PostgreSQL **Row-Level Security** as the DB-enforced boundary).
Status against `deep-dive/06-implementation-plan.md`:

- **P0 — RLS spike** ✅ proven on real RDS PostgreSQL 16.9 (7/7 checks).
- **P1 — schema readiness** ✅ every tenant-owned table carries non-null
  `tenant_id` (landed in trellis; direct schema replacement, no migration
  since trellis is not yet live).
- **P3 — `withTenantTx` wrapper** ✅ built in trellis (sets the
  transaction-local `app.current_tenant` GUC); **not yet wired into request
  paths** — activation lands with P4.
- **P2 — DB roles** (a non-`BYPASSRLS` `app_rw` + separate migrator role) —
  TODO, infra-repo change.
- **P4 — enable RLS** table-by-table — TODO, needs a database.
- **P5 — cross-tenant leak suite** vs real Postgres — TODO, needs a database.

Path to `1.0.0` is gated on the multi-tenancy boundary (P2 → P4 → P5)
reaching a stable state and at least one consuming release cycle exercising
the full dependency graph.

### 1c. Pre-public confidentiality scrub — ⚠️ REQUIRED before going public

This repo (and `trellis`) will be made public. A confidential consumer
brand name was scrubbed from the **working tree** in this pass — docs and
the three foundation-cdk source/test files now use `trellis` /
`example.com`, verified by a repo-wide marker grep.
**Still outstanding before flipping either repo public:**

- **git history rewrite for `saas-foundation`** — the brand was committed
  in earlier doc/source history; a working-tree scrub does not remove it
  from history. Run a `git-filter-repo` pass (+ force-push + downstream
  re-clone) on the brand before the repo is made public. Requires explicit
  per-invocation confirmation; the orphan-commit message after the rewrite
  must be neutral.
- **`trellis`-side scrub** — `trellis` keeps its own repo name, but it
  still references the same brand internally (e.g. the brand domain in the
  Prisma schema / ActivityPub URIs, and code comments). Apply the same
  working-tree-scrub + history-rewrite discipline to `trellis` before it
  goes public.

### 2. `AdminLinkProviderForUser` empirical verification (second-review N3)

Requires deploying a real Cognito user pool with an immutable custom
attribute, attempting `AdminLinkProviderForUser`, and observing the
error response. Cannot be done in this codebase.

The `FederationCustomAttributesAspect` already takes an
`immutableAttributeSeverity` prop (default `'error'`, documented
fallback `'warning'`). If the empirical claim turns out not to hold,
consumers can downgrade severity without a code change.

This does **not** block `1.0.0`.

### 3. Trellis-side foundation-cdk adoption

Three PRs per
[`09-foundation-cdk-package.md § Migration path`](09-foundation-cdk-package.md),
on trellis's release schedule. Out of scope for this repo's roadmap —
tracked for completeness because the constructs were promoted with
trellis's adoption in mind.

### 4. Pre-release `next` dist-tag wiring (deferred)

`publish.yml` has no `workflow_dispatch` trigger for an RC publish
today. Add one only if/when the first high-risk change actually wants
RC validation; see
[`05-versioning-and-releases.md § Pre-release`](05-versioning-and-releases.md#pre-release--next-dist-tag).

### 5. Cost-pillar follow-ups — DONE (shipped in `-cdk` 0.3.0, 2026-05-29)

From [`doc/review/2026-05-29-cost-pillar-review.md`](review/2026-05-29-cost-pillar-review.md).
0 BLOCKERs; all SIGNIFICANT and NIT findings integrated across
`@de-otio/saas-foundation-cdk@0.3.0` and `@de-otio/vestibulum-cdk@0.3.0`:

- **S1** — `HouseTaggingAspect` (`{ environment, service, costCenter,
  owner }`) with synth-time validation. ✓
- **S2** — Per-tenant cost-attribution doc
  ([`doc/vestibulum/shared-distribution/cost-attribution.md`](vestibulum/shared-distribution/cost-attribution.md)). ✓
- **S3** — `SingleTable` PITR window default 35 → 7 days; >14d synth
  annotation. ✓
- **S4** — Default S3 lifecycle (abort-multipart 7d, Standard → IA 30d,
  noncurrent-version expiry 90d) on auth-site + shared-distribution
  buckets; `lifecycle` override prop. ✓
- **S5 / S6 / S8** — Recurring-cost docs (Lambda / table / queue /
  dashboards); `NodejsLambda` `logClass: 'standard' |
  'infrequent-access'`; on-demand → provisioned crossover guidance. ✓
- **S7** — `costDosGuard` prop on `MagicLinkIdentity` /
  `SharedDistributionIdentity`: SES send-rate alarm + optional
  self-defence handler (flips Cognito sign-up gating). ✓
- **N1–N7 + RETAIN footnote** — Budgets/CAD cookbook section,
  Lambda@Edge tag caveat, Lambda memory + Power-Tuner and X-Ray
  disclosures, reserved-concurrency callouts, `tenantId` metric
  dimension, [`cost-pillar-checkup.md`](review/cost-pillar-checkup.md)
  template, ephemeral-env RETAIN watch-out. ✓

The recurring checkup template (N7) carries the *Optimize over time*
discipline forward quarterly.

## Optional, deferred

- **Possible v0.x foundation graduates** identified during the
  trellis migration but not promoted at `0.2.0`:
  `foundation/health/` (`/healthz` helpers) and
  `foundation/metrics/` (CloudWatch publish helpers). Promote in a
  follow-up review once a second consumer exists to validate the
  shape.
- **Sweep of per-doc "Open questions"** — most are
  "decide during implementation" choices now made implicitly. Worth a
  resolve-or-punt pass before `1.0.0`.

## What's _not_ on this list

- Performance / load testing — none planned pre-`1.0.0`.
- Compatibility shims for pre-`0.2.0` consumers — none exist yet, so
  none needed.
