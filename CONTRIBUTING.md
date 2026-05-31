# Contributing

This repo is built and maintained primarily by AI agents under human
review. The conventions here exist because the human review *is* the
verification step — choices that reduce per-review cost compound
across every change. The architectural counterparts are in
[`doc/10-ai-maintained-conventions.md`](doc/10-ai-maintained-conventions.md);
this file covers the operational rules.

## Workflow

### Specs precede code

Every non-trivial change starts in `doc/`. The spec is the design
note for the module being changed; the spec PR is reviewed for
intent. Only after the spec PR merges (or alongside it as a single
unit, for tightly-coupled spec-and-code changes) does the
implementation PR open.

If the implementation needs to diverge from the spec, **the spec
changes first**. A code PR that silently changes a spec invariant is
rejected on review.

### One concern per PR

A PR that adds a feature and refactors an adjacent module is two
PRs. Reviewers tracing the scope of a single change have a hard
enough job without orthogonal work folded in.

Dependency bumps, generated-doc updates, lint-fix sweeps, and
CHANGELOG entries go in dedicated PRs. They crowd out reviewer
attention from substantive changes when bundled.

### PR size limits

| PR shape                          | Soft limit (LOC of meaningful diff) |
|-----------------------------------|-------------------------------------|
| Substantive feature / behaviour PR| 400                                 |
| Mechanical refactor (annotated)   | 1000 (with explicit justification)  |
| Generated / lockfile updates      | unbounded but separate              |

"Meaningful diff" excludes lockfile churn, mass-renames documented
as such, and auto-generated files (Prisma client output, lambda
bundles). The reviewer's first action is to scan the PR description
for the annotation that explains what *not* to read line-by-line.

PRs that exceed the limit without annotation get a "split this"
request. Splitting is the submitter's job, not the reviewer's.

### Commit messages

Every commit message follows the
[Conventional Commits](https://www.conventionalcommits.org/) shape
recognised by the changesets tooling:

```
type(scope): short summary

Longer body if needed: what changed and why, not how. The diff
shows how.
```

Types in use: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`,
`build`, `ci`, `revert`. Scopes match package directories
(`foundation`, `vestibulum`, `foundation-cdk`, `vestibulum-cdk`) or
`docs`/`repo` for cross-cutting changes.

### Changesets

Every PR that affects a published package's behaviour or API ships
a changeset (`npm run changeset`). The
[CI changeset gate](doc/05-versioning-and-releases.md#ci-gates)
enforces this. PRs that change only docs, tests, or non-published
files do not need a changeset.

## Code style

### Required by tooling

- Prettier formatting (`npm run format` before push, or rely on
  editor integration).
- ESLint clean (`npm run lint`). No warnings.
- TypeScript strict (`npm run typecheck`). No `// @ts-ignore` or
  `// @ts-expect-error` without a comment explaining why.

### Required by review

- `readonly` on every public interface field.
- `Readonly<>` on every public `Record<>`.
- `ReadonlyArray<>` on every public array.
- Pure functions outside the explicit impure boundaries (AWS SDK,
  ALS, crypto random, network/fs I/O, time-source). See
  [`doc/10-ai-maintained-conventions.md`](doc/10-ai-maintained-conventions.md).
- Property-based tests for brand checkers and validators (see
  [`doc/04-shared-vocabulary.md § Property-based brand checkers`](doc/04-shared-vocabulary.md#property-based-brand-checkers)).
- Deterministic tests (see [`doc/02-monorepo-layout.md § Determinism rules`](doc/02-monorepo-layout.md#determinism-rules)).
  No real network, no real filesystem, no real clock, no unseeded
  randomness in unit tests.

## Review

### What the reviewer is looking for

1. **Intent matches the spec.** Diff vs. the design doc for the
   module touched. A diff that diverges from the design doc without
   a corresponding doc change is rejected.
2. **Public API stability.** Cross-package types (`TenantId`,
   `AuditEvent`, `SecretRef`, etc.) require an RFC and the
   coordinated bump described in
   [`doc/05-versioning-and-releases.md`](doc/05-versioning-and-releases.md).
   The CI fanout gate catches the most obvious cases; reviewers
   catch the subtler ones.
3. **Tests run, not just compile.** The reviewer runs the change
   for any non-trivial diff; for CDK changes that means `cdk synth`
   on the construct's test stack and inspecting the output. For
   runtime changes it means running the unit suite locally.
4. **No hidden cost.** Default-on paid AWS features require a
   prop-doc cost disclosure per
   [`doc/01-scope-and-philosophy.md § Design principles`](doc/01-scope-and-philosophy.md#design-principles).
5. **Module size justifies itself.** A new module over the
   size budget (per
   [`doc/10-ai-maintained-conventions.md § Module size as a verification budget`](doc/10-ai-maintained-conventions.md#5-module-size-as-a-verification-budget))
   includes a justification in its design doc.

### Declining a PR

A reviewer may decline a PR — not request changes, decline — when:

- The change duplicates an existing OSS solution (`cockatiel`,
  `helmet`, `aws-jwt-verify`, etc.) in violation of the "don't
  reinvent OSS" principle.
- The scope creeps beyond what the spec authorises and no spec
  update is offered.
- The PR's verification cost exceeds its value (small benefit,
  large diff, low test coverage).

Declining is not a failure mode; it is the cost-control on the
reviewer's attention budget. A declined PR can be reopened after
the underlying issue is addressed.

## Security

- Never commit secrets. `.env`, `*.pem`, `credentials*`, anything
  matching `*token*` / `*secret*` / `*key*` is in `.gitignore`.
- Customer/client names do not appear in this repo. It is OSS;
  see the user-global confidentiality rule.
- SSRF defence is default-on in every HTTP fetcher (per
  [`doc/01-scope-and-philosophy.md § Design principles`](doc/01-scope-and-philosophy.md#design-principles)).
  PRs that add an HTTP fetcher without SSRF defence are rejected.

## Local development

```bash
# Setup
nvm use                # Reads .nvmrc → Node 24
npm install            # Installs all workspaces

# Iterate
npm run typecheck      # Project-references build, no emit
npm test               # All workspaces
npm test --workspace @de-otio/foundation  # One workspace
npm run lint           # ESLint across all packages
npm run format         # Prettier write-mode

# Per-package
cd packages/foundation
npm test
npm run build
```

The integration tests (LocalStack, CDK synth-with-real-AWS-context)
live behind separate scripts and do not run on `npm test`. See each
package's README for the integration-test commands.

## When in doubt

The design docs in [`doc/`](doc/) are the source of truth for what
the system does and why. If a question isn't answered in the docs,
the answer is "open a PR that adds the doc, then implement against
it" — not "implement and hope the reviewer accepts it."
