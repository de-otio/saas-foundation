# 10 — AI-maintained conventions

This repo is intended to be built and maintained primarily by AI
agents under human review. The architectural choices everywhere else
in `doc/` already align with most of what AI-maintained code needs.
This doc collects the _specific_ conventions that exist because the
maintainer is an agent — choices that would still be defensible for a
human-only team but that earn their cost faster when the rate of
change is high.

## Why this doc exists

The framing comes from
[dot-notes/topics/ai-and-software-development/.../verification-as-bottleneck/06-architectural-leverage/](../../dot-notes/doc/topics/ai-and-software-development/ai-software-patterns/verification-as-bottleneck/06-architectural-leverage/).
The short version: when an agent generates a change, the human review
_is_ the verification step. Architectural choices that reduce
per-review verification cost compound across the project's lifetime;
choices that don't, tax every review.

A typed pure function in a small isolated module pays its return on
every regeneration, every refactor, every review. A monolithic
untyped stateful blob taxes the reviewer on every one of those events.
The differential grows linearly with the rate of change, and AI
generation makes the rate much higher.

## Conventions

### 1. Immutability is the default

`readonly` on every interface field unless a mutation reason is
documented. `Readonly<>` on every `Record<>` returned across a module
boundary. `ReadonlyArray<>` on every array exposed publicly. The
frozen-set ([`04-shared-vocabulary.md`](04-shared-vocabulary.md))
already requires this; the rule extends to _every_ cross-module type,
not just frozen ones.

The reviewer-cost rationale: a reviewer who knows a value is
immutable does not have to trace "who else might mutate this?" That
question is the most common source of "looks fine in review, breaks
in production" bugs. Making the answer always "nobody" by type
declaration removes the entire investigation.

The cost is small in TypeScript — one keyword per field. The first
review pass already caught one frozen-set drift between plain
`Record` and `Readonly<Record>` on `ClaimResolverInput`; making
`Readonly` the default rather than the exception prevents the class.

### 2. Pure functions where the domain allows it

Module-internal logic should be pure where possible. The naturally
stateful concerns — AWS SDK calls, AsyncLocalStorage, audit-log
persistence, session-crypto random reads, IdP HTTP probes — are
explicit and isolated; everything else should be a pure transformation
that takes inputs and returns outputs.

Practical heuristic: if a function is **not** doing one of {AWS SDK
call, ALS read/write, crypto random, network I/O, file I/O,
time-source read}, it should be pure. If it has to be impure for
another reason (e.g., for an in-package optimisation), the reason
goes in a comment. The reviewer does not have to ask "why is this
mutating state?" — the answer is always documented.

### 3. Determinism in tests

AI-generated tests are subtly less robust than hand-written ones:
they tend to depend on incidental properties (specific timestamps,
sort orders, iteration sequences) that hold under the conditions the
agent imagined but not in real CI. Foundation explicitly bans:

- **Time-of-day assertions.** Use a frozen clock. The
  `vi.useFakeTimers()` pattern, or an injected `clock: () => Date`
  callback for code that takes a time parameter.
- **Sort-order-dependent assertions** on iteration of `Object.keys`,
  `Map.entries()`, or unsorted DB queries. Sort explicitly before
  asserting, or use set-equality matchers.
- **Real network/filesystem.** Mock at the SDK or fetch boundary.
  Tests that touch the real network or filesystem belong in a
  separate `integration/` suite that does not run on every PR.
- **`Math.random()` and `crypto.randomBytes()` without seed
  injection.** Code paths that consume randomness must accept a
  `Random` parameter (defaulting to the real one in production) so
  tests can pin the seed.

These rules apply uniformly across [foundation](foundation/) (unit
tests), [vestibulum](vestibulum/) (unit + AWS-mock tests), and
[foundation-cdk](foundation-cdk/) / [vestibulum-cdk](vestibulum-cdk/)
(CDK synth snapshot tests). Snapshot tests in particular need
**frozen stack inputs**: pin the stack name, the account, the
region, and any prop that affects logical-ID derivation. Otherwise a
snapshot diff is indistinguishable from a real regression.

