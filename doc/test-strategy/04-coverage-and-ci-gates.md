# 04 — Coverage and CI gates

What a number means here, what the per-package thresholds are, and the
exact sequence that gates a merge. The principle behind the numbers is P1:
coverage exists to make a future change cheap to trust, not to hit a target.

## Coverage thresholds

Provider is **v8** in every package; reporters are `text`, `json`, `html`,
`lcov`. The floor is **80%** on lines / functions / branches / statements
across all four packages, with two deliberate adjustments:

- **Frozen-set brand checkers are held to ≥95%** (lines/branches/functions/
  statements) and are *explicitly included* in coverage even though they sit
  close to the type layer. They hold the cross-package invariant (P4); 80% is
  not enough for the contract surface. Enforced by a glob-keyed threshold
  (`"**/src/types/frozen/**": { lines: 95, ... }`) in the foundation and
  vestibulum `vitest.config.ts` — a configured gate, not a comment.
- **Coverage is scoped to code that carries behaviour.** Barrels
  (`index.ts`) and `.d.ts` files are excluded everywhere. In
  `vestibulum-cdk` coverage uses an explicit `include` allow-list of the
  constructs and `_internal` helpers that hold logic (the aspects, nag
  rules, WAF, magic-link, shared-distribution modules, cost-DoS guard, S3
  lifecycle), so the percentage reflects real coverage of real logic rather
  than being diluted by generated or glue files.

A specific file may be excluded only with an inline comment justifying it
(e.g. foundation excludes `src/secrets/schemas.ts`). Adding an exclusion is
a reviewable decision, not a convenience.

### What 80% does and does not buy

80% is a floor that catches "whole module untested", not a ceiling that
proves correctness. Correctness comes from P5 (failure paths + boundaries)
and the property/abuse tests, which a coverage number cannot measure. A PR
that adds a happy-path test to clear the threshold without the failure-path
assertions is not done — that is a review-discipline gate, not an automated
one.

## Vitest execution settings (every package)

```
pool: "threads", poolOptions.threads: { maxThreads: 4, minThreads: 2 }
isolate: true
sequence: { shuffle: true, seed: 1000 }   # order-independence, reproducible
testTimeout: 5000, hookTimeout: 5000      # a hang is a failure, fast
```

`isolate: true` + shuffled order means cross-test state leakage shows up as
a deterministic failure under seed 1000, not as flake. The 5s timeouts mean
an accidental real-network or real-timer call fails fast and visibly
instead of hanging CI.

## The CI pipeline (`.github/workflows/ci.yml`)

Triggered on `pull_request` to `main`. Runs on Node 24 (from `.nvmrc`),
with `fetch-depth: 0` so the gate scripts can diff against the base branch.
Order matters and is load-bearing:

1. **`npm ci`** — clean install from the lockfile.
2. **`npm run typecheck`** (`tsc -b`) — the whole project-reference graph.
   The first verification layer; nothing else runs if types don't hold.
3. **Build Lambda bundles** (`build-bundles --workspace @de-otio/vestibulum-cdk`).
   Must run *after* typecheck (needs each package's emitted `dist/`) and
   *before* test/synth (which load bundles as CDK assets).
4. **`npm test -- --coverage --reporter=verbose`** — all four suites +
   coverage thresholds. A threshold miss fails the build.
5. **`npm run lint`** — type-aware ESLint over `lib`/`src` + `test` +
   `scripts`, run with `NODE_OPTIONS=--max-old-space-size=6144` (the
   type-aware program for the whole monorepo exceeds the default heap).
   This step also enforces the **test determinism lint rules**
   (`no-restricted-globals` on `Date`/`Math.random` inside `test/`).
6. **`verify-bundles`** — bundle SHA-256s match
   `lambda-bundles.lock.json`. Catches drift in the only runtime code
   `vestibulum-cdk` ships.
7. **Synth shared-distribution example** — `npm install` + `cdk synth` in
   `examples/shared-distribution`. The per-PR end-to-end composition check
   (Layer 9).
8. **`check-changesets`** — change carries a changeset.
9. **`check-frozen-fanout`** — frozen-type changes fan out a coordinated
   bump across affected packages (P4 backstop).
10. **`check-peerdep-ranges`** — inter-package peer ranges stay
    satisfiable.
11. **`check-unsorted-toequal`** — flags equality assertions applied
    directly to unordered iterables (P2.4 determinism backstop; conservative,
    with a `// sorted-ok` escape hatch).
12. **`check-coverage-include`** — fails if a behaviour-bearing
    `vestibulum-cdk` `lib/**` file is missing from the coverage `include`
    allow-list (guards against silently-uncovered new constructs).

## What blocks a merge

All of the above are required. Concretely, a PR cannot merge if any of:

- a type error anywhere in the reference graph;
- a failing test in any package;
- coverage below the package floor (or below the 95% glob threshold on the
  frozen brand checkers under `src/types/frozen/**`);
- a lint error, including a determinism-rule violation in a test file, or an
  unsorted-iterable equality assertion the `check-unsorted-toequal` gate flags;
- a Lambda bundle whose hash drifted from the lock file without the lock
  being updated;
- a shared-distribution example that fails to synth (incl. a `cdk-nag`
  failure);
- a missing changeset, an un-fanned-out frozen change, or an unsatisfiable
  peer-dep range;
- a new behaviour-bearing `vestibulum-cdk` construct absent from the coverage
  `include` list.

## Release gating (beyond per-PR)

Versioning is independent per-package via changesets (pre-1.0
`0.MINOR.PATCH`, MINOR may be breaking). The release path is a single
version-PR + OIDC publish workflow. The test obligations carry into the
release flow through the same gate scripts: a coordinated frozen-set change
that didn't fan out cannot have produced mergeable changesets, so it cannot
reach a release. See [`../05-versioning-and-releases.md`](../05-versioning-and-releases.md).

## Drift to watch

- **Coverage-include lists rot.** When a new construct is added to
  `vestibulum-cdk`, it must be added to the coverage `include` list or it
  is silently uncovered. Treat the include list as part of the construct's
  definition of done.
- **Snapshot churn normalisation.** If snapshot updates become routine and
  unexplained, the snapshot layer has stopped catching regressions (P2.6 /
  Layer 7). Audit periodically.
- **The 5s timeout as a crutch.** A test that needs more than 5s is almost
  certainly doing real I/O and belongs in the integration tier
  ([`05-integration-and-e2e.md`](05-integration-and-e2e.md)), not getting
  its timeout raised.
