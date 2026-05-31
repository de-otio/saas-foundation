# 07 — Implementation plan

A plan to bring the tree into full conformance with the test strategy
documented in this folder. It mirrors the phased / acceptance-criteria
format of [`../11-implementation-plan.md`](../11-implementation-plan.md).

## Framing: this is a conformance plan, not a green-field build

Most of the strategy already describes reality. ~150 vitest files run on
every PR; the ten layers ([`02-test-layers.md`](02-test-layers.md)) are
populated 1–9; the determinism `no-restricted-globals` ESLint rule for
`Date`/`Math.random` in tests exists; the CI pipeline and the
frozen-fanout gate are live; the security/abuse files in
[`06-security-and-abuse-testing.md`](06-security-and-abuse-testing.md) all
exist on disk.

So "implement the strategy" means three things, in priority order:

1. **Give the documented gates teeth.** Several controls the strategy
   states as *enforced* are currently enforced only by a code comment or
   by review discipline. Make them mechanical (Phases 0–1).
2. **Verify the existing tests are adequate, not just present.** A
   security test file existing does not prove it asserts the adversarial
   case. Audit the catalogue against the strategy's claims and fix the
   gaps (Phase 2).
3. **Stage the deferred tier.** Scaffold the integration config separation
   now (cheap, unblocks the future) and build the LocalStack scenarios
   only when the documented trigger fires (Phases 3–4).

## Gap register

The delta between strategy-as-written and tree-as-built. Severity is the
cost of leaving it unclosed.

**Status (implemented 2026-05-31):** G1–G4 and G6 are **closed**; G5 is
accepted as an explicit review-only control; G7 remains deferred behind its
[`05`](05-integration-and-e2e.md) trigger. Details under each phase below.