### 4. Property-based testing for brand checkers and validators

The frozen-set brand checkers (`isTenantId`, `isSecretRef`,
`isAuditEvent`), the Zod boundary validators, and any other "string
satisfies regex / structural predicate" check should have
property-based tests using `fast-check` or equivalent. Generate
1000 random valid and invalid inputs and assert the invariants;
catches the edge case the agent (or the human) didn't think to write.

This is the highest-leverage testing pattern for frozen-set code
because the cost of a brand-checker bug is high (it ripples through
every consumer that imported the type) and the cost of property tests
is low (one test file, one generator per type). Foundation v0.1
should ship property tests for every frozen-type brand checker.

### 5. Module size as a verification budget

A reviewer can verify a small module by inspection; a large module
requires building a mental model. The threshold is fuzzy, but a
working heuristic: **if a single module's design doc is over ~15 KB
or the implementation is over ~500 LOC, decomposition deserves
explicit justification.** The justification can be "this is the
natural unit" — but it must be stated, not assumed.

Audit log ([foundation/06-audit-log.md](foundation/06-audit-log.md))
and tenant-context ([foundation/05-tenant-context.md](foundation/05-tenant-context.md))
are above the threshold and have the justification (both are
multi-concern modules whose pieces couple tightly). New modules that
end up that size during implementation should re-justify or split.

### 6. PR-size and batch policy

The reviewer's attention budget is scarce. PRs that are too large to
review carefully don't get reviewed carefully. Foundation's
convention:

- **Substantive PRs ≤ 400 LOC of meaningful diff** (excluding
  generated files, lockfile changes, and mechanical refactors that
  are documented as such).
- **Mechanical refactors that exceed the limit** (e.g., the trellis
  migration's per-phase cutover, which moves dozens of files) **must
  be split or annotated**. If a refactor is genuinely atomic and
  exceeds the limit, the PR description states why and what the
  reviewer should _not_ spend time on.
- **One concern per PR.** A PR that adds a feature and refactors an
  adjacent module is two PRs.
- **Dependency bumps, generated-doc updates, and CHANGELOG entries
  go in dedicated PRs** — they crowd out attention from substantive
  changes when bundled.

The full operational version lives in [`../CONTRIBUTING.md`](../CONTRIBUTING.md).

### 7. Specs are evals, not prose

This design proceeds spec-first: 40+ design notes were written before
any code. The conventions for keeping that work load-bearing as
implementation lands:

- **Every module's design doc states its public API as TypeScript
  signatures**, not English prose. The signatures are the executable
  contract; the prose around them explains _why_, not _what_.
- **Every module ships a property-based test file** (per § 4 above)
  asserting the invariants the design doc claims. The test file is
  the eval — if it passes, the module satisfies the spec.
- **Design changes precede code changes.** If the implementation
  diverges from the design doc, the design doc is updated first,
  reviewed, then the code follows. A code PR that silently changes
  a spec invariant is rejected.

For the frozen-set types this is already enforced via the CI fanout
gate ([`05-versioning-and-releases.md § Frozen-type fanout`](05-versioning-and-releases.md));
the same posture extends informally to every module.

## What this is not

- **Not a ban on impure code.** AWS SDK calls, ALS reads, network
  I/O are impure by nature. The rule is "explicit and isolated," not
  "absent."
- **Not a requirement that every module be tiny.** § 5 is a budget
  with explicit-justification overflow, not a hard cap.
- **Not a workflow rulebook.** Workflow lives in
  [`../CONTRIBUTING.md`](../CONTRIBUTING.md); this doc is the
  _architectural_ counterpart.
- **Not specific to one AI model or one agent.** The conventions are
  about what makes code cheap to review; the maintainer's identity
  doesn't change the rules.

## Status

Convention doc, in force across the repo. The design docs and code
align with most of the conventions; any drift surfaces in code review
against this doc as the touchstone.