| # | Strategy claim | Original state | Gap | Sev | Status |
|---|---|---|---|---|---|
| G1 | Frozen-set brand checkers held to ≥95% coverage ([`04`](04-coverage-and-ci-gates.md), [`01` P4](01-principles.md)) | Global 80% threshold; 95% was a **comment** in the vitest configs, not a configured per-glob gate | A frozen checker could regress to 80% and CI stay green | **High** | ✅ Closed — glob threshold `"**/src/types/frozen/**": {95...}` in both configs; binding proven empirically |
| G2 | "A CI lint rejects `.toEqual([...unsorted...])` on iterable output" ([`02`](../02-monorepo-layout.md#determinism-rules), [`01` P2.4](01-principles.md)) | **No such lint existed** (`no-restricted-globals` for Date/Math.random did) | Order-dependent assertions slip through; rule partly aspirational | **Med** | ✅ Closed — `scripts/ci/check-unsorted-toequal.ts` (conservative + `// sorted-ok`); docs corrected; wired into CI |
| G3 | The `scripts/` gates are "themselves unit-testable" ([`03`](03-per-package.md#scripts)) | Only `check-frozen-fanout.test.ts` existed | `check-changesets` and `check-peerdep-ranges` were untested release-blockers | **Med** | ✅ Closed — both refactored to pure cores + tested (10 + 14 cases) |
| G4 | "Treat the [vestibulum-cdk coverage] include list as part of the construct's definition of done" ([`04`](04-coverage-and-ci-gates.md#drift-to-watch)) | Manual; nothing flagged a new `lib/**` construct missing from `include` | A new construct ships silently uncovered while CI shows 80%+ | **Med** | ✅ Closed — `scripts/ci/check-coverage-include.ts` + CI step. **Found a real gap on first run: 10 behaviour-bearing files added to `include`, 2 interface-only files moved to `exclude`** |
| G5 | Snapshot updates must be explained; unexplained churn = unreviewed change ([`02` L7](02-test-layers.md), [`04`](04-coverage-and-ci-gates.md)) | Review-only convention | Relies on reviewer diligence; no signal | **Low** | ⚪ Accepted as review-only — docs say "review discipline", not "enforced" |
| G6 | Security/abuse catalogue pins each threat ([`06`](06-security-and-abuse-testing.md)) | Files existed; **adequacy of assertions unverified** | A test may exercise the path without asserting the rejection (tautology risk) | **High** | ✅ Closed — adversarial audit of all 9 threats; ~52 assertions added; **2 zero-test security surfaces found & covered** (single-tenant edge `check-auth`, magic-link rate limiter); **no real vulns** |
| G7 | Integration tier in a separate `integration/` config; LocalStack + deployed stack ([`05`](05-integration-and-e2e.md)) | Absent by design | Real mock-vs-reality drift is uncaught; deferred but unscaffolded | **Med (deferred)** | ⏸ Deferred — Phases 3–4, unchanged; build when the [`05`](05-integration-and-e2e.md) trigger fires |

## Phases

Effort is rough wall-clock for one agent. Phases 0–2 are the actual work;
3–4 are staged behind the [`05`](05-integration-and-e2e.md) trigger
conditions and listed for completeness.

### Phase 0 — Make the documented gates mechanical (~2–3h)

Closes G1, G2, G4. No new product tests; this is enforcement
infrastructure, so a regression in any control fails CI instead of passing
silently.

| Task | Model | Acceptance |
|---|---|---|
| Add per-glob coverage thresholds for the frozen checkers in `foundation` and `vestibulum` `vitest.config.ts` (`thresholds['src/types/frozen/**'] = { lines: 95, branches: 95, functions: 95, statements: 95 }`; foundation also `test/frozen/**` targets if measured there) | **Sonnet** | Dropping a frozen brand checker's coverage below 95% fails `npm test -- --coverage`; the 80% global floor still applies elsewhere. The strategy's "≥95%" is now a gate, not a comment. |
| Implement the unsorted-`toEqual` check as `scripts/ci/check-unsorted-toequal.ts` (AST or lint rule: flag `.toEqual([...])` / `.toStrictEqual([...])` on values derived from `Object.keys`, `Map`/`Set` iteration, or un-`.sort()`ed query output) and wire it into CI; **or**, if a robust check proves infeasible, downgrade the claim in [`02`](../02-monorepo-layout.md#determinism-rules) + [`01` P2.4](01-principles.md) to "review discipline" so the docs stop overstating | **Sonnet** | Either a hand-crafted unsorted-`toEqual` fixture fails CI, or the two docs no longer assert an enforcement that doesn't exist. No silent overstatement remains. |
| Add `scripts/ci/check-coverage-include.ts` for `vestibulum-cdk`: diff `lib/**/*.ts` (minus barrels/`_internal` excludes) against the coverage `include` list; fail if a behaviour-bearing construct is absent | **Sonnet** | Adding a new `lib/foo/foo.ts` construct without listing it fails CI with a message naming the file. Closes the include-list rot risk (G4). |

### Phase 1 — Test the testers (~1–2h)

Closes G3. The gate scripts block releases; they must be tested with the
same injectable-diff seam `check-frozen-fanout.test.ts` already uses.

| Task | Model | Acceptance |
|---|---|---|
| Refactor `check-changesets.ts` if needed so the changed-file set and PR title are injected (not read live from `git`), then add `check-changesets.test.ts` | **Sonnet** | Gate fires when a non-trivial diff lacks a changeset; passes for a docs-only or changeset-present diff; covers the PR-title-derived exemptions. ≥80% on the script. |
| Same for `check-peerdep-ranges.ts` → `check-peerdep-ranges.test.ts` | **Sonnet** | Gate fires on an unsatisfiable inter-package peer range (e.g. `vestibulum` peer on `foundation` `^0.2.0` while `foundation` bumps to `0.3.0` without a coordinated change); passes on a satisfiable set. |
| Add `scripts/ci/check-coverage-include.test.ts` (from Phase 0) | **Sonnet** | Both the present and absent cases asserted on a fixture `lib` listing. |

### Phase 2 — Audit existing tests against the strategy (~3–4h)

Closes G6 and verifies P5 (failure-path/boundary) conformance. This is the
highest-value phase: the files exist, so the risk is *tautological or
incomplete* assertions, which coverage cannot detect. Run an adversarial
review (the `test-critic` agent is built for this), then fix findings.

| Task | Model | Acceptance |
|---|---|---|
| `test-critic` pass over the security/abuse catalogue ([`06`](06-security-and-abuse-testing.md)): `private-ip` / `oidc-probe`, `multi-pool-verifier`, `verify-jwt`, SAML (`saml-metadata`, `saml-manager`, `sp-metadata`), edge `check-auth`, `session/*`, `iam-shape`, `redact`/`pii-filter`, `extract-tenant-subdomain` | **Opus** | A findings list: for each threat in [`06`](06-security-and-abuse-testing.md), the specific test asserting the *rejection* (by typed error, not message), or a gap ticket. Tautologies and over-mocking flagged. |
| Fix the findings: add the missing adversarial assertions (e.g. metadata-IP + v6 link-local + redirect-to-internal for SSRF; cross-pool + expired + wrong-`aud` for JWT; signature-wrapping for SAML; single-bit-flip rejection for the sealed cookie) | **Opus** | Every threat→defence row in [`06`](06-security-and-abuse-testing.md) maps to a named test that fails if the defence is removed (mutation-style spot check on 2–3 of them). |
| Spot-audit non-security modules for P5 boundary/failure coverage (rate-limit window off-by-one, retention TTL edge, residency cutover, retry exhaustion) | **Sonnet** | Sampled modules show boundary + failure-path assertions, not happy-path only; gaps filed or filled. |

### Phase 3 — Integration tier scaffolding (deferred; build when [`05`](05-integration-and-e2e.md) trigger fires)

Closes the cheap half of G7. The config separation costs little and
unblocks future work without running anything slow on PRs.

| Task | Model | Acceptance |
|---|---|---|
| Add a separate `vitest.integration.config.ts` (or `integration/` dir excluded from the default `include`) per package that needs it; not wired to the PR job; runnable via an explicit `npm run test:integration` | **Sonnet** | `npm test` (PR path) still excludes it; `test:integration` runs it; inherits all determinism rules except no-network. |
| Implement LocalStack scenarios 4–5 ([`05`](05-integration-and-e2e.md)): DynamoDB conditional-write contention (rate-limiter, reservations/client-config tables) and audit multi-store TTL/retention | **Opus** | Both scenarios pass against LocalStack; documented as scheduled/nightly, not per-PR. |

### Phase 4 — Deployed-stack tier (deferred; only after Phase 3 + trigger)

Closes the rest of G7. Out of scope until the magic-link/edge code is
changing often enough that synth-only confidence is the bottleneck.

| Task | Model | Acceptance |
|---|---|---|
| Scenarios 1–3, 6, 7 ([`05`](05-integration-and-e2e.md)) against the `examples/shared-distribution` stack in a disposable `dev` account | **Opus** | Full magic-link round-trip, real edge admit/deny, live-JWKS multi-pool rejection, SES bounce, real-redirector SSRF refusal — each green; stack torn down after the run. |

## Sequencing and ownership

```
Phase 0 ─┐
Phase 1 ─┼─ independent, parallelizable (3 agents)   ← do now
Phase 2 ─┘   (Phase 2 depends on nothing but is the longest)
                     │
                     ▼   trigger fires (see 05-integration-and-e2e.md)
Phase 3 ──────────────────► Phase 4
```

Phases 0, 1, 2 have no ordering dependency on each other and can run as
three parallel agents. Phase 3 waits on the documented trigger; Phase 4
waits on Phase 3.

## Definition of done for this plan

- **G1–G4 closed:** the frozen-95%, unsorted-`toEqual` (or doc
  correction), gate-script tests, and include-list guard are all
  mechanical and demonstrably fail on a crafted violation.
- **G6 closed:** every threat in [`06`](06-security-and-abuse-testing.md)
  maps to a test that fails when its defence is removed.
- **Docs and tree agree:** no control in this folder or in
  [`../02-monorepo-layout.md`](../02-monorepo-layout.md) is described as
  "enforced" while being comment-only or review-only. Where a control is
  intentionally manual (G5 snapshot discipline), the docs say "review
  discipline", not "enforced".
- **G7 staged, not silently skipped:** the integration config exists and
  is documented as deferred with its trigger; its absence from the PR job
  is a stated decision, per the no-silent-caps principle.

## Explicitly out of scope

- Performance / load testing — unchanged from
  [`../12-remaining-work.md`](../12-remaining-work.md); no SLO to test
  against yet.
- Migrating off vitest, changing the coverage provider, or adding a new
  test framework. The stack is settled.
- Mutation testing as a standing gate — the Phase 2 mutation *spot checks*
  are a one-time adequacy probe, not a new CI tool.
